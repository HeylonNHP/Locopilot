/**
 * Regression guard for the token calibration.
 *
 * Locopilot counts tokens with tiktoken; the PROVIDER counts them with the
 * model's own tokenizer, and for a model tiktoken does not know (llama3,
 * qwen3:8b, …) the fallback encoder is roughly 15–25 % optimistic. The
 * calibration (`src/services/tokenCalibration.ts`) learns an empirical
 * request-size ratio from the provider's own prompt count and applies it to
 * every count that is compared against a token budget, so the compaction
 * trigger, the acceptance check and the overflow warning stop believing the
 * window is bigger than it is.
 *
 * What is pinned here — all of it BEHAVIOUR, not source text:
 *
 *   (a) the ARITHMETIC — the EMA step, the admission rules (too small, out
 *       of band, images, no provider count), the clamp;
 *   (b) the DANGEROUS DIRECTION — a calibrated count is NEVER below the raw
 *       count, a sample that claims the request was cheaper is rejected, and
 *       the floor is 1;
 *   (c) the OVERHEAD SUBTRACTION — there is none: the tool schemas inflate
 *       the numerator instead of being subtracted from it;
 *   (d) the REQUEST CLASSES — a chat sample and a summarise sample for the
 *       same model do not contaminate each other;
 *   (e) the PROVIDERS — two providers serving one model keep separate
 *       entries, and a provider change resets the entry;
 *   (f) the PIN — a compaction must see ONE factor for its whole pass, so a
 *       sample taken while pinned is queued and applied on the unpin;
 *   (g) the TEXT COUNT STAYS RAW — the t/s meter reports a rate, not a
 *       scaled count.
 *
 * The cache is in-memory, so the suite resets it at the START and at the
 * END: a file that leaves the cache dirty poisons every suite that runs
 * after it in the same process.
 *
 * Network-free. The tokenizer's WASM is loaded locally; no provider is
 * contacted.
 */

import { afterAll, beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getTokenCalibration,
  getTokenCalibrationFactor,
  pinTokenCalibration,
  recordTokenCalibrationSample,
  resetTokenCalibration,
  setTokenCalibration,
  TOKEN_CALIBRATION_MAX_FACTOR,
  TOKEN_CALIBRATION_MIN_FACTOR,
  TOKEN_CALIBRATION_MIN_SAMPLE_TOKENS,
  TOKEN_CALIBRATION_SAMPLE_WEIGHT,
  unpinTokenCalibration,
} from '../src/services/tokenCalibration.ts';
import {
  countCalibratedTextTokens,
  countMessagesTokens,
  countMessageTokens,
  countRawMessagesTokens,
  countRawMessageTokens,
  countRawTextTokens,
  countTextTokens,
} from '../src/services/tokenizer.ts';
import { LiveThroughputMeter } from '../src/services/tokenThroughput.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Reads a source file from the repository.
 *
 * @param {string} relativePath - the path, relative to the repo root.
 * @returns {string} the file's contents.
 */
function readSource(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/**
 * The text of one `recordTokenCalibrationSample(...)` call in a source file.
 *
 * The wiring checks below look at the SAMPLE — what it declares — and not at
 * the code around it, so they survive a refactor of the surrounding lines.
 *
 * @param {string} source - the file's contents.
 * @returns {string} the call's text, or an empty string when there is none.
 */
function sampleCall(source) {
  const start = source.indexOf('recordTokenCalibrationSample(');
  if (start === -1) {
    return '';
  }
  const end = source.indexOf('});', start);
  return source.slice(start, end === -1 ? undefined : end);
}

const MODEL = 'test-model-a';
const OTHER_MODEL = 'test-model-b';
const PROVIDER = 'ollama';

/** A message list big enough that the raw count is well above zero. */
const MESSAGES = [
  { role: 'system', content: 'You are a helpful assistant. '.repeat(20) },
  { role: 'user', content: 'Summarise the conversation so far. '.repeat(40) },
];

/**
 * A sample whose estimated size clears the minimum-sample floor.
 *
 * @param {number} ratio - the ratio the sample claims.
 * @param {object} extra - extra sample fields.
 * @returns {object} the sample.
 */
function sample(ratio, extra = {}) {
  return {
    model: MODEL,
    provider: PROVIDER,
    class: 'chat',
    estimatedTokens: 4000,
    authoritativeTokens: Math.round(4000 * ratio),
    ...extra,
  };
}

// The cache is module state: every test starts from a cold cache, whatever ran
// before, and the last one leaves it cold for whoever runs next.
beforeEach(() => {
  resetTokenCalibration();
});

afterAll(() => {
  resetTokenCalibration();
});

// ─── (a) cold start ──────────────────────────────────────────────────────────
describe('cold start', () => {
  test('an unmeasured model has a factor of exactly 1', () => {
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
  });

  test('an unmeasured model reports no samples and no timestamp', () => {
    const calibration = getTokenCalibration(MODEL);
    expect(calibration.factor).toBe(1);
    expect(calibration.samples).toBe(0);
    expect(calibration.updatedAt).toBe(0);
  });

  test('a cold model counts messages exactly like the raw count', () => {
    expect(countMessagesTokens(MESSAGES, MODEL)).toBe(countRawMessagesTokens(MESSAGES, MODEL));
    expect(countMessageTokens(MESSAGES[0], MODEL)).toBe(countRawMessageTokens(MESSAGES[0], MODEL));
  });

  test('a cold model counts text exactly like the raw count', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(countTextTokens(text, MODEL)).toBe(countRawTextTokens(text, MODEL));
    expect(countCalibratedTextTokens(text, MODEL)).toBe(countRawTextTokens(text, MODEL));
  });
});

