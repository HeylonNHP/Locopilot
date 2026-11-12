/**
 * Characterisation of the tool-output distillation PASS (`distillToolMessages`
 * in src/services/compact/distill.ts), driven against a fake Ollama server.
 *
 * WHY this file exists: the pass was covered for failure (`compact-budget`,
 * against a refused connection) and for tool names (`compact-distill-tool-name`),
 * but nothing pinned what it SENDS, what it builds from the answers, the order
 * of its progress lines or its calibration sample. The refactor in
 * docs/COMPACTION_REFACTOR_PLAN.md splits the pass into a pure core and an IO
 * shell; this file records what it does today.
 *
 * Scenarios (each asserts something only its branch produces; the request
 * transcript, the progress lines, the counters and the shape of every returned
 * message are also compared with tests/fixtures/compact-distill-shell.golden.json,
 * regenerated with LOCOPILOT_TEST_WRITE_GOLDEN=1):
 *
 * - a mixed pass: one call succeeds (and reports `prompt_eval_count`, so a
 *   calibration sample is recorded), one fails with a 500 (the output stays
 *   verbatim and the pass goes on), one returns an EMPTY digest (the original
 *   output, cut with the marker, stands in for it);
 * - an input larger than the window's cap, which is cut and says so in the
 *   request header AND in the digest wrapper;
 * - a prefill budget that pays for one call only.
 *
 * The last test pins the invariant the removal of the token-count fallback in
 * the refactor relies on: a distillation request never gets near the
 * ~524,288-character size at which tiktoken's WASM counter is reported to fail.
 *
 * No network, no model.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

import { createGoldenFile, describeRequests, runScenario } from './helpers/compactionHarness.mjs';
import { enterScratchCwd } from './helpers/fakeOllama.mjs';

const MODEL = 'test-model';
const goldenFile = createGoldenFile(
  new URL('fixtures/compact-distill-shell.golden.json', import.meta.url)
);

let scratch;
let distillToolMessages;
let TOOL_DISTILL_SYSTEM_PROMPT;
let TOOL_DISTILL_TRUNCATION_MARKER;
let computeDistillNumPredict;
let computeDistillInputMaxChars;
let countRawMessagesTokens;
let getTokenCalibration;
let resetTokenCalibration;

beforeAll(async () => {
  scratch = enterScratchCwd('locopilot-distill-shell');
  ({ distillToolMessages } = await import('../src/services/compact/distill.ts'));
  ({ TOOL_DISTILL_SYSTEM_PROMPT, TOOL_DISTILL_TRUNCATION_MARKER } =
    await import('../src/services/compact/constants.ts'));
  ({ computeDistillNumPredict, computeDistillInputMaxChars } =
    await import('../src/services/compact/budget.ts'));
  ({ countRawMessagesTokens } = await import('../src/services/tokenizer.ts'));
  ({ getTokenCalibration, resetTokenCalibration } =
    await import('../src/services/tokenCalibration.ts'));
  goldenFile.load();
});

afterAll(() => {
  goldenFile.save();
  scratch?.leave();
});

beforeEach(() => {
  resetTokenCalibration();
});

const scenario = (respond, run) =>
  runScenario({ distillSystemPrompt: TOOL_DISTILL_SYSTEM_PROMPT, respond, run });

/** Varied text (so the tokenizer sees real words, not a repeated character). */
const output = (label, lines) =>
  Array.from(
    { length: lines },
    (_, index) => `${label} line ${index}: value=${(index * 7919) % 1009} token-${index}`
  ).join('\n');

const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });

/** One assistant turn with three calls, then the three results (a, b, c). */
function threeOutputs(chars = [22_000, 26_000, 18_000]) {
  const [a, b, c] = chars.map((size, index) => output(`out-${index}`, Math.ceil(size / 36)));
  return [
    { role: 'user', content: 'look around' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [call('c-a', 'read_file'), call('c-b', 'run_command'), call('c-c', 'web_fetch')],
    },
    { role: 'tool', content: a, tool_call_id: 'c-a' },
    { role: 'tool', content: b, tool_call_id: 'c-b' },
    { role: 'tool', content: c, tool_call_id: 'c-c' },
  ];
}

