/**
 * Characterisation of `compactHistory` (src/services/compact/orchestrate.ts),
 * driven end to end against a fake Ollama server.
 *
 * WHY this file exists: nothing called `compactHistory`. The only protection of
 * `orchestrate.ts` was about sixteen tests that read its SOURCE TEXT (exact
 * strings, call order, indentation), which break on any move and, for the "must
 * not contain" ones, pass vacuously once the code leaves the file. The
 * refactor in docs/COMPACTION_REFACTOR_PLAN.md turns this 775-line function
 * into named phases; this file records what it does today, so those text checks
 * can be replaced by behaviour.
 *
 * Every scenario proves it took its branch with something only that branch
 * produces: the `compaction_size` diagnostic (verdict, trim, extra spend, files),
 * the presence or absence of the measure request, and that branch's progress
 * line. On top of that, each scenario's transcript is compared with a stored
 * copy (tests/fixtures/compact-orchestrate.golden.json): every request (kind,
 * limits, prompt hashes), every progress line, every diagnostic, the stats and
 * the shape of every returned message. Regenerate deliberately with
 *
 *   LOCOPILOT_TEST_WRITE_GOLDEN=1 npm test -- tests/compact-orchestrate
 *
 * SIZES. All scenarios but the first run at a 4096-token window, so the
 * acceptance boundary is floor(0.9 x 4096) = 3686 tokens and the confirm band
 * is +-204 tokens around it. The fake provider decides how big the summary is
 * (`summaryOf(tokens)`), so the result lands where the scenario needs it. A
 * summary of ~2800 tokens lands inside the band; ~3300 lands over the boundary
 * even after one message is trimmed; ~3000 plus four un-digested tool outputs
 * is over until the extra distillation digests them. The scenarios assert the
 * branch, so a drift in these sizes fails the test instead of passing quietly.
 *
 * The provider reports no `prompt_eval_count` (except for the measure request),
 * so no calibration sample is recorded and every token count is the local
 * estimate. No network, no model. The scratch working directory keeps `debugLog`
 * output out of the repository's logs/.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createGoldenFile, describeRequests, runScenario } from './helpers/compactionHarness.mjs';
import { enterScratchCwd } from './helpers/fakeOllama.mjs';

const MODEL = 'test-model';
const NUM_CTX = 4096;
const ACCEPTANCE = Math.floor(NUM_CTX * 0.9);
const BAND = Math.floor(NUM_CTX * 0.05);
const FOCUS = 'keep the auth refactor details and the failing test output';

const goldenFile = createGoldenFile(
  new URL('fixtures/compact-orchestrate.golden.json', import.meta.url)
);

let scratch;
let workDir;
let compactHistory;
let debugLog;
let SUMMARY_PREAMBLE;
let TOOL_DISTILL_SYSTEM_PROMPT;
let resetTokenCalibration;

beforeAll(async () => {
  scratch = enterScratchCwd('locopilot-orchestrate');
  workDir = path.join(scratch.dir, 'work');
  mkdirSync(workDir);
  ({ compactHistory } = await import('../src/services/compact/orchestrate.ts'));
  ({ SUMMARY_PREAMBLE, TOOL_DISTILL_SYSTEM_PROMPT } =
    await import('../src/services/compact/constants.ts'));
  ({ debugLog } = await import('../src/app/lib/debugLogger.ts'));
  ({ resetTokenCalibration } = await import('../src/services/tokenCalibration.ts'));
  goldenFile.load();
});

afterAll(() => {
  goldenFile.save();
  scratch?.leave();
});

/** The `compaction_size` diagnostics of the current test, in order (inner pass first on a retry). */
let diagnostics;

