/**
 * Behavioural tests for the sub-agent's TRANSIENT-FAILURE RETRY
 * (src/tools/impl/subAgentTool.ts).
 *
 * WHAT IS UNDER TEST. The sub-agent's own LLM turn has a third catch branch,
 * after the abort check and after the reactive context-limit branch: a
 * provider failure that the shared classifier (src/services/retryable.ts)
 * calls TRANSIENT — a gateway 500 — does NOT kill the agent. The turn is
 * re-issued from the top of the loop (nothing was appended to `messages` on
 * the failed attempt, so the retry cannot break the assistant/tool_call
 * ordering contract), with an exponential backoff that an abort can cut
 * short. A NON-transient failure — a 400 — is not retried at all.
 *
 * NO NETWORK EGRESS. The sub-agent's LLM call goes through the OLLAMA adapter
 * (`provider: 'ollama'`), which POSTs `${baseUrl}/api/chat` and streams NDJSON.
 * The fake provider below is a plain `http.createServer` bound to 127.0.0.1 on
 * an ephemeral port. The ollama adapter has NO retry layer of its own, so a
 * 500 reaches the new branch on the very first attempt and the number of
 * requests the server sees IS the number of attempts the agent made.
 *
 * ISOLATION. The scratch directory is entered with `process.chdir` BEFORE the
 * dynamic import, because `src/app/lib/debugLogger.ts` resolves its log
 * directory from `process.cwd()` at module load. The scratch directory is
 * removed in a `finally`, so a failing assertion cannot leave a log file
 * behind.
 *
 * NOTE ON RUNTIME. The backoff is real (1s, 2s, 4s), so the "always fails"
 * scenario alone waits ~7 seconds.
 *
 * THE FAILED ATTEMPT'S STREAMED OUTPUT IS DROPPED. A turn that fails after
 * it has already streamed leaves text behind: the chunks are in the agent's
 * bubble and in the persisted `subagent_log` row. The re-issued turn streams
 * that text again, so the transcript showed it TWICE
 * ("PARTIAL-ANSWER PARTIAL-ANSWER FULL-ANSWER"). The tool therefore asks
 * the sink to drop that agent's output (`clearAgentContent`) BEFORE it
 * writes the `↻ Provider error` marker — the marker has to survive the
 * clear, because it is the only trace the user gets of WHY the turn is
 * being re-issued.
 *
 * THE DROP IS A TRUNCATION, NOT A DELETE. A sub-agent is a MULTI-TURN loop:
 * only the turn that is being re-issued streams its text again, never the
 * text of the turns that came before it. So `clearAgentContent` drops the
 * last `dropChars` characters of the agent's text — exactly the characters
 * the failed turn wrote — and the earlier turns' text survives. The sink
 * below implements that contract, and the multi-turn case pins it: the
 * first turn's text is still in the agent's bubble after the second turn
 * was re-issued.
 *
 * A CLEAR THAT DROPS NOTHING IS NEVER REQUESTED. When the failure arrives
 * before the turn streamed a single character there is nothing to drop,
 * and a clear that drops nothing still rewrites the agent's bubble with the
 * server's copy of it — so the tool does not ask for one at all. The
 * multi-turn case where the SECOND turn dies on a gateway 500 pins that:
 * the first turn's text is left exactly as it was.
 *
 * THE CONTEXT-LIMIT RE-ISSUE PATH CLEARS TOO. A provider 400 that names the
 * real context cap makes the sub-agent compact its history and re-issue the
 * SAME turn — the very same duplication the transient branch had. The branch
 * is reached here (the fake provider answers with such a 400), and the
 * re-issue happens; the clear it asks for is a no-op, because a 400 is
 * delivered before the stream opens, so the failed attempt streamed nothing.
 *
 * THE AGENT IDS ARE CANONICALISED. The chat route files every write for one
 * sub-agent under ONE key (one bucket, one client bubble, one persisted
 * `subagent_log` row), and it derives that key with `canonicalSubagentId`.
 * Two ids that canonicalise alike ("research" and " research ") would merge
 * into one bucket — and one agent's clear would truncate the other's text —
 * so the id is canonicalised ONCE, at the source, and a batch that contains
 * two such ids is REJECTED instead of being silently merged.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// the fake Ollama provider

/**
 * Start a fake Ollama server on 127.0.0.1 with an ephemeral port.
 *
 * `respond(requestIndex, res, body)` decides the answer for each POST
 * /api/chat. `requestIndex` is 1-based and counts EVERY request the server
 * saw, which is the observable the retry assertions are built on. `body` is
 * the parsed request payload — the agent's turns carry the tool list, the
 * compaction's own summariser requests do not, so the two can be told apart.
 */