const toolNameOf = (user) => /^Tool name: (.+)$/m.exec(user)?.[1];

/** What a test records about a returned message: its shape, not its whole body. */
const describeMessage = (message) => ({
  role: message.role,
  chars: message.content.length,
  head: message.content.slice(0, 120),
  tail: message.content.slice(-60),
});

/** The request's token estimate x 1.5: a clean sample for the calibration. */
const reportedPromptTokens = (body) =>
  Math.ceil(countRawMessagesTokens(body.messages, MODEL) * 1.5);

describe('a mixed pass: one digest, one failure, one empty digest', () => {
  const NUM_CTX = 32_768;

  test('the requests, the digests, the verbatim failure and the progress lines', async () => {
    const history = threeOutputs();
    const { fake, progress, value, error } = await scenario(
      ({ body, user }) => {
        switch (toolNameOf(user)) {
          case 'run_command': {
            return {
              chunks: ['DIGEST ', 'OF B'],
              promptEvalCount: reportedPromptTokens(body),
              evalCount: 4,
            };
          }
          case 'read_file': {
            return { status: 500 };
          }
          default: {
            return { text: '', promptEvalCount: reportedPromptTokens(body), evalCount: 1 };
          }
        }
      },
      (ctx, log) => distillToolMessages(ctx, history, NUM_CTX, MODEL, 3, (line) => log.push(line))
    );
    expect(error).toBeUndefined();
    expect(fake.unexpected).toStrictEqual([]);

    // What was SENT: one request per output, in history order, each with the
    // distiller's system prompt, no tools and the window-scaled limits.
    expect(
      fake.requests.map((request) => toolNameOf(request.body.messages.at(-1).content))
    ).toStrictEqual(['read_file', 'run_command', 'web_fetch']);
    for (const request of fake.requests) {
      expect(request.kind).toBe('distil');
      expect(request.body.messages[0]).toStrictEqual({
        role: 'system',
        content: TOOL_DISTILL_SYSTEM_PROMPT,
      });
      expect(request.body.tools).toStrictEqual([]);
      expect(request.body.options).toMatchObject({
        temperature: 0,
        num_ctx: NUM_CTX,
        num_predict: computeDistillNumPredict(NUM_CTX),
      });
    }
    expect(fake.requests[1].body.messages[1].content).toMatch(
      new RegExp(
        `^Tool name: run_command\\nTool output length: ${history[3].content.length} chars\\n\\nTool output:\\n`
      )
    );

    // What was BUILT: a wrapped digest, the failed row verbatim, and the
    // empty digest replaced by the (cut) original.
    expect(value.distilledCount).toBe(2);
    expect(value.failedCount).toBe(1);
    expect(value.attemptedCount).toBe(3);
    expect(value.distilledIndices).toStrictEqual([3, 4]);
    expect(value.failedIndices).toStrictEqual([2]);
    expect(value.messages[2]).toStrictEqual(history[2]);
    expect(value.messages[3].content).toBe(
      `[Distilled tool output from run_command; original length ${history[3].content.length} chars]\nDIGEST OF B`
    );
    expect(value.messages[4].content).toMatch(
      new RegExp(
        `^\\[Distilled tool output from web_fetch; original length ${history[4].content.length} chars\\]\\n`
      )
    );
    expect(value.messages[4].content).toContain(TOOL_DISTILL_TRUNCATION_MARKER);

    // The progress lines, in order: live text, "Distilled k/N", then the failure notice.
    expect(progress.filter((line) => line.startsWith('Distilling tool output 4/5'))).toHaveLength(
      2
    );
    expect(progress).toContain('Distilled tool output 1/3 (run_command)');
    expect(progress.at(-1)).toMatch(
      /^1 of 3 tool distillation call\(s\) failed \(the provider returned an error\)/
    );

    // The calibration: the two answers that reported a prompt count each
    // recorded a sample in the DISTILL class, and nothing leaked into `chat`.
    expect(getTokenCalibration(MODEL, 'distill').samples).toBe(2);
    expect(getTokenCalibration(MODEL, 'distill').factor).toBeGreaterThan(1);
    expect(getTokenCalibration(MODEL, 'chat').samples).toBe(0);

    goldenFile.check('mixed pass', {
      requests: describeRequests(fake),
      progress,
      counters: {
        distilledCount: value.distilledCount,
        skippedCount: value.skippedCount,
        orphanCount: value.orphanCount,
        failedCount: value.failedCount,
        attemptedCount: value.attemptedCount,
        budgetSkippedCount: value.budgetSkippedCount,
        candidateCount: value.candidateCount,
        prefillTokens: value.prefillTokens,
        distilledIndices: value.distilledIndices,
        failedIndices: value.failedIndices,
      },
      messages: value.messages.map(describeMessage),
    });
  });
});

