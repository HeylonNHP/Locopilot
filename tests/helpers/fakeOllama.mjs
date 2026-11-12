/**
 * A fake Ollama server for tests that drive the model-calling parts of the
 * compaction pipeline (summarise, distil, measure) without a network or a model.
 *
 * It is a plain `http.createServer` bound to 127.0.0.1 on an ephemeral port and
 * speaks just enough of `POST /api/chat`:
 *
 * - `stream: true` is answered with NDJSON (one line per chunk, then a final
 *   `done` line that carries the stats);
 * - `stream: false` is answered with one JSON object.
 *
 * Every request is recorded, in arrival order, so a test can assert on what was
 * SENT (system prompt, output limit, messages) as well as on what came back.
 * Any other route is answered with a 404 and recorded in `unexpected`, so a
 * request the test did not plan for fails loudly instead of hanging or passing
 * unnoticed: assert `fake.unexpected` is empty at the end of a test.
 *
 * The reply to each request is decided by `respond(call)`, where `call` is
 * `{ index, kind, body, system, user }` (`index` is 1-based and counts every
 * `/api/chat` request). `respond` returns a reply:
 *
 *   { text, chunks, promptEvalCount, evalCount, evalDurationNs, status, errorBody }
 *
 * - `text`            the whole answer (default `''`, an EMPTY answer);
 * - `chunks`          an array of strings to stream instead of one `text` chunk;
 * - `promptEvalCount` / `evalCount` the stats the provider reports. Leave
 *                     `promptEvalCount` out and the pipeline records no
 *                     calibration sample, which keeps token counts at their
 *                     local estimates;
 * - `status`          an HTTP status (>= 400) to fail the request with.
 *
 * `kind` comes from `classify(body)`; the default calls a request with
 * `num_predict === 1` a `'measure'` request (that is how `measure.ts` asks)
 * and everything else `'other'`. `classifyCompactionRequest` below also tells a
 * distillation request from a summary one.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Classify a compaction request: `'measure'` (one output token), `'distil'`
 * (its system prompt is the tool-output distiller's) or `'summary'`.
 *
 * @param {object} body - the parsed request body.
 * @param {string} distillSystemPrompt - `TOOL_DISTILL_SYSTEM_PROMPT`.
 */
export function classifyCompactionRequest(body, distillSystemPrompt) {
  if (body?.options?.num_predict === 1) return 'measure';
  const system = body?.messages?.find((message) => message.role === 'system');
  return system?.content === distillSystemPrompt ? 'distil' : 'summary';
}

/**
 * Start the fake server.
 *
 * @param {(call: object) => object | Promise<object>} respond
 * @param {{ classify?: (body: object) => string }} [options]
 */
export async function startFakeOllama(respond, options = {}) {
  const classify =
    options.classify ?? ((body) => (body?.options?.num_predict === 1 ? 'measure' : 'other'));
  /** @type {{ index: number, kind: string, body: any }[]} */
  const requests = [];
  /** @type {string[]} */
  const unexpected = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', () => {});
    req.on('end', async () => {
      if (req.method !== 'POST' || req.url !== '/api/chat') {
        unexpected.push(`${req.method} ${req.url}`);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      let body = {};
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      } catch {
        body = {};
      }
      const index = requests.length + 1;
      const kind = classify(body);
      requests.push({ index, kind, body });

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const user = messages.findLast((message) => message.role === 'user')?.content ?? '';

      let reply;
      try {
        reply = (await respond({ index, kind, body, system, user })) ?? {};
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `fake provider threw: ${String(err)}` }));
        return;
      }

      if (typeof reply.status === 'number' && reply.status >= 400) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: reply.errorBody ?? 'scripted failure' }));
        return;
      }

      const text = reply.text ?? '';
      const parts = reply.chunks ?? [text];
      const stats = {
        ...(reply.promptEvalCount === undefined
          ? {}
          : { prompt_eval_count: reply.promptEvalCount }),
        ...(reply.promptEvalCount === undefined && reply.evalCount === undefined
          ? {}
          : { eval_count: reply.evalCount ?? Math.max(1, Math.ceil(text.length / 4)) }),
        ...(reply.evalDurationNs === undefined ? {} : { eval_duration: reply.evalDurationNs }),
      };

      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (const part of parts) {
          res.write(
            `${JSON.stringify({ message: { role: 'assistant', content: part }, done: false })}\n`
          );
        }
        res.end(
          `${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, ...stats })}\n`
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        `${JSON.stringify({
          message: { role: 'assistant', content: parts.join('') },
          done: true,
          ...stats,
        })}\n`
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    unexpected,
    /** Requests of one kind, in arrival order. */
    ofKind: (kind) => requests.filter((request) => request.kind === kind),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Enter a scratch directory as the working directory.
 *
 * `src/app/lib/debugLogger.ts` builds its log directory from `process.cwd()`
 * at module load, so a test that imports compaction code and does not want its
 * `logs/` output in the repository must call this BEFORE the dynamic import.
 *
 * @param {string} prefix
 * @returns {{ dir: string, leave: () => void }} `leave` restores the previous
 *   working directory and removes the scratch directory.
 */
export function enterScratchCwd(prefix) {
  const previous = process.cwd();
  const dir = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  process.chdir(dir);
  return {
    dir,
    leave() {
      process.chdir(previous);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