// ─── (b) one accepted sample ────────────────────────────────────────────────
describe('one accepted sample', () => {
  test('a ratio of 1.25 moves the factor to 1.0625 (a quarter of the gap)', () => {
    const result = recordTokenCalibrationSample(sample(1.25));
    expect(result).not.toBeNull();
    expect(getTokenCalibrationFactor(MODEL)).toBe(1.0625);
    expect(getTokenCalibration(MODEL).samples).toBe(1);
  });

  test('the calibrated count is the raw count times the factor, rounded', () => {
    recordTokenCalibrationSample(sample(1.25));
    const factor = getTokenCalibrationFactor(MODEL);
    expect(countMessagesTokens(MESSAGES, MODEL)).toBe(
      Math.round(countRawMessagesTokens(MESSAGES, MODEL) * factor)
    );
    expect(countMessageTokens(MESSAGES[1], MODEL)).toBe(
      Math.round(countRawMessageTokens(MESSAGES[1], MODEL) * factor)
    );
    expect(countCalibratedTextTokens('a fairly long piece of text to measure', MODEL)).toBe(
      Math.round(countRawTextTokens('a fairly long piece of text to measure', MODEL) * factor)
    );
  });

  test('the sample weight is the quarter the module documents', () => {
    expect(TOKEN_CALIBRATION_SAMPLE_WEIGHT).toBe(0.25);
  });
});

// ─── (c) the admission rules ────────────────────────────────────────────────
describe('the admission rules', () => {
  test('a sample below the minimum size is rejected', () => {
    const result = recordTokenCalibrationSample({
      model: MODEL,
      provider: PROVIDER,
      class: 'chat',
      estimatedTokens: TOKEN_CALIBRATION_MIN_SAMPLE_TOKENS - 1,
      authoritativeTokens: 5000,
    });
    expect(result).toBeNull();
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
    expect(getTokenCalibration(MODEL).samples).toBe(0);
  });

  test('a sample at exactly the minimum size is accepted', () => {
    const result = recordTokenCalibrationSample({
      model: MODEL,
      provider: PROVIDER,
      class: 'chat',
      estimatedTokens: TOKEN_CALIBRATION_MIN_SAMPLE_TOKENS,
      authoritativeTokens: 5000,
    });
    expect(result).not.toBeNull();
    expect(getTokenCalibration(MODEL).samples).toBe(1);
  });

  test('a ratio above the ceiling is rejected', () => {
    const result = recordTokenCalibrationSample(sample(TOKEN_CALIBRATION_MAX_FACTOR + 0.01));
    expect(result).toBeNull();
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
  });

  test('a request with images is rejected', () => {
    const result = recordTokenCalibrationSample(sample(1.25, { hasImages: true }));
    expect(result).toBeNull();
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
  });

  test('a provider that reported nothing is rejected', () => {
    expect(recordTokenCalibrationSample(sample(1.25, { authoritativeTokens: 0 }))).toBeNull();
    expect(recordTokenCalibrationSample(sample(1.25, { authoritativeTokens: -5 }))).toBeNull();
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
  });

  test('a non-finite estimate is rejected', () => {
    expect(recordTokenCalibrationSample(sample(1.25, { estimatedTokens: Number.NaN }))).toBeNull();
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
  });
});