describe('an input larger than the window allows', () => {
  const NUM_CTX = 1024;

  test('is cut, and both the request header and the digest wrapper say so', async () => {
    const history = threeOutputs([6000, 100, 100]);
    const { fake, progress, value, error } = await scenario(
      () => ({ text: 'SHORT DIGEST' }),
      (ctx, log) => distillToolMessages(ctx, history, NUM_CTX, MODEL, 1, (line) => log.push(line))
    );
    expect(error).toBeUndefined();
    expect(fake.requests).toHaveLength(1);

    const header = fake.requests[0].body.messages[1].content;
    const kept = Number(/only the first (\d+) chars were sent to the distiller/.exec(header)?.[1]);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(history[2].content.length);
    expect(header).toContain(
      `Tool output length: ${history[2].content.length} chars (only the first`
    );
    expect(value.messages[2].content).toBe(
      `[Distilled tool output from read_file; original length ${history[2].content.length} chars; only the first ${kept} chars were distilled]\nSHORT DIGEST`
    );
    goldenFile.check('cut input', {
      requests: describeRequests(fake),
      progress,
      messages: value.messages.map(describeMessage),
    });
  });
});

describe('a prefill budget that pays for one call only', () => {
  const NUM_CTX = 32_768;

  test('the largest output is distilled and the rest stay verbatim, with a notice', async () => {
    const history = threeOutputs();
    const { fake, progress, value, error } = await scenario(
      () => ({ text: 'DIGEST' }),
      (ctx, log) =>
        distillToolMessages(
          ctx,
          history,
          NUM_CTX,
          MODEL,
          3,
          (line) => log.push(line),
          undefined,
          undefined,
          undefined,
          {
            totalTokens: 9000,
            usedTokens: 0,
          }
        )
    );
    expect(error).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
    // The largest output (index 3) is the one the budget pays for.
    expect(toolNameOf(fake.requests[0].body.messages[1].content)).toBe('run_command');
    expect(value.distilledIndices).toStrictEqual([3]);
    expect(value.budgetSkippedCount).toBe(2);
    expect(value.messages[2]).toStrictEqual(history[2]);
    expect(value.messages[4]).toStrictEqual(history[4]);
    expect(progress.at(-1)).toBe(
      "2 oversized tool output(s) were left verbatim: the compaction's distillation prefill budget ran out."
    );
    goldenFile.check('budget for one call', {
      requests: describeRequests(fake),
      progress,
      messages: value.messages.map(describeMessage),
    });
  });
});

describe('the size of a distillation request', () => {
  // The token-count fallback for a failing WASM counter is removed in the
  // refactor (docs/COMPACTION_REFACTOR_PLAN.md, step 1.3) on the strength of
  // this bound: the per-call input cap plus the fixed prompt stays far below the
  // ~524,288 characters at which tiktoken is reported to fail.
  test.each([1024, 8192, 32_768, 131_072, 262_144, 1_048_576, 10_000_000])(
    'a window of %p tokens stays below the counter limit',
    (numCtx) => {
      expect(
        computeDistillInputMaxChars(numCtx) + TOOL_DISTILL_SYSTEM_PROMPT.length + 512
      ).toBeLessThan(524_288);
    }
  );
});