beforeEach(() => {
  resetTokenCalibration();
  diagnostics = [];
  jest.spyOn(debugLog, 'diagnostic').mockImplementation((entry) => {
    if (entry.phase === 'compaction_size') diagnostics.push(structuredClone(entry));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Fixtures

/** Varied text, so the tokenizer sees real words (about 11 tokens a line). */
const lines = (label, count) =>
  Array.from(
    { length: count },
    (_, index) => `${label} line ${index}: value=${(index * 7919) % 1009} token-${index}`
  ).join('\n');

const summaryOf = (tokens) => lines('sum', Math.ceil(tokens / 11));

const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });

/** A system row plus `count` alternating user/assistant messages of ~190 tokens each. */
const base = (count) => [
  { role: 'system', content: 'You are helpful.' },
  ...Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${index + 1}.\n${lines(`m${index}`, 14)}`,
  })),
];

/** One final turn: a user prompt, one assistant turn with `outs.length` calls, and their results. */
const toolTurn = (outs) => [
  { role: 'user', content: 'Now run the checks and report.' },
  {
    role: 'assistant',
    content: '',
    tool_calls: outs.map((_, index) => call(`c${index}`, 'run_command')),
  },
  ...outs.map((size, index) => ({
    role: 'tool',
    content: lines(`out${index}`, size),
    tool_call_id: `c${index}`,
  })),
];

/** Four ~1500-character outputs: over the distiller's threshold, cheap enough to leave budget. */
const withSmallOutputs = () => [...base(16), ...toolTurn([40, 40, 40, 40])];
/** Four ~6000-character outputs: the first two calls use up the whole prefill budget. */
const withLargeOutputs = () => [...base(16), ...toolTurn([170, 170, 170, 170])];

/** What a test records about a returned message: its shape, with the scratch root masked. */
const describeMessage = (message) => {
  const text = message.content.replaceAll(workDir, '<ROOT>');
  return {
    role: message.role,
    chars: text.length,
    head: text.slice(0, 100),
    tail: text.slice(-60),
  };
};

/**
 * Run `compactHistory` against a fresh fake provider.
 *
 * @param {object} options
 * @param {object[]} options.messages
 * @param {(call: object) => object} options.respond
 * @param {number} [options.numCtx]
 * @param {string} [options.focus]
 * @param {object[]} [options.recentFiles]
 */
async function compact({ messages, respond, numCtx = NUM_CTX, focus, recentFiles }) {
  return runScenario({
    distillSystemPrompt: TOOL_DISTILL_SYSTEM_PROMPT,
    respond,
    run: (ctx, progress) =>
      compactHistory({
        ctx,
        model: MODEL,
        messages,
        numCtx,
        onProgress: (line) => progress.push(line),
        redactSecrets: true,
        focus,
        recentFiles: recentFiles === undefined ? undefined : { rows: recentFiles, root: workDir },
      }),
  });
}

/** Compare a scenario's whole transcript with the stored copy (or record it). */
function expectGolden(name, { fake, progress, value, error }, { pathDependent = false } = {}) {
  const transcript = {
    requests: describeRequests(fake),
    progress,
    diagnostics,
    ...(error === undefined ? {} : { error: error.message }),
    ...(value === undefined
      ? {}
      : { stats: value.stats, messages: value.newMessages.map(describeMessage) }),
  };
  goldenFile.check(name, pathDependent ? maskPathDependentNumbers(transcript) : transcript);
}

/**
 * Mask what depends on the machine.
 *
 * The recent-files stub embeds the absolute path of the files, and the scratch
 * directory's name is random, so the stub's token and character counts (and
 * every total that includes them) differ by a token or two between runs and
 * between machines. A transcript of a scenario with a stub keeps its
 * structure and masks those numbers; the scenario's own assertions carry the
 * rest.
 */
function maskPathDependentNumbers(transcript) {
  const count = '<n>';
  return {
    ...transcript,
    progress: transcript.progress.map((line) => line.replaceAll(/~\d+ tokens/g, '~<n> tokens')),
    diagnostics: transcript.diagnostics.map((entry) => ({
      ...entry,
      estimatedNewTokens: count,
      ...(entry.recentFiles === undefined
        ? {}
        : { recentFiles: { ...entry.recentFiles, tokens: count } }),
    })),
    ...(transcript.stats === undefined
      ? {}
      : { stats: { oldTokenCount: transcript.stats.oldTokenCount, newTokenCount: count } }),
    ...(transcript.messages === undefined
      ? {}
      : {
          messages: transcript.messages.map((message) =>
            message.head.startsWith('[Recent files')
              ? { role: message.role, chars: count, head: message.head, tail: count }
              : message
          ),
        }),
  };
}

const kindsOf = (fake) => fake.requests.map((request) => request.kind);

/** The summary requests only. */
const summaryRequests = (fake) => fake.requests.filter((request) => request.kind === 'summary');

// Scenarios

describe('a result that fits is accepted as it is', () => {
  test('one summary pass, no measurement, no trim, no extra spend, no retry', async () => {
    const result = await compact({
      messages: base(14),
      numCtx: 8192,
      respond: () => ({ text: 'SUMMARY ONE' }),
    });
    const { fake, progress, value, error } = result;
    expect(error).toBeUndefined();
    expect(fake.unexpected).toStrictEqual([]);
    expect(kindsOf(fake)).toStrictEqual(['summary']);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      method: 'local-estimate',
      numCtx: 8192,
      acceptanceBudget: Math.floor(8192 * 0.9),
      retried: false,
      retry: false,
    });
    for (const key of ['windowTrim', 'extraDistill', 'recentFiles', 'confirmedNewTokens']) {
      expect(diagnostics[0]).not.toHaveProperty(key);
    }

    expect(value.newMessages[0].role).toBe('assistant');
    expect(value.newMessages[0].content.startsWith(`${SUMMARY_PREAMBLE}\n\nSUMMARY ONE`)).toBe(
      true
    );
    expect(value.stats.newTokenCount).toBeLessThan(value.stats.oldTokenCount);
    expect(progress.join('\n')).not.toMatch(/Measuring|Dropped|retrying|Re-attached/);
    expectGolden('fits first time', result);
  });
});

describe('a result inside the confirm band is measured once', () => {
  const respond =
    (reportedTokens) =>
    ({ kind }) =>
      kind === 'measure'
        ? { text: '', promptEvalCount: reportedTokens, evalCount: 1 }
        : { text: summaryOf(2800) };

  test('the live count says it fits: one measure request and the estimate stays the stat', async () => {
    const result = await compact({ messages: base(24), respond: respond(3000) });
    const { fake, progress, value, error } = result;
    expect(error).toBeUndefined();
    // The branch proof: the estimate sits inside the band, and exactly one
    // measure request was paid for.
    expect(Math.abs(diagnostics[0].estimatedNewTokens - ACCEPTANCE)).toBeLessThanOrEqual(BAND);
    expect(kindsOf(fake).filter((kind) => kind === 'measure')).toHaveLength(1);
    expect(progress).toContain('Measuring conversation tokens...');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      method: 'live-confirmed',
      confirmedNewTokens: expect.any(Number),
      retried: false,
      retry: false,
    });
    expect(diagnostics[0].confirmedNewTokens).toBeLessThan(ACCEPTANCE);
    // `stats.newTokenCount` is the ESTIMATE, never the live figure.
    expect(value.stats.newTokenCount).toBe(diagnostics[0].estimatedNewTokens);
    expect(diagnostics[0]).not.toHaveProperty('windowTrim');
    expectGolden('confirm band: fits', result);
  });

  test('the live count says it is over: the history is trimmed, not re-summarised', async () => {
    const result = await compact({ messages: base(24), respond: respond(4000) });
    const { fake, progress, value, error } = result;
    expect(error).toBeUndefined();
    expect(kindsOf(fake).filter((kind) => kind === 'measure')).toHaveLength(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      method: 'live-confirmed',
      retried: false,
      retry: false,
      windowTrim: { droppedCount: 1 },
    });
    // The trim alone was enough, so the extra spend and the retry never ran.
    expect(diagnostics[0]).not.toHaveProperty('extraDistill');
    expect(progress.some((line) => line.startsWith('Dropped the 1 oldest preserved message'))).toBe(
      true
    );
    expect(progress.join('\n')).not.toMatch(/retrying/);
    expect(value.stats.newTokenCount).toBeLessThanOrEqual(ACCEPTANCE);
    expectGolden('confirm band: over, trimmed', result);
  });
});

describe('a result that stays over after the trim is re-summarised', () => {
  // The outer pass makes 6 summary requests (3 chunks, 2 reduction groups, the
  // final combine); everything after that is the retry's pass. The first
  // answers are big, the retry's is small ("stronger compression").
  const OUTER_PASS_REQUESTS = 6;
  const respond = ({ index }) => ({
    text: index <= OUTER_PASS_REQUESTS ? summaryOf(3300) : 'SMALL SUMMARY',
  });

  test('trim, nothing to spend, then a retry with a stronger factor', async () => {
    const result = await compact({ messages: base(24), respond });
    const { fake, progress, value, error } = result;
    expect(error).toBeUndefined();
    expect(kindsOf(fake).every((kind) => kind === 'summary')).toBe(true);
    expect(fake.requests.length).toBeGreaterThan(OUTER_PASS_REQUESTS);

    // The branch proof, in the order the phases ran.
    const at = (pattern) => progress.findIndex((line) => pattern.test(line));
    const trimmed = at(/^Dropped the 1 oldest preserved message/);
    const nothing = at(/^No un-digested oversized tool output\(s\) left in the preserved window/);
    const retrying = at(/retrying with 1\.5x stronger compression \(2 attempt\(s\) left\)/);
    expect(trimmed).toBeGreaterThan(-1);
    expect(nothing).toBeGreaterThan(trimmed);
    expect(retrying).toBeGreaterThan(nothing);

    // Two diagnostics: the retry's pass logs first and is clean; the outer pass
    // logs last and keeps ITS verdict (`retry: true`) next to `retried: true`.
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ retried: false, retry: false });
    // The retry's pass sees a history WITHOUT the system row, so it is handed the
    // system prompt's size: without it, its counts would be short by the whole
    // system prompt.
    expect(diagnostics[0].systemPromptTokens).toBeGreaterThan(0);
    expect(diagnostics[0].systemPromptTokens).toBe(diagnostics[1].systemPromptTokens);
    expect(diagnostics[1]).toMatchObject({
      retried: true,
      retry: true,
      windowTrim: { droppedCount: 1 },
      extraDistill: { distilledCount: 0, prefillTokens: 0 },
    });
    // The result is the retry's (small), and the stats say so.
    expect(value.stats.newTokenCount).toBe(diagnostics[0].estimatedNewTokens);
    expect(value.newMessages[0].content).toContain('SMALL SUMMARY');
    expectGolden('trim then retry', result);
  });

  test('the focus note reaches the summary prompts of the retry pass too', async () => {
    const { fake, error } = await compact({ messages: base(24), respond, focus: FOCUS });
    expect(error).toBeUndefined();
    const afterOuterPass = summaryRequests(fake).slice(OUTER_PASS_REQUESTS);
    expect(afterOuterPass.length).toBeGreaterThan(0);
    for (const request of summaryRequests(fake)) {
      expect(request.body.messages[0].content).toContain(FOCUS);
    }
  });
});

describe('the leftover distillation budget is spent before re-summarising', () => {
  /** Distillation answers by call number; summaries are big until the extra spend has run. */
  function scripted({ digestFor, summaryTokens = 3000 }) {
    let distils = 0;
    return ({ kind, user }) => {
      if (kind === 'distil') {
        distils += 1;
        return digestFor(distils, user);
      }
      // The first summaries come after the first window pass (2 calls); the
      // retry's come after the extra spend (calls 3 and 4).
      return { text: distils < 3 ? summaryOf(summaryTokens) : 'SMALL SUMMARY' };
    };
  }

  test('digests that make the window smaller are kept, and the result fits', async () => {
    const result = await compact({
      messages: withSmallOutputs(),
      respond: scripted({ digestFor: () => ({ text: 'DIGEST xx' }) }),
    });
    const { fake, progress, value, error } = result;
    expect(error).toBeUndefined();
    // 2 calls for the window pass (the call cap), 2 for the extra spend.
    expect(kindsOf(fake).filter((kind) => kind === 'distil')).toHaveLength(4);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      retried: false,
      retry: false,
      extraDistill: { distilledCount: 2 },
    });
    expect(
      progress.some((line) =>
        /^Spent the leftover distillation budget on 2 more oversized tool output\(s\).*now within budget/.test(
          line
        )
      )
    ).toBe(true);
    expect(value.stats.newTokenCount).toBeLessThanOrEqual(ACCEPTANCE);
    expect(
      value.newMessages.filter((message) => message.content.startsWith('[Distilled tool output'))
    ).toHaveLength(4);
    expectGolden('extra spend: kept, fits', result);
  });

  test('digests that are not smaller than the outputs leave the window unchanged', async () => {
    const result = await compact({
      messages: withSmallOutputs(),
      respond: scripted({
        digestFor: (n) => ({ text: n <= 2 ? 'DIGEST xx' : lines('long digest', 90) }),
      }),
    });
    const { progress, value, error } = result;
    expect(error).toBeUndefined();
    expect(
      progress.some((line) =>
        /but the digests were no smaller than the outputs they replace/.test(line)
      )
    ).toBe(true);
    // The window was NOT replaced; the result was still over, so it was re-summarised.
    expect(diagnostics[1]).toMatchObject({ retried: true, retry: true });
    expect(value.newMessages[0].content).toContain('SMALL SUMMARY');
    expectGolden('extra spend: rejected', result);
  });

  test('digests that are kept but leave the result over are followed by a retry', async () => {
    const result = await compact({
      messages: withSmallOutputs(),
      respond: scripted({
        digestFor: (n) => ({ text: n <= 2 ? 'DIGEST xx' : 'long digest '.repeat(200) }),
        summaryTokens: 3400,
      }),
    });
    const { progress, value, error } = result;
    expect(error).toBeUndefined();
    expect(
      progress.some((line) =>
        /compacted history is still over budget \(\d+ tokens against a 3686-token budget\)/.test(
          line
        )
      )
    ).toBe(true);
    expect(diagnostics[1]).toMatchObject({ retried: true, retry: true });
    expect(diagnostics[1].extraDistill.distilledCount).toBe(2);
    expect(value.newMessages[0].content).toContain('SMALL SUMMARY');
    expectGolden('extra spend: kept, still over', result);
  });

  test('when every extra call fails the outputs stay verbatim and the compaction goes on', async () => {
    const result = await compact({
      messages: withSmallOutputs(),
      respond: scripted({ digestFor: (n) => (n <= 2 ? { text: 'DIGEST xx' } : { status: 500 }) }),
    });
    const { progress, value, error } = result;
    expect(error).toBeUndefined();
    expect(progress.some((line) => /^All 2 extra distillation call\(s\) failed/.test(line))).toBe(
      true
    );
    expect(diagnostics[1]).toMatchObject({ retried: true, extraDistill: { distilledCount: 0 } });
    expect(value.stats.newTokenCount).toBeLessThanOrEqual(ACCEPTANCE);
    expectGolden('extra spend: all failed', result);
  });

  test('a budget too small for another call says so and leaves the outputs verbatim', async () => {
    const result = await compact({
      messages: withLargeOutputs(),
      respond: scripted({ digestFor: () => ({ text: 'DIGEST xx' }), summaryTokens: 2400 }),
    });
    const { fake, progress, error } = result;
    expect(error).toBeUndefined();
    expect(
      progress.some((line) =>
        /^The leftover distillation budget \(~\d+ tokens\) cannot pay for another distillation call/.test(
          line
        )
      )
    ).toBe(true);
    // Only the window pass (2 calls) and, after the retry, the inner pass (2 calls).
    expect(diagnostics[1].extraDistill).toStrictEqual({ distilledCount: 0, prefillTokens: 0 });
    expect(kindsOf(fake).filter((kind) => kind === 'distil')).toHaveLength(4);
    expectGolden('extra spend: budget too small', result);
  });
});

describe('the recent-files stub', () => {
  /** Two real files in the scratch root, touched two hours ago (a stable "2 hours ago"). */
  function rows() {
    const touched = Date.now() - 2 * 60 * 60 * 1000;
    return ['alpha.ts', 'beta.ts'].map((name, index) => {
      const file = path.join(workDir, name);
      writeFileSync(file, `export const MARKER_${index} = 'UNIQUE_MARKER_${name}';\n`);
      return { path: file, tool: 'read_file', hits: 2, lastSeenAt: touched };
    });
  }

  test('is attached once, between the summary and the window', async () => {
    const result = await compact({
      messages: base(14),
      numCtx: 8192,
      respond: () => ({ text: 'SUMMARY ONE' }),
      recentFiles: rows(),
    });
    const { progress, value, error } = result;
    expect(error).toBeUndefined();
    expect(value.newMessages[0].content).toContain('SUMMARY ONE');
    expect(value.newMessages[1].role).toBe('assistant');
    expect(value.newMessages[1].content).toContain('UNIQUE_MARKER_alpha.ts');
    expect(value.newMessages[1].content).toContain('UNIQUE_MARKER_beta.ts');
    expect(
      progress.filter((line) =>
        line.startsWith('Re-attached the 2 most recently touched files with whole-file excerpts')
      )
    ).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ recentFiles: { included: 2, dropped: 'none' } });
    expectGolden('stub attached', result, { pathDependent: true });
  });

  test('is not built when the result leaves no room below the boundary', async () => {
    const result = await compact({
      messages: base(24),
      respond: ({ kind }) =>
        kind === 'measure'
          ? { text: '', promptEvalCount: 3000, evalCount: 1 }
          : { text: summaryOf(2800) },
      recentFiles: rows(),
    });
    const { value, progress, error } = result;
    expect(error).toBeUndefined();
    // The result sits at the boundary (the live count confirmed it fits), so no
    // budget is left: no stub message, no claim, no diagnostic entry.
    expect(diagnostics[0].estimatedNewTokens).toBeGreaterThanOrEqual(ACCEPTANCE - BAND);
    expect(value.newMessages.some((message) => message.content.includes('UNIQUE_MARKER'))).toBe(
      false
    );
    expect(progress.join('\n')).not.toMatch(/Re-attached/);
    expect(diagnostics[0]).not.toHaveProperty('recentFiles');
    expectGolden('stub: no room', result);
  });

  test('the retry pass never sees the files, and the final result carries ONE stub', async () => {
    const outerPassRequests = 6;
    const result = await compact({
      messages: base(24),
      respond: ({ index }) => ({
        text: index <= outerPassRequests ? summaryOf(3300) : 'SMALL SUMMARY',
      }),
      recentFiles: rows(),
    });
    const { fake, progress, value, error } = result;
    expect(error).toBeUndefined();
    expect(diagnostics.map((entry) => Object.hasOwn(entry, 'recentFiles'))).toStrictEqual([
      false, // the retry's pass
      true, // the outer pass, after the retry
    ]);
    for (const request of fake.requests) {
      expect(JSON.stringify(request.body.messages)).not.toContain('UNIQUE_MARKER');
    }
    expect(
      value.newMessages.filter((message) => message.content.includes('UNIQUE_MARKER_alpha.ts'))
    ).toHaveLength(1);
    expect(progress.filter((line) => line.startsWith('Re-attached the'))).toHaveLength(1);
    expectGolden('stub: retry never sees files', result, { pathDependent: true });
  });
});

describe('a compaction that cannot proceed says why', () => {
  test('a history too short to summarise', async () => {
    const result = await compact({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      respond: () => ({ text: 'X' }),
    });
    expect(result.error?.message).toMatch(
      /The conversation history is too short to compact \(~\d+ tokens\)/
    );
    expect(result.fake.requests).toHaveLength(0);
    expect(diagnostics).toStrictEqual([]);
    expectGolden('too short', result);
  });

  test('a summary that is bigger than the history it replaces', async () => {
    const result = await compact({
      messages: base(24),
      respond: () => ({ text: summaryOf(3600) }),
    });
    expect(result.error?.message).toMatch(
      /^Compaction failed to reduce history size \(old: \d+, new: \d+ tokens\)\. Aborting to avoid increasing context usage\.$/
    );
    expect(diagnostics).toStrictEqual([]);
    expectGolden('failed to reduce', result);
  });

  test('a system prompt alone', async () => {
    const result = await compact({
      messages: [{ role: 'system', content: 'You are helpful.' }],
      respond: () => ({ text: 'X' }),
    });
    expect(result.error?.message).toBe(
      'Cannot compact: conversation has no content beyond the system prompt.'
    );
    expect(result.fake.requests).toHaveLength(0);
  });
});