// ─── (d) the dangerous direction ────────────────────────────────────────────
describe('the dangerous direction', () => {
  test('the floor is 1 — the factor may never go below the raw count', () => {
    expect(TOKEN_CALIBRATION_MIN_FACTOR).toBe(1);
  });

  test('a sample that claims the request was CHEAPER is rejected', () => {
    const result = recordTokenCalibrationSample(sample(0.8));
    expect(result).toBeNull();
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
    expect(getTokenCalibration(MODEL).samples).toBe(0);
  });

  test('a run of below-1 samples cannot move the factor below 1', () => {
    for (let index = 0; index < 50; index += 1) {
      recordTokenCalibrationSample(sample(0.5));
    }
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
  });

  test('the calibrated count is NEVER below the raw count', () => {
    // The property the whole calibration rests on: Locopilot may believe the
    // window is fuller than it is, but it must never believe it has room it
    // does not have. Every count, in every class, after every sequence of
    // samples — including hostile ones — is at least the raw count.
    resetTokenCalibration();
    const ratios = [1.6, 0.9, 0.5, 2.9, 1, 0.99, 3, 0.1, 1.25];
    for (const ratio of ratios) {
      recordTokenCalibrationSample(sample(ratio));
      for (const requestClass of ['chat', 'summarise', 'distill']) {
        const raw = countRawMessagesTokens(MESSAGES, MODEL);
        expect(countMessagesTokens(MESSAGES, MODEL, requestClass)).toBeGreaterThanOrEqual(raw);
        expect(
          countCalibratedTextTokens('a fairly long piece of text to measure', MODEL, requestClass)
        ).toBeGreaterThanOrEqual(
          countRawTextTokens('a fairly long piece of text to measure', MODEL)
        );
      }
    }
  });
});

// ─── (e) the overhead subtraction is gone ───────────────────────────────────
describe('the overhead subtraction', () => {
  test('the overhead does NOT lower the ratio any more', () => {
    recordTokenCalibrationSample(sample(1.25));
    const withoutOverhead = getTokenCalibrationFactor(MODEL);

    resetTokenCalibration();
    recordTokenCalibrationSample(sample(1.25, { overheadTokens: 1000 }));
    const withOverhead = getTokenCalibrationFactor(MODEL);

    // The tool schemas are NOT subtracted from the provider's count: our
    // estimate of them is a guess, and a guess that is too large drives the
    // ratio below 1 — the dangerous direction. The schemas inflate the
    // numerator instead, so the learned factor is conservative.
    expect(withoutOverhead).toBe(1.0625);
    expect(withOverhead).toBe(withoutOverhead);
  });

  test('an overhead larger than the provider count is still accepted', () => {
    // The old rule rejected such a sample; the new rule does not subtract the
    // overhead at all, so the sample is just an ordinary one.
    resetTokenCalibration();
    const result = recordTokenCalibrationSample(sample(1.25, { overheadTokens: 9000 }));
    expect(result).not.toBeNull();
    expect(getTokenCalibrationFactor(MODEL)).toBe(1.0625);
  });

  test('the ratio is the provider count over our count, with nothing removed', () => {
    recordTokenCalibrationSample({
      model: MODEL,
      provider: PROVIDER,
      class: 'chat',
      estimatedTokens: 4000,
      authoritativeTokens: 5000,
      overheadTokens: 1000,
    });
    // 5000 / 4000 = 1.25 → 1 + 0.25 × 0.25 = 1.0625. With the old subtraction
    // it would have been (5000 − 1000) / 4000 = 1 → a factor of exactly 1.
    expect(getTokenCalibrationFactor(MODEL)).toBe(1.0625);
  });
});

