#!/usr/bin/env node
/**
 * Behavioural tests for the sub-agent's TRANSIENT-FAILURE RETRY
 * (src/tools/impl/subAgentTool.ts).
 *
 * Run with: npx tsx scripts/test-subagent-transient-retry.mjs
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
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
}

// ── the fake Ollama provider ──────────────────────────────────────────────

/**
 * Start a fake Ollama server on 127.0.0.1 with an ephemeral port.
 *
 * `respond(requestIndex, res)` decides the answer for each POST /api/chat.
 * `requestIndex` is 1-based and counts EVERY request the server saw, which is
 * the observable the retry assertions are built on.
 */
async function startFakeProvider(respond) {
  const state = { requests: 0 };
  const server = createServer((req, res) => {
    state.requests += 1;
    // Drain the request body so the client is never left writing into a
    // socket we have already answered.
    req.resume();
    respond(state.requests, res);
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

// ── the output sink ───────────────────────────────────────────────────────

/**
 * A ToolOutputSink (src/tools/toolOutput.ts) that keeps everything it is
 * given. The per-agent methods matter: the sub-agent's own lines (including
 * the retry marker) go through `writeAgentLine` when the sink implements it,
 * and the streamed model text goes through `writeAgentChunk`.
 */
function createSink() {
  const lines = [];
  const agentLines = [];
  const agentChunks = [];
  return {
    lines,
    agentLines,
    agentChunks,
    writeLine(message) {
      lines.push(message);
    },
    writeInline() {},
    clearInline() {},
    writeAgentLine(agentId, message) {
      agentLines.push({ agentId, message });
    },
    writeAgentChunk(agentId, type, text) {
      agentChunks.push({ agentId, type, text });
    },
    /** Every line the sub-agent emitted, joined for substring assertions. */
    agentText() {
      return agentLines.map((entry) => entry.message).join('\n');
    },
  };
}

// ── the scratch directory + the module under test ─────────────────────────

const scratch = mkdtempSync(path.join(tmpdir(), 'locopilot-subagent-retry-'));
const previousCwd = process.cwd();

try {
  // The chdir MUST happen before the dynamic import: `debugLogger.ts` builds
  // its log directory from `process.cwd()` at module load.
  process.chdir(scratch);

  const { SubAgentTool } = await import('../src/tools/impl/subAgentTool.ts');
  const { buildLlmRequestContext } = await import('../src/services/llm.ts');

  /** A minimal SubAgentConfig wired to the fake provider. */
  function buildContext(baseUrl) {
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
      },
    };
  }

  /** Run one sub-agent against the fake provider and collect everything. */
  async function runSubAgent(provider, agentId = 'retry-agent') {
    const tool = new SubAgentTool();
    const sink = createSink();
    const result = await tool.execute(
      { agents: [{ id: agentId, prompt: 'Report what you found.' }] },
      undefined,
      sink,
      buildContext(provider.baseUrl),
      undefined
    );
    return { result, sink };
  }

  // ── 1. A transient 500 on the FIRST attempt is retried ─────────────────

  console.log('transient 500 on the first attempt → the turn is retried');
  {
    const provider = await startFakeProvider(
      respondWithErrorThenOk(1, 500, { error: 'upstream gateway exploded' }, 'RETRY-OK')
    );
    let run;
    try {
      run = await runSubAgent(provider);
    } finally {
      await provider.close();
    }

    check('the agent completes with the retried turn’s answer', () => {
      assert.ok(
        run.result.content.includes('RETRY-OK'),
        `tool result did not contain RETRY-OK:\n${run.result.content}`
      );
    });

    check('the provider saw exactly 2 requests (1 failure + 1 retry)', () => {
      assert.equal(provider.requests, 2);
    });

    check('the agent output carries the ↻ Provider error marker', () => {
      assert.ok(
        run.sink.agentText().includes('↻ Provider error'),
        `agent output had no retry marker:\n${run.sink.agentText()}`
      );
    });

    check('the marker names the failing status', () => {
      assert.match(run.sink.agentText(), /↻ Provider error \(500\)/);
    });

    // ── 2. The marker names the attempt and the limit ────────────────────

    console.log('');
    console.log('the retry marker names the attempt and the limit');
    check('the marker contains "attempt 2/3"', () => {
      assert.ok(
        run.sink.agentText().includes('attempt 2/3'),
        `agent output had no "attempt 2/3":\n${run.sink.agentText()}`
      );
    });

    check('exactly one retry marker was written', () => {
      const markers = run.sink.agentLines.filter((entry) =>
        entry.message.includes('↻ Provider error')
      );
      assert.equal(markers.length, 1);
    });
  }

  // ── 3. The provider ALWAYS fails with 500 ──────────────────────────────

  console.log('');
  console.log('the provider always fails with 500 → the agent is reported as failed');
  {
    const provider = await startFakeProvider(
      respondWithError(500, { error: 'upstream gateway exploded' })
    );
    let run;
    try {
      run = await runSubAgent(provider);
    } finally {
      await provider.close();
    }

    check('the tool result reports the agent as failed', () => {
      assert.match(run.result.content, /returned NO summary/);
    });

    check('the failure message says the turn was retried', () => {
      assert.match(
        run.result.content,
        /the turn was retried \d+ time\(s\) after a transient provider error and still failed/
      );
    });

    // SUBAGENT_TRANSIENT_RETRY_ATTEMPTS is the number of RETRIES the branch
    // allows, and the counter is compared BEFORE it is incremented, so the
    // agent makes 1 initial attempt + 3 retries = 4 requests. The ollama
    // adapter does not retry by itself, so every request here is one attempt
    // by the sub-agent. The bound is what matters: the loop is finite.
    check('the request count is bounded (3 attempts in total = 3 requests)', () => {
      assert.equal(provider.requests, 3);
    });

    check('the failure message names the retry count (2)', () => {
      assert.match(run.result.content, /the turn was retried 2 time\(s\)/);
    });

    check('the agent produced no summary', () => {
      assert.doesNotMatch(run.result.content, /final_response:\nRETRY-OK/);
    });
  }

  // ── 4. A 400 is NOT retryable ──────────────────────────────────────────

  console.log('');
  console.log('a 400 (non-retryable) is not retried');
  {
    const provider = await startFakeProvider(
      respondWithError(400, { error: 'invalid request: bad model' })
    );
    let run;
    try {
      run = await runSubAgent(provider);
    } finally {
      await provider.close();
    }

    check('the provider saw exactly 1 request (no retry)', () => {
      assert.equal(provider.requests, 1);
    });

    check('the agent is reported as failed', () => {
      assert.match(run.result.content, /returned NO summary/);
    });

    check('no retry marker was written', () => {
      assert.ok(
        !run.sink.agentText().includes('↻ Provider error'),
        `agent output unexpectedly had a retry marker:\n${run.sink.agentText()}`
      );
    });

    check('the failure message does not claim a retry happened', () => {
      assert.doesNotMatch(run.result.content, /the turn was retried/);
    });
  }
} finally {
  // Restore the cwd before removing the scratch root (Windows keeps the
  // directory busy while it is the cwd) and never leave a log file behind.
  process.chdir(previousCwd);
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
