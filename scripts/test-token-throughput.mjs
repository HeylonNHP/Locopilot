#!/usr/bin/env node
/**
 * Unit tests for the shared tokens-per-second policy modules:
 *   - src/services/tokenThroughput.ts (extractTurnStats, LiveThroughputMeter,
 *     TurnThroughputAggregator)
 *   - src/app/lib/tpsDisplay.ts (resolveTpsDisplay)
 *
 * Run with: npx tsx scripts/test-token-throughput.mjs
 *
 * No network, no live server, no Ollama. The live meter takes an injectable
 * clock so all timing behaviour is deterministic.
 *
 * Regression focus: the t/s badge previously (a) included model load and
 * prompt-processing time in the live rate, (b) decayed toward zero while the
 * model streamed unobservable tool-call arguments, (c) reported only the last
 * LLM call's rate after a multi-call tool loop, (d) silently displayed
 * wall-clock estimates identically to authoritative Ollama rates, (e) could
 * show prompt-processing speed (5-50x generation speed) as "t/s", (f) could
 * be zeroed or string-concatenated by malformed provider metrics, and (g)
 * could spike to six-figure t/s when a bulk token arrival (retroactively
 * counted tool-call arguments, or a provider flushing buffered stream
 * output in one chunk) was measured over a window of a few milliseconds.
 */

import {
  extractTurnStats,
  LiveThroughputMeter,
  TurnThroughputAggregator,
} from '../src/services/tokenThroughput.ts';
import { resolveTpsDisplay } from '../src/app/lib/tpsDisplay.ts';

let pass = 0;
let fail = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}\n        expected: ${expected}\n        actual:   ${actual}`);
    fail += 1;
  }
}

function assertTrue(value, label) {
  if (value) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}\n        expected truthy, got: ${value}`);
    fail += 1;
  }
}

/** Deterministic clock: returns a mutable "current time" in ms. */
function makeClock(startMs = 1_000_000) {
  const state = { now: startMs };
  return {
    now: () => state.now,
    advance(ms) {
      state.now += ms;
    },
  };
}

console.log('extractTurnStats');

{
  const stats = extractTurnStats({
    prompt_eval_count: 100,
    eval_count: 42,
    prompt_eval_duration: 1_000_000_000,
    eval_duration: 2_000_000_000,
  });
  assertEq(stats.promptEvalCount, 100, 'numeric wire fields pass through');
  assertEq(stats.evalCount, 42, 'eval_count passes through');
  assertEq(stats.promptEvalDuration, 1_000_000_000, 'prompt duration (ns) passes through');
  assertEq(stats.evalDuration, 2_000_000_000, 'eval duration (ns) passes through');
}

{
  const stats = extractTurnStats({ eval_count: '123' });
  assertEq(stats.evalCount, 123, 'numeric strings are coerced (quoted-usage proxies)');
}

{
  const stats = extractTurnStats({
    eval_count: 'not-a-number',
    prompt_eval_count: Number.NaN,
    eval_duration: Number.POSITIVE_INFINITY,
  });
  assertEq(stats.evalCount, undefined, 'garbage strings are dropped');
  assertEq(stats.promptEvalCount, undefined, 'NaN is dropped');
  assertEq(stats.evalDuration, undefined, 'Infinity is dropped');
  assertEq(Object.keys(stats).length, 0, 'no fields survive when all input is garbage');
}

{
  const stats = extractTurnStats({});
  assertEq(Object.keys(stats).length, 0, 'missing fields are absent (not zero)');
}

console.log('LiveThroughputMeter');

{
  const clock = makeClock();
  const meter = new LiveThroughputMeter('test-model', 800, clock.now);
  const reports = [];
  meter.maybeReport((tps) => reports.push(tps));
  assertEq(reports.length, 0, 'no report before any tokens');
  meter.onText('hello');
  clock.advance(1100);
  meter.maybeReport((tps) => reports.push(tps));
  assertEq(reports.length, 1, 'first token-bearing chunk triggers a report after the min window');
  assertTrue(reports[0] > 0, 'reported rate is positive');
}

{
  // Rebaseline: 10 s of model load + prompt processing before the first
  // chunk must not drag the rate down. Two meters with identical text but
  // different lead times must report the same rate.
  const text = 'The quick brown fox jumps over the lazy dog.';
  const late = makeClock();
  const meterLate = new LiveThroughputMeter('test-model', 800, late.now);
  late.advance(10_000);
  meterLate.onText(text);
  late.advance(1100);
  meterLate.maybeReport(() => {});
  const early = makeClock();
  const meterEarly = new LiveThroughputMeter('test-model', 800, early.now);
  meterEarly.onText(text);
  early.advance(1100);
  meterEarly.maybeReport(() => {});
  const reportsLate = [];
  const reportsEarly = [];
  meterLate.onText(text);
  meterEarly.onText(text);
  late.advance(1000);
  early.advance(1000);
  meterLate.maybeReport((tps) => reportsLate.push(tps));
  meterEarly.maybeReport((tps) => reportsEarly.push(tps));
  assertEq(reportsLate[0], reportsEarly[0], 'lead time before first chunk is excluded from the rate');
}