// ─── (f) the request classes do not contaminate each other ──────────────────
describe('the request classes', () => {
  test('a chat sample and a summarise sample do not contaminate each other', () => {
    recordTokenCalibrationSample(sample(1.5));
    recordTokenCalibrationSample(sample(1.1, { class: 'summarise' }));
    // The chat class learned 1.5 → 1 + 0.25 × 0.5 = 1.125.
    expect(getTokenCalibrationFactor(MODEL, 'chat')).toBe(1.125);
    // The summarise class learned 1.1 → 1 + 0.25 × 0.1 = 1.025.
    expect(getTokenCalibrationFactor(MODEL, 'summarise')).toBe(1.025);
    // And the counts follow their own class.
    expect(countMessagesTokens(MESSAGES, MODEL, 'chat')).toBe(
      Math.round(countRawMessagesTokens(MESSAGES, MODEL) * 1.125)
    );
    expect(countMessagesTokens(MESSAGES, MODEL, 'summarise')).toBe(
      Math.round(countRawMessagesTokens(MESSAGES, MODEL) * 1.025)
    );
  });

  test('a class nobody measured stays cold', () => {
    recordTokenCalibrationSample(sample(1.5));
    expect(getTokenCalibrationFactor(MODEL, 'distill')).toBe(1);
    expect(countMessagesTokens(MESSAGES, MODEL, 'distill')).toBe(
      countRawMessagesTokens(MESSAGES, MODEL)
    );
  });

  test('a sample with no class does not land in the chat class', () => {
    // An unclassified sample must not be allowed to dilute the chat factor,
    // whose number the window checks depend on.
    resetTokenCalibration();
    recordTokenCalibrationSample(sample(1.5));
    recordTokenCalibrationSample({
      model: MODEL,
      provider: PROVIDER,
      estimatedTokens: 4000,
      authoritativeTokens: 4200,
    });
    expect(getTokenCalibrationFactor(MODEL, 'chat')).toBe(1.125);
    // The unclassified sample claimed 4200 / 4000 = 1.05 → 1 + 0.25 × 0.05.
    expect(getTokenCalibrationFactor(MODEL, 'distill')).toBe(1.0125);
  });
});

// ─── (g) the providers ──────────────────────────────────────────────────────
describe('the providers', () => {
  test('a provider change resets the entry instead of blending the two', () => {
    recordTokenCalibrationSample(sample(1.5));
    expect(getTokenCalibrationFactor(MODEL, 'chat')).toBe(1.125);
    // A different provider means a different chat template, so the old
    // measurement is dropped rather than averaged into the new one.
    recordTokenCalibrationSample(sample(1.2, { provider: 'openai' }));
    expect(getTokenCalibrationFactor(MODEL, 'chat')).toBe(1.05);
    expect(getTokenCalibration(MODEL).samples).toBe(1);
    expect(getTokenCalibration(MODEL).provider).toBe('openai');
  });

  test('the two providers keep separate sample counts', () => {
    recordTokenCalibrationSample(sample(1.5, { provider: 'ollama' }));
    expect(getTokenCalibration(MODEL).samples).toBe(1);
    recordTokenCalibrationSample(sample(1.5, { provider: 'openai' }));
    expect(getTokenCalibration(MODEL).samples).toBe(1);
  });
});

// ─── (h) convergence ────────────────────────────────────────────────────────
describe('convergence', () => {
  test('two samples converge towards the ratio without overshooting it', () => {
    recordTokenCalibrationSample(sample(1.25));
    const first = getTokenCalibrationFactor(MODEL);
    recordTokenCalibrationSample(sample(1.25));
    const second = getTokenCalibrationFactor(MODEL);

    expect(first).toBe(1.0625);
    expect(second).toBe(1.109375);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(1.25);
  });

  test('a long run of samples converges on the ratio and never passes it', () => {
    for (let index = 0; index < 40; index += 1) {
      recordTokenCalibrationSample(sample(1.25));
    }
    const factor = getTokenCalibrationFactor(MODEL);
    expect(factor).toBeGreaterThan(1.24);
    expect(factor).toBeLessThanOrEqual(1.25);
  });
});

// ─── (i) per-model isolation ────────────────────────────────────────────────
describe('per-model isolation', () => {
  test('one model’s factor does not touch another model', () => {
    recordTokenCalibrationSample(sample(1.25));
    expect(getTokenCalibrationFactor(MODEL)).toBe(1.0625);
    expect(getTokenCalibrationFactor(OTHER_MODEL)).toBe(1);
  });

  test('an unmeasured model still counts like the raw count', () => {
    recordTokenCalibrationSample(sample(1.25));
    expect(countMessagesTokens(MESSAGES, OTHER_MODEL)).toBe(
      countRawMessagesTokens(MESSAGES, OTHER_MODEL)
    );
    expect(countMessagesTokens(MESSAGES, MODEL)).not.toBe(countRawMessagesTokens(MESSAGES, MODEL));
  });
});

