#!/usr/bin/env node
/**
 * Regression guard for the token calibration.
 *
 * Run with: npx tsx scripts/test-token-calibration.mjs
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

import assert from 'node:assert/strict';
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

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
  }
}

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

// The cache is module state: start from a cold cache, whatever ran before.
resetTokenCalibration();

// ─── (a) cold start ──────────────────────────────────────────────────────────
console.log('cold start');

check('an unmeasured model has a factor of exactly 1', () => {
  resetTokenCalibration();
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
});

check('an unmeasured model reports no samples and no timestamp', () => {
  resetTokenCalibration();
  const calibration = getTokenCalibration(MODEL);
  assert.equal(calibration.factor, 1);
  assert.equal(calibration.samples, 0);
  assert.equal(calibration.updatedAt, 0);
});

check('a cold model counts messages exactly like the raw count', () => {
  resetTokenCalibration();
  assert.equal(countMessagesTokens(MESSAGES, MODEL), countRawMessagesTokens(MESSAGES, MODEL));
  assert.equal(countMessageTokens(MESSAGES[0], MODEL), countRawMessageTokens(MESSAGES[0], MODEL));
});

check('a cold model counts text exactly like the raw count', () => {
  resetTokenCalibration();
  const text = 'the quick brown fox jumps over the lazy dog';
  assert.equal(countTextTokens(text, MODEL), countRawTextTokens(text, MODEL));
  assert.equal(countCalibratedTextTokens(text, MODEL), countRawTextTokens(text, MODEL));
});

// ─── (b) one accepted sample ────────────────────────────────────────────────
console.log('one accepted sample');

check('a ratio of 1.25 moves the factor to 1.0625 (a quarter of the gap)', () => {
  resetTokenCalibration();
  const result = recordTokenCalibrationSample(sample(1.25));
  assert.notEqual(result, null);
  assert.equal(getTokenCalibrationFactor(MODEL), 1.0625);
  assert.equal(getTokenCalibration(MODEL).samples, 1);
});

check('the calibrated count is the raw count times the factor, rounded', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.25));
  const factor = getTokenCalibrationFactor(MODEL);
  assert.equal(
    countMessagesTokens(MESSAGES, MODEL),
    Math.round(countRawMessagesTokens(MESSAGES, MODEL) * factor)
  );
  assert.equal(
    countMessageTokens(MESSAGES[1], MODEL),
    Math.round(countRawMessageTokens(MESSAGES[1], MODEL) * factor)
  );
  assert.equal(
    countCalibratedTextTokens('a fairly long piece of text to measure', MODEL),
    Math.round(countRawTextTokens('a fairly long piece of text to measure', MODEL) * factor)
  );
});

check('the sample weight is the quarter the module documents', () => {
  assert.equal(TOKEN_CALIBRATION_SAMPLE_WEIGHT, 0.25);
});

// ─── (c) the admission rules ────────────────────────────────────────────────
console.log('the admission rules');

check('a sample below the minimum size is rejected', () => {
  resetTokenCalibration();
  const result = recordTokenCalibrationSample({
    model: MODEL,
    provider: PROVIDER,
    class: 'chat',
    estimatedTokens: TOKEN_CALIBRATION_MIN_SAMPLE_TOKENS - 1,
    authoritativeTokens: 5000,
  });
  assert.equal(result, null);
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
  assert.equal(getTokenCalibration(MODEL).samples, 0);
});

check('a sample at exactly the minimum size is accepted', () => {
  resetTokenCalibration();
  const result = recordTokenCalibrationSample({
    model: MODEL,
    provider: PROVIDER,
    class: 'chat',
    estimatedTokens: TOKEN_CALIBRATION_MIN_SAMPLE_TOKENS,
    authoritativeTokens: 5000,
  });
  assert.notEqual(result, null);
  assert.equal(getTokenCalibration(MODEL).samples, 1);
});

check('a ratio above the ceiling is rejected', () => {
  resetTokenCalibration();
  const result = recordTokenCalibrationSample(sample(TOKEN_CALIBRATION_MAX_FACTOR + 0.01));
  assert.equal(result, null);
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
});

check('a request with images is rejected', () => {
  resetTokenCalibration();
  const result = recordTokenCalibrationSample(sample(1.25, { hasImages: true }));
  assert.equal(result, null);
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
});

check('a provider that reported nothing is rejected', () => {
  resetTokenCalibration();
  assert.equal(recordTokenCalibrationSample(sample(1.25, { authoritativeTokens: 0 })), null);
  assert.equal(recordTokenCalibrationSample(sample(1.25, { authoritativeTokens: -5 })), null);
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
});

check('a non-finite estimate is rejected', () => {
  resetTokenCalibration();
  assert.equal(recordTokenCalibrationSample(sample(1.25, { estimatedTokens: Number.NaN })), null);
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
});

// ─── (d) the dangerous direction ────────────────────────────────────────────
console.log('the dangerous direction');

check('the floor is 1 — the factor may never go below the raw count', () => {
  assert.equal(TOKEN_CALIBRATION_MIN_FACTOR, 1);
});

check('a sample that claims the request was CHEAPER is rejected', () => {
  resetTokenCalibration();
  const result = recordTokenCalibrationSample(sample(0.8));
  assert.equal(result, null, 'a below-1 sample was accepted');
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
  assert.equal(getTokenCalibration(MODEL).samples, 0);
});

check('a run of below-1 samples cannot move the factor below 1', () => {
  resetTokenCalibration();
  for (let index = 0; index < 50; index += 1) {
    recordTokenCalibrationSample(sample(0.5));
  }
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
});

check('the calibrated count is NEVER below the raw count', () => {
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
      assert.ok(
        countMessagesTokens(MESSAGES, MODEL, requestClass) >= raw,
        `the ${requestClass} count fell below the raw count after a ${ratio} sample`
      );
      assert.ok(
        countCalibratedTextTokens('a fairly long piece of text to measure', MODEL, requestClass) >=
          countRawTextTokens('a fairly long piece of text to measure', MODEL),
        `the ${requestClass} text count fell below the raw count`
      );
    }
  }
});

// ─── (e) the overhead subtraction is gone ───────────────────────────────────
console.log('the overhead subtraction');

check('the overhead does NOT lower the ratio any more', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.25));
  const withoutOverhead = getTokenCalibrationFactor(MODEL);

  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.25, { overheadTokens: 1000 }));
  const withOverhead = getTokenCalibrationFactor(MODEL);

  // The tool schemas are NOT subtracted from the provider's count: our
  // estimate of them is a guess, and a guess that is too large drives the
  // ratio below 1 — the dangerous direction. The schemas inflate the
  // numerator instead, so the learned factor is conservative.
  assert.equal(withoutOverhead, 1.0625);
  assert.equal(withOverhead, withoutOverhead);
});

check('an overhead larger than the provider count is still accepted', () => {
  // The old rule rejected such a sample; the new rule does not subtract the
  // overhead at all, so the sample is just an ordinary one.
  resetTokenCalibration();
  const result = recordTokenCalibrationSample(sample(1.25, { overheadTokens: 9000 }));
  assert.notEqual(result, null);
  assert.equal(getTokenCalibrationFactor(MODEL), 1.0625);
});

check('the ratio is the provider count over our count, with nothing removed', () => {
  resetTokenCalibration();
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
  assert.equal(getTokenCalibrationFactor(MODEL), 1.0625);
});

// ─── (f) the request classes do not contaminate each other ──────────────────
console.log('the request classes');

check('a chat sample and a summarise sample do not contaminate each other', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.5));
  recordTokenCalibrationSample(sample(1.1, { class: 'summarise' }));
  // The chat class learned 1.5 → 1 + 0.25 × 0.5 = 1.125.
  assert.equal(getTokenCalibrationFactor(MODEL, 'chat'), 1.125);
  // The summarise class learned 1.1 → 1 + 0.25 × 0.1 = 1.025.
  assert.equal(getTokenCalibrationFactor(MODEL, 'summarise'), 1.025);
  // And the counts follow their own class.
  assert.equal(
    countMessagesTokens(MESSAGES, MODEL, 'chat'),
    Math.round(countRawMessagesTokens(MESSAGES, MODEL) * 1.125)
  );
  assert.equal(
    countMessagesTokens(MESSAGES, MODEL, 'summarise'),
    Math.round(countRawMessagesTokens(MESSAGES, MODEL) * 1.025)
  );
});

check('a class nobody measured stays cold', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.5));
  assert.equal(getTokenCalibrationFactor(MODEL, 'distill'), 1);
  assert.equal(
    countMessagesTokens(MESSAGES, MODEL, 'distill'),
    countRawMessagesTokens(MESSAGES, MODEL)
  );
});

check('a sample with no class does not land in the chat class', () => {
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
  assert.equal(getTokenCalibrationFactor(MODEL, 'chat'), 1.125);
  // The unclassified sample claimed 4200 / 4000 = 1.05 → 1 + 0.25 × 0.05.
  assert.equal(getTokenCalibrationFactor(MODEL, 'distill'), 1.0125);
});

// ─── (g) the providers ──────────────────────────────────────────────────────
console.log('the providers');

check('a provider change resets the entry instead of blending the two', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.5));
  assert.equal(getTokenCalibrationFactor(MODEL, 'chat'), 1.125);
  // A different provider means a different chat template, so the old
  // measurement is dropped rather than averaged into the new one.
  recordTokenCalibrationSample(sample(1.2, { provider: 'openai' }));
  assert.equal(getTokenCalibrationFactor(MODEL, 'chat'), 1.05);
  assert.equal(getTokenCalibration(MODEL).samples, 1);
  assert.equal(getTokenCalibration(MODEL).provider, 'openai');
});

check('the two providers keep separate sample counts', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.5, { provider: 'ollama' }));
  assert.equal(getTokenCalibration(MODEL).samples, 1);
  recordTokenCalibrationSample(sample(1.5, { provider: 'openai' }));
  assert.equal(getTokenCalibration(MODEL).samples, 1, 'the two providers shared an entry');
});

// ─── (h) convergence ────────────────────────────────────────────────────────
console.log('convergence');

check('two samples converge towards the ratio without overshooting it', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.25));
  const first = getTokenCalibrationFactor(MODEL);
  recordTokenCalibrationSample(sample(1.25));
  const second = getTokenCalibrationFactor(MODEL);

  assert.equal(first, 1.0625);
  assert.equal(second, 1.109375);
  assert.ok(second > first, 'the second sample did not move the factor');
  assert.ok(second < 1.25, 'the factor overshot the ratio it was taught');
});

check('a long run of samples converges on the ratio and never passes it', () => {
  resetTokenCalibration();
  for (let index = 0; index < 40; index += 1) {
    recordTokenCalibrationSample(sample(1.25));
  }
  const factor = getTokenCalibrationFactor(MODEL);
  assert.ok(factor > 1.24, `the factor did not converge (${factor})`);
  assert.ok(factor <= 1.25, `the factor overshot the ratio (${factor})`);
});

// ─── (i) per-model isolation ────────────────────────────────────────────────
console.log('per-model isolation');

check('one model’s factor does not touch another model', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.25));
  assert.equal(getTokenCalibrationFactor(MODEL), 1.0625);
  assert.equal(getTokenCalibrationFactor(OTHER_MODEL), 1);
});

check('an unmeasured model still counts like the raw count', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.25));
  assert.equal(
    countMessagesTokens(MESSAGES, OTHER_MODEL),
    countRawMessagesTokens(MESSAGES, OTHER_MODEL)
  );
  assert.notEqual(countMessagesTokens(MESSAGES, MODEL), countRawMessagesTokens(MESSAGES, MODEL));
});

// ─── (j) the resets ─────────────────────────────────────────────────────────
console.log('the resets');

check('resetTokenCalibration() clears every model', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.25));
  recordTokenCalibrationSample({ ...sample(1.25), model: OTHER_MODEL });
  resetTokenCalibration();
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
  assert.equal(getTokenCalibrationFactor(OTHER_MODEL), 1);
});

check('resetTokenCalibration(model) clears only that model', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.25));
  recordTokenCalibrationSample({ ...sample(1.25), model: OTHER_MODEL });
  resetTokenCalibration(MODEL);
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
  assert.equal(getTokenCalibrationFactor(OTHER_MODEL), 1.0625);
});

check('a reset clears EVERY class of the model, not just the chat one', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.5));
  recordTokenCalibrationSample(sample(1.5, { class: 'summarise' }));
  resetTokenCalibration(MODEL);
  assert.equal(getTokenCalibrationFactor(MODEL, 'chat'), 1);
  assert.equal(getTokenCalibrationFactor(MODEL, 'summarise'), 1);
});

check('a reset also releases the pin and drops the queued samples', () => {
  resetTokenCalibration();
  pinTokenCalibration(MODEL);
  recordTokenCalibrationSample(sample(1.25));
  resetTokenCalibration(MODEL);
  unpinTokenCalibration(MODEL);
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
});

// ─── (k) the pin ────────────────────────────────────────────────────────────
console.log('the pin');

check('a pinned model’s factor does not move', () => {
  resetTokenCalibration();
  pinTokenCalibration(MODEL);
  recordTokenCalibrationSample(sample(1.25));
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
});

check('the sample taken while pinned is applied on the unpin', () => {
  resetTokenCalibration();
  pinTokenCalibration(MODEL);
  recordTokenCalibrationSample(sample(1.25));
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
  unpinTokenCalibration(MODEL);
  assert.equal(getTokenCalibrationFactor(MODEL), 1.0625);
  assert.equal(getTokenCalibration(MODEL).samples, 1);
});

check('the pins nest — only the last unpin releases the factor', () => {
  resetTokenCalibration();
  pinTokenCalibration(MODEL);
  pinTokenCalibration(MODEL);
  recordTokenCalibrationSample(sample(1.25));
  unpinTokenCalibration(MODEL);
  assert.equal(getTokenCalibrationFactor(MODEL), 1, 'the first unpin released the pin');
  unpinTokenCalibration(MODEL);
  assert.equal(getTokenCalibrationFactor(MODEL), 1.0625);
});

check('an unpin without a pin applies nothing', () => {
  resetTokenCalibration();
  unpinTokenCalibration(MODEL);
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
});

check('a rejected sample taken while pinned stays rejected on the unpin', () => {
  resetTokenCalibration();
  pinTokenCalibration(MODEL);
  recordTokenCalibrationSample(sample(1.25, { hasImages: true }));
  unpinTokenCalibration(MODEL);
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
  assert.equal(getTokenCalibration(MODEL).samples, 0);
});

// ─── (l) the clamp — a hostile sample cannot escape the band ────────────────
console.log('the clamp');

check('a run of maximum-ratio samples cannot push the factor past the ceiling', () => {
  resetTokenCalibration();
  for (let index = 0; index < 50; index += 1) {
    recordTokenCalibrationSample(sample(TOKEN_CALIBRATION_MAX_FACTOR));
  }
  const factor = getTokenCalibrationFactor(MODEL);
  assert.ok(factor <= TOKEN_CALIBRATION_MAX_FACTOR, `the factor escaped the ceiling (${factor})`);
  assert.ok(factor > 2.9, `the factor did not converge (${factor})`);
});

check('a sample that claims a wild ratio is rejected outright', () => {
  resetTokenCalibration();
  assert.equal(recordTokenCalibrationSample(sample(50)), null);
  assert.equal(recordTokenCalibrationSample(sample(0.01)), null);
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
});

check('the test seam cannot smuggle in a factor below 1 either', () => {
  // `setTokenCalibration` writes the entry outright, but it still respects
  // the band: the "never below the raw count" guarantee holds on every path.
  resetTokenCalibration();
  setTokenCalibration(MODEL, { factor: 0.25, samples: 1, updatedAt: 0 });
  assert.equal(getTokenCalibrationFactor(MODEL), TOKEN_CALIBRATION_MIN_FACTOR);
  assert.ok(
    countMessagesTokens(MESSAGES, MODEL) >= countRawMessagesTokens(MESSAGES, MODEL),
    'the seam put the count below the raw count'
  );
  setTokenCalibration(MODEL, { factor: 99, samples: 1, updatedAt: 0 });
  assert.equal(getTokenCalibrationFactor(MODEL), TOKEN_CALIBRATION_MAX_FACTOR);
  resetTokenCalibration();
  assert.equal(getTokenCalibrationFactor(MODEL), 1);
});

// ─── (m) the text count stays RAW (the t/s meter) ───────────────────────────
console.log('the text count stays raw');

check('countTextTokens is not scaled by the factor', () => {
  resetTokenCalibration();
  recordTokenCalibrationSample(sample(1.25));
  const text = 'the quick brown fox jumps over the lazy dog';
  assert.equal(countTextTokens(text, MODEL), countRawTextTokens(text, MODEL));
  assert.notEqual(countMessagesTokens(MESSAGES, MODEL), countRawMessagesTokens(MESSAGES, MODEL));
});

check('the live t/s meter counts RAW tokens', () => {
  resetTokenCalibration();
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
  assert.equal(reported, countRawTextTokens(text, MODEL));
});

// ─── (n) the wiring ─────────────────────────────────────────────────────────
//
// The wiring checks look at what each sampling site DECLARES (the request
// class it files the sample under), not at the code around it.
console.log('the wiring');

const routeSource = readSource('src/app/api/chat/route.ts');
const summarizeSource = readSource('src/services/compact/summarize.ts');
const distillSource = readSource('src/services/compact/distill.ts');

check('the main chat turn samples under the chat class', () => {
  const call = sampleCall(routeSource);
  assert.notEqual(call, '', 'the route records no sample');
  assert.match(call, /class:\s*'chat'/u, 'the main turn does not file its sample as a chat one');
});

check('the summariser samples under the summarise class', () => {
  const call = sampleCall(summarizeSource);
  assert.notEqual(call, '', 'the summariser records no sample');
  assert.match(
    call,
    /class:\s*'summarise'/u,
    'the summariser does not file its sample as a summarise one'
  );
});

check('the distiller does not sample under the chat class', () => {
  // The distiller's request is a system prompt and one big user message —
  // the same one-blob shape the summariser uses — so it must not be filed
  // under the chat class, whose factor the window checks depend on.
  const call = sampleCall(distillSource);
  assert.notEqual(call, '', 'the distiller records no sample');
  assert.ok(!/class:\s*'chat'/u.test(call), 'the distiller files its sample under the chat class');
});

check('the main-turn sample compares the RAW count of the array that was sent', () => {
  const call = sampleCall(routeSource);
  assert.match(call, /estimatedTokens:\s*countRawMessagesTokens\(/u, 'the sample is not raw');
});

check('the main-turn sample subtracts nothing from the provider count', () => {
  const call = sampleCall(routeSource);
  assert.ok(
    !/authoritativeTokens:[^,]*-/.test(call),
    'something is still being subtracted from the provider count'
  );
});

check('the main-turn sample refuses an image-bearing request', () => {
  const call = sampleCall(routeSource);
  assert.match(call, /hasImages:/u, 'the sample does not flag an image-bearing request');
});

check('every sample call is guarded by a try/catch', () => {
  for (const file of [
    'src/app/api/chat/route.ts',
    'src/services/compact/distill.ts',
    'src/services/compact/summarize.ts',
  ]) {
    const source = readSource(file);
    const index = source.indexOf('recordTokenCalibrationSample(');
    assert.notEqual(index, -1, `${file} records no sample`);
    const before = source.slice(Math.max(0, index - 400), index);
    assert.match(before, /try\s*\{/u, `${file} records a sample outside a try block`);
  }
});

check('the requests that must NOT be sampled are not sampled', () => {
  for (const file of [
    'src/services/compact/measure.ts',
    'src/tools/impl/subAgentTool.ts',
    'src/services/titleGeneration.ts',
    'src/services/promptLoop.ts',
  ]) {
    assert.ok(
      !readSource(file).includes('recordTokenCalibrationSample('),
      `${file} records a calibration sample — it must not`
    );
  }
});

check('the compaction pins the factor for its whole pass', () => {
  const orchestrateSource = readSource('src/services/compact/orchestrate.ts');
  assert.ok(
    orchestrateSource.includes('pinTokenCalibration(model)'),
    'the compaction does not pin'
  );
  assert.ok(
    orchestrateSource.includes('unpinTokenCalibration(model)'),
    'the compaction does not unpin'
  );
  const pin = orchestrateSource.indexOf('pinTokenCalibration(model)');
  const unpin = orchestrateSource.indexOf('unpinTokenCalibration(model)');
  assert.ok(pin < unpin, 'the unpin comes before the pin');
  const between = orchestrateSource.slice(pin, unpin);
  assert.match(between, /finally\s*\{/u, 'the unpin is not in a finally block');
});

check('the compaction’s counts are the calibrated ones', () => {
  const orchestrateSource = readSource('src/services/compact/orchestrate.ts');
  assert.ok(
    orchestrateSource.includes(
      'countMessagesTokens(newMessages, model) + resolvedSystemPromptTokens'
    ),
    'the new-history count is not the calibrated count'
  );
  assert.ok(
    orchestrateSource.includes('countMessagesTokens(messages, model) +'),
    'the old-history count is not the calibrated count'
  );
});

// The cache is module state: leave it cold for whoever runs next.
resetTokenCalibration();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