{
  // Freeze: no new tokens -> no new emissions (the badge must not decay
  // toward zero while tool-call arguments stream invisibly).
  const clock = makeClock();
  const meter = new LiveThroughputMeter('test-model', 800, clock.now);
  const reports = [];
  meter.onText('some generated text');
  clock.advance(1100);
  meter.maybeReport((tps) => reports.push(tps));
  assertEq(reports.length, 1, 'first report fires after the minimum window');
  clock.advance(60_000);
  meter.maybeReport((tps) => reports.push(tps));
  assertEq(reports.length, 1, 'no new tokens -> no new emission (rate freezes, no decay)');
  clock.advance(1000);
  meter.onText('more text');
  meter.maybeReport((tps) => reports.push(tps));
  assertEq(reports.length, 2, 'new tokens resume emissions');
}

{
  // Throttle: emissions within the min interval are suppressed.
  const clock = makeClock();
  const meter = new LiveThroughputMeter('test-model', 800, clock.now);
  const reports = [];
  meter.onText('first');
  clock.advance(1100);
  meter.maybeReport((tps) => reports.push(tps));
  assertEq(reports.length, 1, 'first report emitted');
  clock.advance(100);
  meter.onText('second');
  meter.maybeReport((tps) => reports.push(tps));
  assertEq(reports.length, 1, 'emission inside the min interval is throttled');
  clock.advance(900);
  meter.onText('third');
  meter.maybeReport((tps) => reports.push(tps));
  assertEq(reports.length, 2, 'emission after the min interval passes');
}

{
  // REGRESSION (six-figure t/s spikes): a token dump measured over a tiny
  // window must never be reported. A tool-call-only response surfaces its
  // whole argument payload in one chunk, the meter rebaselines at that
  // instant, and the done chunk arrives a few ms later — the old meter
  // computed e.g. 5000 tokens / 3 ms = 1.6M t/s and the freeze semantics
  // then pinned that value on the badge for the whole tool execution.
  const clock = makeClock();
  const meter = new LiveThroughputMeter('test-model', 800, clock.now);
  const reports = [];
  meter.onText('x'.repeat(2000)); // bulk arrival (any single oversized chunk)
  clock.advance(3);
  meter.maybeReport((tps) => reports.push(tps));
  assertEq(reports.length, 0, 'sub-second measurement window is never reported');
  clock.advance(2_000_000);
  meter.maybeReport((tps) => reports.push(tps));
  assertEq(reports.length, 0, 'no new tokens -> still no emission (frozen, not spiking)');
}

{
  // Bulk-flush boundedness: tokens landing in one chunk shortly after the
  // first can only be reported over a window of at least one second, so the
  // worst-case rate any single oversized chunk can claim is bounded.
  const clock = makeClock();
  const meter = new LiveThroughputMeter('test-model', 800, clock.now);
  let reported = 0;
  meter.onText('bulk tokens arriving in one buffered chunk');
  clock.advance(50); // second chunk lands 50 ms after the first
  meter.onText('more bulk tokens');
  clock.advance(1000); // window now 1050 ms, above the minimum
  meter.maybeReport((tps) => {
    reported = tps;
  });
  assertTrue(reported > 0, 'bounded report emitted once the window reaches one second');
}

{
  const clock = makeClock();
  const meter = new LiveThroughputMeter('test-model', 800, clock.now);
  meter.onText('text');
  clock.advance(1100);
  meter.maybeReport(() => {});
  meter.reset();
  const reports = [];
  meter.maybeReport((tps) => reports.push(tps));
  assertEq(reports.length, 0, 'reset stops emissions (retry safety)');
  assertEq(meter.firstTokenAt, null, 'reset clears the first-token timestamp');
}

console.log('TurnThroughputAggregator');

{
  // Single Ollama-style call: authoritative duration-based rate.
  const agg = new TurnThroughputAggregator();
  agg.recordCall({
    stats: { promptEvalCount: 100, evalCount: 60, promptEvalDuration: 1_000_000_000, evalDuration: 2_000_000_000 },
  });
  const snap = agg.snapshot();
  assertEq(snap.evalTps, 30, 'single call: 60 tokens / 2 s = 30 t/s');
  assertEq(snap.promptTps, 100, 'single call: 100 prompt tokens / 1 s = 100 t/s');
  assertEq(snap.evalTpsEstimated, false, 'duration-based rate is authoritative');
}