// ─── (j) the resets ─────────────────────────────────────────────────────────
describe('the resets', () => {
  test('resetTokenCalibration() clears every model', () => {
    recordTokenCalibrationSample(sample(1.25));
    recordTokenCalibrationSample({ ...sample(1.25), model: OTHER_MODEL });
    resetTokenCalibration();
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
    expect(getTokenCalibrationFactor(OTHER_MODEL)).toBe(1);
  });

  test('resetTokenCalibration(model) clears only that model', () => {
    recordTokenCalibrationSample(sample(1.25));
    recordTokenCalibrationSample({ ...sample(1.25), model: OTHER_MODEL });
    resetTokenCalibration(MODEL);
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
    expect(getTokenCalibrationFactor(OTHER_MODEL)).toBe(1.0625);
  });

  test('a reset clears EVERY class of the model, not just the chat one', () => {
    recordTokenCalibrationSample(sample(1.5));
    recordTokenCalibrationSample(sample(1.5, { class: 'summarise' }));
    resetTokenCalibration(MODEL);
    expect(getTokenCalibrationFactor(MODEL, 'chat')).toBe(1);
    expect(getTokenCalibrationFactor(MODEL, 'summarise')).toBe(1);
  });

  test('a reset also releases the pin and drops the queued samples', () => {
    pinTokenCalibration(MODEL);
    recordTokenCalibrationSample(sample(1.25));
    resetTokenCalibration(MODEL);
    unpinTokenCalibration(MODEL);
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
  });
});

// ─── (k) the pin ────────────────────────────────────────────────────────────
describe('the pin', () => {
  test('a pinned model’s factor does not move', () => {
    pinTokenCalibration(MODEL);
    recordTokenCalibrationSample(sample(1.25));
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
  });

  test('the sample taken while pinned is applied on the unpin', () => {
    pinTokenCalibration(MODEL);
    recordTokenCalibrationSample(sample(1.25));
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
    unpinTokenCalibration(MODEL);
    expect(getTokenCalibrationFactor(MODEL)).toBe(1.0625);
    expect(getTokenCalibration(MODEL).samples).toBe(1);
  });

  test('the pins nest — only the last unpin releases the factor', () => {
    pinTokenCalibration(MODEL);
    pinTokenCalibration(MODEL);
    recordTokenCalibrationSample(sample(1.25));
    unpinTokenCalibration(MODEL);
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
    unpinTokenCalibration(MODEL);
    expect(getTokenCalibrationFactor(MODEL)).toBe(1.0625);
  });

  test('an unpin without a pin applies nothing', () => {
    unpinTokenCalibration(MODEL);
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
  });

  test('a rejected sample taken while pinned stays rejected on the unpin', () => {
    pinTokenCalibration(MODEL);
    recordTokenCalibrationSample(sample(1.25, { hasImages: true }));
    unpinTokenCalibration(MODEL);
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
    expect(getTokenCalibration(MODEL).samples).toBe(0);
  });
});

// ─── (l) the clamp — a hostile sample cannot escape the band ────────────────
describe('the clamp', () => {
  test('a run of maximum-ratio samples cannot push the factor past the ceiling', () => {
    for (let index = 0; index < 50; index += 1) {
      recordTokenCalibrationSample(sample(TOKEN_CALIBRATION_MAX_FACTOR));
    }
    const factor = getTokenCalibrationFactor(MODEL);
    expect(factor).toBeLessThanOrEqual(TOKEN_CALIBRATION_MAX_FACTOR);
    expect(factor).toBeGreaterThan(2.9);
  });

  test('a sample that claims a wild ratio is rejected outright', () => {
    expect(recordTokenCalibrationSample(sample(50))).toBeNull();
    expect(recordTokenCalibrationSample(sample(0.01))).toBeNull();
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
  });

  test('the test seam cannot smuggle in a factor below 1 either', () => {
    // `setTokenCalibration` writes the entry outright, but it still respects
    // the band: the "never below the raw count" guarantee holds on every path.
    resetTokenCalibration();
    setTokenCalibration(MODEL, { factor: 0.25, samples: 1, updatedAt: 0 });
    expect(getTokenCalibrationFactor(MODEL)).toBe(TOKEN_CALIBRATION_MIN_FACTOR);
    expect(countMessagesTokens(MESSAGES, MODEL)).toBeGreaterThanOrEqual(
      countRawMessagesTokens(MESSAGES, MODEL)
    );
    setTokenCalibration(MODEL, { factor: 99, samples: 1, updatedAt: 0 });
    expect(getTokenCalibrationFactor(MODEL)).toBe(TOKEN_CALIBRATION_MAX_FACTOR);
    resetTokenCalibration();
    expect(getTokenCalibrationFactor(MODEL)).toBe(1);
  });
});