async function startFakeProvider(respond) {
  const state = { requests: 0 };
  const server = createServer((req, res) => {
    state.requests += 1;
    // The body is read before the answer is written, so a responder can
    // look at what was asked for.
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', () => {});
    req.on('end', () => {
      let body = {};
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      } catch {
        body = {};
      }
      respond(state.requests, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get requests() {
      return state.requests;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Answer every chat request with an HTTP error status and a JSON body. */
function respondWithError(status, body) {
  return (_index, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

/**
 * Answer every chat request with the NDJSON stream the ollama adapter parses.
 * The reply carries NO tool_calls, so the agent ends its turn immediately.
 */
function respondWithOk(content) {
  return (_index, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n`);
    res.write(`${JSON.stringify({ done: true })}\n`);
    res.end();
  };
}

/** Answer the first `failures` requests with an error, then succeed. */
function respondWithErrorThenOk(failures, status, body, content) {
  const ok = respondWithOk(content);
  const error = respondWithError(status, body);
  return (index, res) => {
    if (index <= failures) {
      error(index, res);
      return;
    }
    ok(index, res);
  };
}

/**
 * Answer the first request with a PARTIAL stream and then kill the socket
 * mid-stream; every later request succeeds with `contents`.
 *
 * WHY THIS SHAPE. A gateway 500 arrives BEFORE any chunk, so it never
 * leaves text behind — but a connection that dies mid-stream does, and that
 * is exactly the case the clear exists for: the failed attempt's text is
 * already in the agent's bubble when the turn is re-issued. The shared
 * classifier (src/services/retryable.ts) sees the dead socket as a transient
 * network failure (ECONNRESET), so the turn IS re-issued.
 */
function respondWithPartialThenDie(partial, contents) {
  return (index, res) => {
    if (index === 1) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({ message: { role: 'assistant', content: partial }, done: false })}\n`
      );
      // The socket error is handled by the server itself; this listener only
      // keeps it from becoming an unhandled 'error' event.
      res.on('error', () => {});
      // Give the client a moment to read the line before the socket dies, so
      // the failed attempt really did stream — and really did leave text
      // behind in the agent's bubble.
      setTimeout(() => {
        res.socket?.destroy();
      }, 50);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const content of contents) {
      res.write(`${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n`);
    }
    res.write(`${JSON.stringify({ done: true })}\n`);
    res.end();
  };
}

/**
 * Answer a MULTI-TURN run:
 *
 *   request 1 — the agent's FIRST turn: it streams text and asks for a tool,
 *   request 2 — the agent's SECOND turn: it streams text and then the socket
 *               dies mid-stream (a transient failure), so the turn is
 *               re-issued,
 *   request 3 — the re-issued turn: it streams the same text again and then
 *               finishes the agent.
 *
 * The tool the first turn asks for is NOT in the registry, so the agent gets
 * an "[Unknown tool: …]" result and loops — which is all a multi-turn run
 * needs, and it keeps the test free of side effects.
 */
function respondWithMultiTurn({ firstTurnText, failedTurnText, finalTexts }) {
  return (index, res) => {
    if (index === 1) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({
          message: {
            role: 'assistant',
            content: firstTurnText,
            tool_calls: [{ id: 'call_1', function: { name: 'noop_tool', arguments: {} } }],
          },
          done: false,
        })}\n`
      );
      res.write(`${JSON.stringify({ done: true })}\n`);
      res.end();
      return;
    }
    if (index === 2) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({ message: { role: 'assistant', content: failedTurnText }, done: false })}\n`
      );
      res.on('error', () => {});
      setTimeout(() => {
        res.socket?.destroy();
      }, 50);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const content of finalTexts) {
      res.write(`${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n`);
    }
    res.write(`${JSON.stringify({ done: true })}\n`);
    res.end();
  };
}

/**
 * Answer a MULTI-TURN run whose SECOND turn fails with a gateway 500 BEFORE
 * it streamed anything:
 *
 *   request 1 — the agent's FIRST turn: it streams text and asks for a tool,
 *   request 2 — the agent's SECOND turn: the provider answers with a 500 (a
 *               gateway error arrives before any chunk), so the turn is
 *               re-issued,
 *   request 3 — the re-issued turn: it streams the text and finishes.
 *
 * WHY THIS SHAPE. The failed attempt streamed NOTHING, so there is nothing
 * to drop: the tool must not even ask the sink to clear, because a clear
 * that drops nothing still rewrites the agent's bubble with the server's
 * copy of it.
 */
function respondWithMultiTurnWhereSecondTurnFails({ firstTurnText, finalTexts }) {
  return (index, res) => {
    if (index === 1) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({
          message: {
            role: 'assistant',
            content: firstTurnText,
            tool_calls: [{ id: 'call_1', function: { name: 'noop_tool', arguments: {} } }],
          },
          done: false,
        })}\n`
      );
      res.write(`${JSON.stringify({ done: true })}\n`);
      res.end();
      return;
    }
    if (index === 2) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream gateway exploded' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const content of finalTexts) {
      res.write(`${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n`);
    }
    res.write(`${JSON.stringify({ done: true })}\n`);
    res.end();
  };
}

/**
 * Answer a MULTI-TURN run whose SECOND turn is rejected with a 400 that
 * names the REAL context cap — the reactive context-limit path:
 *
 *   request 1 — the agent's FIRST turn: it streams text and asks for a tool,
 *   request 2 — the agent's SECOND turn: a 400 naming the cap, so the
 *               sub-agent compacts its history and RE-ISSUES the same turn,
 *   request N — the compaction's own summariser requests (they carry no
 *               tool list, unlike the agent's turns),
 *   request M — the re-issued turn: it streams the text and finishes.
 *
 * The agent's turns are told apart from the summariser's by the tool list:
 * the agent's request carries `tools`, the summariser's never does.
 */
function respondWithContextLimitRejection({ firstTurnText, finalTexts }) {
  let agentTurns = 0;
  return (_index, res, body) => {
    const isAgentTurn = Boolean(body && Array.isArray(body.tools));
    if (!isAgentTurn) {
      // The compaction's summariser request.
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({
          message: { role: 'assistant', content: 'SUMMARY OF THE EARLIER WORK' },
          done: false,
        })}\n`
      );
      res.write(`${JSON.stringify({ done: true })}\n`);
      res.end();
      return;
    }
    agentTurns += 1;
    if (agentTurns === 1) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({
          message: {
            role: 'assistant',
            content: firstTurnText,
            tool_calls: [{ id: 'call_1', function: { name: 'noop_tool', arguments: {} } }],
          },
          done: false,
        })}\n`
      );
      res.write(`${JSON.stringify({ done: true })}\n`);
      res.end();
      return;
    }
    if (agentTurns === 2) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'maximum context length is 4096 tokens' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const content of finalTexts) {
      res.write(`${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n`);
    }
    res.write(`${JSON.stringify({ done: true })}\n`);
    res.end();
  };
}

// the output sink

/**
 * A ToolOutputSink (src/tools/toolOutput.ts) that keeps everything it is
 * given. The per-agent methods matter: the sub-agent's own lines (including
 * the retry marker) go through `writeAgentLine` when the sink implements it,
 * and the streamed model text goes through `writeAgentChunk`.
 *
 * `clearAgentContent` is the sink's own "drop what you already showed for
 * this agent": the chat route implements it by truncating the agent's bubble
 * and the persisted `subagent_log` text. Here it drops the LAST `dropChars`
 * characters of the agent's text — exactly the characters the turn that is
 * being re-issued wrote — so the text of the agent's EARLIER turns (a
 * sub-agent is a multi-turn loop) survives. `liveText()` is what the agent's
 * bubble would show.
 *
 * `events` is the ORDERED log of every sink call. It is what pins the
 * ordering contract: the clear has to come BEFORE the re-issued turn's
 * chunks and BEFORE the `↻ Provider error` marker.
 */
function createSink(options = {}) {
  const lines = [];
  const agentLines = [];
  const agentChunks = [];
  const events = [];
  /**
   * The text that SURVIVES per agent — the agent's bubble, with every clear
   * applied. A clear TRUNCATES it (drops the last `dropChars` characters).
   */
  const liveByAgent = new Map();
  /**
   * `canClear: false` builds a sink WITHOUT `clearAgentContent` — a sink
   * that streams chunks but cannot drop them again. The tool has to say so
   * in the log instead of silently re-duplicating the text.
   */
  const canClear = options.canClear !== false;
  const sink = {
    lines,
    agentLines,
    agentChunks,
    events,
    writeLine(message) {
      lines.push(message);
      events.push({ kind: 'line', message });
    },
    writeInline() {},
    clearInline() {},
    writeAgentLine(agentId, message) {
      agentLines.push({ agentId, message });
      events.push({ kind: 'agentLine', agentId, message });
    },
    writeAgentChunk(agentId, type, text) {
      const chunk = { agentId, type, text };
      agentChunks.push(chunk);
      liveByAgent.set(agentId, (liveByAgent.get(agentId) ?? '') + text);
      events.push({ kind: 'chunk', agentId, type, text });
    },
    /** The text the agent's bubble would show: the chunks, clears applied. */
    liveText(agentId) {
      return liveByAgent.get(agentId) ?? '';
    },
    /** Every line the sub-agent emitted, joined for substring assertions. */
    agentText() {
      return agentLines.map((entry) => entry.message).join('\n');
    },
  };
  if (canClear) {
    sink.clearAgentContent = (agentId, dropChars) => {
      events.push({ kind: 'clear', agentId, dropChars });
      const current = liveByAgent.get(agentId) ?? '';
      const drop =
        typeof dropChars === 'number' && Number.isFinite(dropChars) ? Math.max(0, dropChars) : 0;
      liveByAgent.set(agentId, current.slice(0, Math.max(0, current.length - drop)));
    };
  }
  return sink;
}

const scratch = mkdtempSync(path.join(tmpdir(), 'locopilot-subagent-retry-'));
const previousCwd = process.cwd();
let SubAgentTool, buildLlmRequestContext, canonicalSubagentId;

// The chdir MUST happen before the dynamic import: `debugLogger.ts` builds its log
// directory from `process.cwd()` at module load.
beforeAll(async () => {
  // The chdir MUST happen before the dynamic import: `debugLogger.ts` builds
  // its log directory from `process.cwd()` at module load.
  process.chdir(scratch);
  ({ SubAgentTool } = await import('../src/tools/impl/subAgentTool.ts'));
  ({ buildLlmRequestContext } = await import('../src/services/llm.ts'));
  ({ canonicalSubagentId } = await import('../src/tools/toolOutput.ts'));
});

afterAll(() => {
  // Restore the cwd before removing the scratch root (Windows keeps the
  // directory busy while it is the cwd) and never leave a log file behind.
  process.chdir(previousCwd);
  rmSync(scratch, { recursive: true, force: true });
});

describe('the sub-agent transient-failure retry', () => {
  /** A minimal SubAgentConfig wired to the fake provider. */
  function buildContext(baseUrl, overrides = {}) {
    return {
      yoloMode: true,
      webSearch: { enabled: false, max_results: 1, max_context_length: 1 },
      subAgent: {
        provider: 'ollama',
        baseUrl,
        model: 'fake-ollama-model',
        numCtx: 8192,
        compactionModel: 'fake-ollama-model',
        compactionLlmRequestContext: buildLlmRequestContext({ provider: 'ollama', baseUrl }),
        // The tool refuses to run with an empty tool list, and the fake model
        // never calls a tool anyway.
        tools: [
          {
            type: 'function',
            function: {
              name: 'noop_tool',
              description: 'A tool the fake model never calls.',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        ...overrides,
      },
    };
  }

  /**
   * Run one sub-agent against the fake provider and collect everything.
   *
   * `options.agents` replaces the whole batch (so a batch can be rejected),
   * `options.prompt` replaces the agent's task, and `options.subAgent`
   * patches the sub-agent config (the steering hook, for instance).
   */
  async function runSubAgent(provider, agentId = 'retry-agent', options = {}) {
    const tool = new SubAgentTool();
    const sink = createSink(options.sink ?? {});
    const agents = options.agents ?? [
      { id: agentId, prompt: options.prompt ?? 'Report what you found.' },
    ];
    const result = await tool.execute(
      { agents },
      undefined,
      sink,
      buildContext(provider.baseUrl, options.subAgent ?? {}),
      undefined
    );
    return { result, sink };
  }

  describe('transient 500 on the first attempt → the turn is retried', () => {
    let provider, run;

    beforeAll(async () => {
      provider = await startFakeProvider(
        respondWithErrorThenOk(1, 500, { error: 'upstream gateway exploded' }, 'RETRY-OK')
      );

      try {
        run = await runSubAgent(provider);
      } finally {
        await provider.close();
      }
    });

    test('the agent completes with the retried turn’s answer', () => {
      expect(run.result.content).toContain('RETRY-OK');
    });

    test('the provider saw exactly 2 requests (1 failure + 1 retry)', () => {
      expect(provider.requests).toBe(2);
    });

    test('the agent output carries the ↻ Provider error marker', () => {
      expect(run.sink.agentText()).toContain('↻ Provider error');
    });

    test('the marker names the failing status', () => {
      expect(run.sink.agentText()).toMatch(/↻ Provider error \(500\)/);
    });

    test('the marker contains "attempt 2/3"', () => {
      expect(run.sink.agentText()).toContain('attempt 2/3');
    });

    test('exactly one retry marker was written', () => {
      const markers = run.sink.agentLines.filter((entry) =>
        entry.message.includes('↻ Provider error')
      );
      expect(markers).toHaveLength(1);
    });
  });

  describe('the provider always fails with 500 → the agent is reported as failed', () => {
    let provider, run;

    beforeAll(async () => {
      provider = await startFakeProvider(
        respondWithError(500, { error: 'upstream gateway exploded' })
      );

      try {
        run = await runSubAgent(provider);
      } finally {
        await provider.close();
      }
    });

    test('the tool result reports the agent as failed', () => {
      expect(run.result.content).toMatch(/returned NO summary/);
    });

    test('the failure message says the turn was retried', () => {
      expect(run.result.content).toMatch(
        /the turn was retried \d+ time\(s\) after a transient provider error and still failed/
      );
    });

    // SUBAGENT_TRANSIENT_RETRY_ATTEMPTS is the number of RETRIES the branch
    // allows, and the counter is compared BEFORE it is incremented, so the
    // agent makes 1 initial attempt + 3 retries = 4 requests. The ollama
    // adapter does not retry by itself, so every request here is one attempt
    // by the sub-agent. The bound is what matters: the loop is finite.
    test('the request count is bounded (3 attempts in total = 3 requests)', () => {
      expect(provider.requests).toBe(3);
    });

    test('the failure message names the retry count (2)', () => {
      expect(run.result.content).toMatch(/the turn was retried 2 time\(s\)/);
    });

    test('the agent produced no summary', () => {
      expect(run.result.content).not.toMatch(/final_response:\nRETRY-OK/);
    });
  });

  describe('a 400 (non-retryable) is not retried', () => {
    let provider, run;

    beforeAll(async () => {
      provider = await startFakeProvider(
        respondWithError(400, { error: 'invalid request: bad model' })
      );

      try {
        run = await runSubAgent(provider);
      } finally {
        await provider.close();
      }
    });

    test('the provider saw exactly 1 request (no retry)', () => {
      expect(provider.requests).toBe(1);
    });

    test('the agent is reported as failed', () => {
      expect(run.result.content).toMatch(/returned NO summary/);
    });

    test('no retry marker was written', () => {
      expect(run.sink.agentText()).not.toContain('↻ Provider error');
    });

    test('the failure message does not claim a retry happened', () => {
      expect(run.result.content).not.toMatch(/the turn was retried/);
    });
  });

  describe('the failed attempt’s streamed output is dropped before the turn is re-issued', () => {
    let provider, run, clears, clearIndex;

    beforeAll(async () => {
      provider = await startFakeProvider(
        respondWithPartialThenDie('PARTIAL-ANSWER', ['FULL-ANSWER'])
      );

      try {
        run = await runSubAgent(provider);
      } finally {
        await provider.close();
      }

      clears = run.sink.events.filter((event) => event.kind === 'clear');

      clearIndex = run.sink.events.indexOf(clears[0]);
    });

    test('the mid-stream failure re-issued the turn (1 failure + 1 retry)', () => {
      expect(provider.requests).toBe(2);
    });

    test('exactly one clear was requested', () => {
      expect(clears).toHaveLength(1);
    });

    test('the clear was requested for the failed agent', () => {
      expect(clears[0].agentId).toBe('retry-agent');
    });

    test('the failed attempt had already streamed before the clear', () => {
      const firstChunk = run.sink.events.findIndex((event) => event.kind === 'chunk');
      expect(firstChunk).not.toBe(-1);
      expect(firstChunk).toBeLessThan(clearIndex);
    });

    test('the clear came BEFORE the re-issued turn’s chunks', () => {
      const firstChunkAfterClear = run.sink.events.findIndex(
        (event, index) => index > clearIndex && event.kind === 'chunk'
      );
      expect(firstChunkAfterClear).toBeGreaterThan(clearIndex);
    });

    test('the failed attempt’s text is not in the agent’s bubble any more', () => {
      expect(run.sink.liveText('retry-agent')).not.toContain('PARTIAL-ANSWER');
    });

    test('the re-issued turn’s text is in the bubble exactly once', () => {
      const live = run.sink.liveText('retry-agent');
      expect(live.split('FULL-ANSWER').length - 1).toBe(1);
    });

    test('the ↻ Provider error marker was written AFTER the clear', () => {
      const markerIndex = run.sink.events.findIndex(
        (event) => event.kind === 'agentLine' && event.message.includes('↻ Provider error')
      );
      expect(markerIndex).not.toBe(-1);
      expect(markerIndex).toBeGreaterThan(clearIndex);
    });

    test('the marker is still in the agent’s output', () => {
      expect(run.sink.agentText()).toContain('↻ Provider error');
    });
  });

  describe('the text the re-issued turn re-streams is not shown twice', () => {
    let run;

    beforeAll(async () => {
      const provider = await startFakeProvider(
        respondWithPartialThenDie('PARTIAL-ANSWER', ['PARTIAL-ANSWER', ' FULL-ANSWER'])
      );

      try {
        run = await runSubAgent(provider);
      } finally {
        await provider.close();
      }
    });

    test('the re-streamed text appears exactly once in the agent’s bubble', () => {
      const live = run.sink.liveText('retry-agent');
      expect(live.split('PARTIAL-ANSWER').length - 1).toBe(1);
    });

    test('the bubble holds the re-issued turn’s text only', () => {
      expect(run.sink.liveText('retry-agent').trim()).toBe('PARTIAL-ANSWER FULL-ANSWER');
    });

    test('the failed attempt’s chunk did not survive the clear', () => {
      const clearIndex = run.sink.events.findIndex((event) => event.kind === 'clear');
      const surviving = run.sink.events.filter(
        (event, index) => event.kind === 'chunk' && index > clearIndex
      );
      expect(surviving.filter((event) => event.text === 'PARTIAL-ANSWER')).toHaveLength(1);
    });

    test('the clear dropped exactly the characters the failed turn wrote', () => {
      // The drop is a TRUNCATION: the count is the number of characters the
      // failed turn streamed, so the agent's earlier turns keep their text.
      const clear = run.sink.events.find((event) => event.kind === 'clear');
      expect(clear.dropChars).toBe('PARTIAL-ANSWER'.length);
    });
  });

  describe('a multi-turn agent keeps the text of its earlier turns', () => {
    let provider, run, clears, clearIndex, live;

    beforeAll(async () => {
      provider = await startFakeProvider(
        respondWithMultiTurn({
          firstTurnText: 'TURN-ONE-TEXT',
          failedTurnText: 'TURN-TWO-TEXT',
          finalTexts: ['TURN-TWO-TEXT', ' ALL-DONE'],
        })
      );

      try {
        run = await runSubAgent(provider);
      } finally {
        await provider.close();
      }

      clears = run.sink.events.filter((event) => event.kind === 'clear');

      clearIndex = run.sink.events.indexOf(clears[0]);

      live = run.sink.liveText('retry-agent');
    });

    test('the agent made three requests (turn 1, the failed turn 2, its re-issue)', () => {
      expect(provider.requests).toBe(3);
    });

    test('exactly one clear was requested', () => {
      expect(clears).toHaveLength(1);
    });

    test('the clear dropped exactly the failed turn’s text', () => {
      // The failed turn streamed 'TURN-TWO-TEXT' and nothing else, so the
      // drop is exactly that many characters.
      expect(clears[0].dropChars).toBe('TURN-TWO-TEXT'.length);
    });

    test('the clear came AFTER the first turn’s chunk', () => {
      const firstChunk = run.sink.events.findIndex((event) => event.kind === 'chunk');
      expect(firstChunk).not.toBe(-1);
      expect(firstChunk).toBeLessThan(clearIndex);
    });

    test('the first turn’s text SURVIVED the clear', () => {
      // A sub-agent is a multi-turn loop: only the re-issued turn streams
      // its text again, so the earlier turns' text has to stay.
      expect(live).toContain('TURN-ONE-TEXT');
    });

    test('the failed attempt’s text is in the agent’s bubble exactly once', () => {
      expect(live.split('TURN-TWO-TEXT').length - 1).toBe(1);
    });

    test('the agent finished with the re-issued turn’s answer', () => {
      expect(run.result.content).toContain('TURN-TWO-TEXT ALL-DONE');
    });

    test('the ↻ Provider error marker was written for the failed turn', () => {
      expect(run.sink.agentText()).toContain('↻ Provider error');
    });
  });

  describe('a failure before the turn streamed anything → nothing is cleared', () => {
    let provider, run, clears, live;

    beforeAll(async () => {
      provider = await startFakeProvider(
        respondWithMultiTurnWhereSecondTurnFails({
          firstTurnText: 'TURN-ONE-TEXT',
          finalTexts: ['TURN-TWO-TEXT'],
        })
      );

      try {
        run = await runSubAgent(provider);
      } finally {
        await provider.close();
      }

      clears = run.sink.events.filter((event) => event.kind === 'clear');

      live = run.sink.liveText('retry-agent');
    });

    test('the failed turn was re-issued (turn 1, the failed turn 2, its re-issue)', () => {
      expect(provider.requests).toBe(3);
    });

    test('NO clear was requested (the failed turn streamed nothing)', () => {
      // A clear that drops NOTHING still rewrites the agent's bubble with the
      // server's copy of it, so there must not be one at all: the tool has
      // nothing to drop and does not ask.
      expect(clears).toHaveLength(0);
    });

    test('the first turn’s text is untouched', () => {
      expect(live).toContain('TURN-ONE-TEXT');
    });

    test('the re-issued turn’s text is in the bubble exactly once', () => {
      expect(live.split('TURN-TWO-TEXT').length - 1).toBe(1);
    });

    test('the ↻ Provider error marker was written', () => {
      expect(run.sink.agentText()).toContain('↻ Provider error');
    });
  });

  describe('the context-limit re-issue path re-issues the turn (and clears it)', () => {
    let provider, run, clears, live;

    beforeAll(async () => {
      // The reactive context-limit path needs a provider 400 that names the
      // real context cap. The sub-agent then compacts its history and
      // re-issues the SAME turn — the same duplication bug the transient
      // branch had, so the branch has to drop the failed attempt's output
      // too.
      //
      // A steering message is queued for the agent: the compaction refuses to
      // summarise a history whose only user message is the agent's own task
      // (that message is the anchor and is never summarised), so without a
      // second user message there is nothing to compact and the re-issue
      // never happens.
      let steerAppended = false;

      provider = await startFakeProvider(
        respondWithContextLimitRejection({
          firstTurnText: 'TURN-ONE-TEXT',
          finalTexts: ['TURN-TWO-TEXT'],
        })
      );

      try {
        run = await runSubAgent(provider, 'retry-agent', {
          prompt: `Investigate the incident.\n${'A detailed line about the failing subsystem. '.repeat(60)}`,
          subAgent: {
            applySteerMessages: async (messages) => {
              if (steerAppended) {
                return;
              }
              steerAppended = true;
              messages.push({
                role: 'user',
                content: 'Also double-check the numbers before you finish.',
              });
            },
          },
        });
      } finally {
        await provider.close();
      }

      clears = run.sink.events.filter((event) => event.kind === 'clear');

      live = run.sink.liveText('retry-agent');
    });

    test('the context-limit rejection was recognised', () => {
      expect(run.sink.agentText()).toContain('Provider rejected the request for context length');
    });

    test('the turn was re-issued on the compacted history', () => {
      expect(run.sink.agentText()).toContain('↻ Retrying this turn on the compacted history.');
    });

    test('the re-issued turn’s text is in the bubble exactly once', () => {
      expect(live.split('TURN-TWO-TEXT').length - 1).toBe(1);
    });

    test('no clear was requested (the 400 arrived before any chunk)', () => {
      // A provider 400 is delivered before the stream opens, so the failed
      // attempt streamed NOTHING and there is nothing to drop: the branch
      // must not ask the sink to clear. (This is why the clear in this path
      // cannot be observed with a non-zero drop.)
      expect(clears).toHaveLength(0);
    });
  });

  describe('the canonical agent id', () => {
    test('surrounding whitespace is dropped', () => {
      expect(canonicalSubagentId(' research ')).toBe('research');
    });

    test('an empty id falls back to the shared bucket', () => {
      expect(canonicalSubagentId('   ')).toBe('__subagent__');
    });

    test('the canonicalisation is idempotent', () => {
      expect(canonicalSubagentId(canonicalSubagentId(' research '))).toBe('research');
    });

    test('a control sequence cannot split one id into two', () => {
      expect(canonicalSubagentId('re\u001B[31msearch')).toBe('research');
    });
  });

  describe('the agent ids are canonicalised in everything the sink receives', () => {
    let run, clears;

    beforeAll(async () => {
      // The agent's turn dies mid-stream, so the tool writes a chunk, a line
      // (the retry marker) AND a clear — every one of them carries the agent
      // id, and all of them have to carry the CANONICAL one.
      const provider = await startFakeProvider(
        respondWithPartialThenDie('PARTIAL-ANSWER', ['FULL-ANSWER'])
      );

      try {
        run = await runSubAgent(provider, ' research ');
      } finally {
        await provider.close();
      }

      clears = run.sink.events.filter((event) => event.kind === 'clear');
    });

    test('the chunks are filed under the canonical id', () => {
      expect(run.sink.agentChunks.length).toBeGreaterThan(0);
      for (const chunk of run.sink.agentChunks) {
        expect(chunk.agentId).toBe('research');
      }
    });

    test('the agent’s lines are filed under the canonical id', () => {
      expect(run.sink.agentLines.length).toBeGreaterThan(0);
      for (const entry of run.sink.agentLines) {
        expect(entry.agentId).toBe('research');
      }
    });

    test('the clear is filed under the canonical id', () => {
      expect(clears).toHaveLength(1);
      expect(clears[0].agentId).toBe('research');
    });

    test('the parent’s report shows the canonical id', () => {
      expect(run.result.content).toContain('sub_agent: research');
    });
  });

  describe('a batch whose agent ids collide is rejected', () => {
    let provider, run;

    beforeAll(async () => {
      provider = await startFakeProvider(respondWithOk('NEVER-RUN'));

      try {
        run = await runSubAgent(provider, 'retry-agent', {
          agents: [
            { id: 'research', prompt: 'Look into the first thing.' },
            { id: ' research ', prompt: 'Look into the second thing.' },
          ],
        });
      } finally {
        await provider.close();
      }
    });

    test('a batch with two ids that canonicalise alike is rejected', () => {
      expect(run.result.content).toMatch(
        /\[Error: invalid agent at index 1 \(duplicate agent id "research"/
      );
    });

    test('the error names the index of the first colliding agent', () => {
      expect(run.result.content).toMatch(/collides with the agent at index 0/);
    });

    test('no agent ran at all', () => {
      expect(provider.requests).toBe(0);
    });
  });

  describe('a sink that streams chunks but cannot clear them is logged', () => {
    let run, log;

    beforeAll(async () => {
      const provider = await startFakeProvider(
        respondWithPartialThenDie('PARTIAL-ANSWER', ['FULL-ANSWER'])
      );

      try {
        run = await runSubAgent(provider, 'retry-agent', { sink: { canClear: false } });
      } finally {
        await provider.close();
      }

      // The logger writes asynchronously (pino → a file destination), so give
      // it a moment to land before the log is read.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const logPath = path.join(scratch, 'logs', 'locopilot-debug.log');

      log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    });

    test('the agent still finished (the sink just cannot clear)', () => {
      expect(run.result.content).toContain('FULL-ANSWER');
    });

    test('no clear was requested (the sink cannot clear)', () => {
      expect(run.sink.events.filter((event) => event.kind === 'clear')).toHaveLength(0);
    });

    test('the situation was written to the diagnostic log', () => {
      expect(log).toContain('clear_unsupported');
    });

    test('the diagnostic names the phase that wanted to clear', () => {
      expect(log).toContain('transient_retry');
    });
  });
});