{
  // Multi-call tool loop: rates aggregate as sum/sum, NOT last-call-wins.
  const agg = new TurnThroughputAggregator();
  agg.recordCall({ stats: { evalCount: 300, evalDuration: 3_000_000_000 } });
  agg.recordCall({ stats: { evalCount: 100, evalDuration: 1_000_000_000 } });
  const snap = agg.snapshot();
  assertEq(snap.evalTps, 100, '400 tokens / 4 s = 100 t/s (not the last call alone)');
}

{
  // Zero-usage terminal chunk (heartbeat after the real final chunk, or a
  // usage-less provider) contributes nothing and never zeroes the aggregate.
  const agg = new TurnThroughputAggregator();
  agg.recordCall({ stats: { evalCount: 200, evalDuration: 2_000_000_000 } });
  agg.recordCall({ stats: {} });
  agg.recordCall({ stats: { evalCount: 0, evalDuration: 0 } });
  const snap = agg.snapshot();
  assertEq(snap.evalTps, 100, 'usage-less terminal chunks do not zero the rate');
}

{
  // OpenAI-compatible provider: no durations at all -> wall-clock fallback,
  // flagged estimated.
  const agg = new TurnThroughputAggregator();
  agg.recordCall({ stats: { evalCount: 100 }, wallElapsedMs: 10_000 });
  const snap = agg.snapshot();
  assertEq(snap.evalTps, 10, 'wall-clock fallback: 100 tokens / 10 s');
  assertEq(snap.evalTpsEstimated, true, 'wall-clock fallback is tagged estimated');
  assertEq(snap.promptTps, null, 'no prompt rate without a prompt duration');
}

{
  // Mixed providers (mid-turn model switch): duration-based calls dominate
  // and the aggregate is flagged estimated because some generation time is
  // unaccounted for.
  const agg = new TurnThroughputAggregator();
  agg.recordCall({ stats: { evalCount: 100, evalDuration: 1_000_000_000 } });
  agg.recordCall({ stats: { evalCount: 50 }, wallElapsedMs: 5000 });
  const snap = agg.snapshot();
  assertEq(snap.evalTps, 100, 'mixed-provider rate uses only duration-bearing calls');
  assertEq(snap.evalTpsEstimated, true, 'mixed-provider rate is tagged estimated');
}

{
  // Empty turn: nothing observed -> all nulls (no NaN, no zeros).
  const agg = new TurnThroughputAggregator();
  const snap = agg.snapshot();
  assertEq(snap.evalTps, null, 'no samples -> evalTps null');
  assertEq(snap.promptTps, null, 'no samples -> promptTps null');
}

{
  // Rounding: values are rounded to two decimals.
  const agg = new TurnThroughputAggregator();
  agg.recordCall({ stats: { evalCount: 1, evalDuration: 300_000_000 } });
  const snap = agg.snapshot();
  assertEq(snap.evalTps, 3.33, '1 token / 0.3 s rounds to 3.33');
}

console.log('resolveTpsDisplay');

{
  assertEq(resolveTpsDisplay(109.74, { evalTps: 21 }).value, 109.74, 'live value preferred over end-of-turn rate');
  assertEq(resolveTpsDisplay(null, { evalTps: 21 }).value, 21, 'end-of-turn evalTps used when no live value');
  assertEq(
    resolveTpsDisplay(null, { evalTps: 21, evalTpsEstimated: true }).label,
    '21.00 t/s (est)',
    'wall-clock rate is tagged (est)'
  );
  assertEq(
    resolveTpsDisplay(null, { evalTps: 21 }).label,
    '21.00 t/s',
    'authoritative rate is untagged'
  );
  assertEq(
    resolveTpsDisplay(null, { promptTps: 3120.5, evalTps: null }),
    null,
    'prompt-processing rate is NEVER displayed as generation t/s'
  );
  assertEq(resolveTpsDisplay(null, null), null, 'no data -> null');
  assertEq(resolveTpsDisplay(0, { evalTps: 21 }).value, 21, 'zero live value falls through to end-of-turn rate');
  assertEq(resolveTpsDisplay(-5, { evalTps: 21 }).value, 21, 'negative live value falls through');
  assertEq(resolveTpsDisplay(Number.NaN, { evalTps: null }), null, 'NaN live value -> null');
  assertEq(resolveTpsDisplay(null, { evalTps: Number.NaN }), null, 'NaN end-of-turn value -> null');
  assertEq(resolveTpsDisplay(109.74, null).label, '109.74 t/s', 'live value formats with two decimals');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);