// ─── (m) the text count stays RAW (the t/s meter) ───────────────────────────
describe('the text count stays raw', () => {
  test('countTextTokens is not scaled by the factor', () => {
    recordTokenCalibrationSample(sample(1.25));
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(countTextTokens(text, MODEL)).toBe(countRawTextTokens(text, MODEL));
    expect(countMessagesTokens(MESSAGES, MODEL)).not.toBe(countRawMessagesTokens(MESSAGES, MODEL));
  });

  test('the live t/s meter counts RAW tokens', () => {
    recordTokenCalibrationSample(sample(1.25));
    const text = 'the quick brown fox jumps over the lazy dog';
    let clock = 1000;
    const meter = new LiveThroughputMeter(MODEL, 0, () => clock);
    meter.onText(text);
    clock = 2000;
    let reported = null;
    meter.maybeReport((tps) => {
      reported = tps;
    });
    // One second of window: the reported rate IS the token count.
    expect(reported).toBe(countRawTextTokens(text, MODEL));
  });
});

// ─── (n) the wiring ─────────────────────────────────────────────────────────
//
// The wiring checks look at what each sampling site DECLARES (the request
// class it files the sample under), not at the code around it.
describe('the wiring', () => {
  const routeSource = readSource('src/app/api/chat/route.ts');
  const summarizeSource = readSource('src/services/compact/summarize.ts');
  const distillSource = readSource('src/services/compact/distill.ts');

  test('the main chat turn samples under the chat class', () => {
    const call = sampleCall(routeSource);
    expect(call).not.toBe('');
    expect(call).toMatch(/class:\s*'chat'/u);
  });

  test('the summariser samples under the summarise class', () => {
    const call = sampleCall(summarizeSource);
    expect(call).not.toBe('');
    expect(call).toMatch(/class:\s*'summarise'/u);
  });

  test('the distiller does not sample under the chat class', () => {
    // The distiller's request is a system prompt and one big user message —
    // the same one-blob shape the summariser uses — so it must not be filed
    // under the chat class, whose factor the window checks depend on.
    const call = sampleCall(distillSource);
    expect(call).not.toBe('');
    expect(call).not.toMatch(/class:\s*'chat'/u);
  });

  test('the main-turn sample compares the RAW count of the array that was sent', () => {
    const call = sampleCall(routeSource);
    expect(call).toMatch(/estimatedTokens:\s*countRawMessagesTokens\(/u);
  });

  test('the main-turn sample subtracts nothing from the provider count', () => {
    const call = sampleCall(routeSource);
    expect(call).not.toMatch(/authoritativeTokens:[^,]*-/);
  });

  test('the main-turn sample refuses an image-bearing request', () => {
    const call = sampleCall(routeSource);
    expect(call).toMatch(/hasImages:/u);
  });

  test.each([
    'src/app/api/chat/route.ts',
    'src/services/compact/distill.ts',
    'src/services/compact/summarize.ts',
  ])('every sample call is guarded by a try/catch (%p)', (file) => {
    const source = readSource(file);
    const index = source.indexOf('recordTokenCalibrationSample(');
    expect(index).not.toBe(-1);
    const before = source.slice(Math.max(0, index - 400), index);
    expect(before).toMatch(/try\s*\{/u);
  });

  test.each([
    'src/services/compact/measure.ts',
    'src/tools/impl/subAgentTool.ts',
    'src/services/titleGeneration.ts',
    'src/services/promptLoop.ts',
  ])('the requests that must NOT be sampled are not sampled (%p)', (file) => {
    expect(readSource(file)).not.toContain('recordTokenCalibrationSample(');
  });

  test('the compaction pins the factor for its whole pass', () => {
    // Behaviour, not text: a factor that changes between the pass's requests (as
    // a finished turn in another tab makes it change) must not move the counts
    // the pass compares. compact-orchestrate.test.mjs runs the same compaction
    // twice, once with a sample landing after its first request, and requires
    // identical stats, progress lines and requests.
    const orchestrateSource = readSource('src/services/compact/orchestrate.ts');
    // What the source can still state: the pin and the release wrap the pass.
    expect(orchestrateSource).toContain('pinTokenCalibration(model)');
    expect(orchestrateSource).toContain('unpinTokenCalibration(model)');
    const between = orchestrateSource.slice(
      orchestrateSource.indexOf('pinTokenCalibration(model)'),
      orchestrateSource.indexOf('unpinTokenCalibration(model)')
    );
    expect(between).toMatch(/finally\s*\{/u);
    expect(between).toContain('runPinnedAttempt(');
  });
});
