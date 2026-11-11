/**
 * Unit tests for the shared tokens-per-second policy modules:
 *   - src/services/tokenThroughput.ts (extractTurnStats, LiveThroughputMeter,
 *     TurnThroughputAggregator)
 *   - src/app/lib/tpsDisplay.ts (resolveTpsDisplay)
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

import { describe, expect, test } from '@jest/globals';

import { resolveTpsDisplay } from '../src/app/lib/tpsDisplay.ts';
import {
  extractTurnStats,
  LiveThroughputMeter,
  TurnThroughputAggregator,
} from '../src/services/tokenThroughput.ts';

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

describe('extractTurnStats', () => {
  test('numeric wire fields pass through', () => {
    const stats = extractTurnStats({
      prompt_eval_count: 100,
      eval_count: 42,
      prompt_eval_duration: 1_000_000_000,
      eval_duration: 2_000_000_000,
    });
    // numeric wire fields pass through
    expect(stats.promptEvalCount).toBe(100);
    // eval_count passes through
    expect(stats.evalCount).toBe(42);
    // prompt duration (ns) passes through
    expect(stats.promptEvalDuration).toBe(1_000_000_000);
    // eval duration (ns) passes through
    expect(stats.evalDuration).toBe(2_000_000_000);
  });

  test('numeric strings are coerced (quoted-usage proxies)', () => {
    const stats = extractTurnStats({ eval_count: '123' });
    // numeric strings are coerced (quoted-usage proxies)
    expect(stats.evalCount).toBe(123);
  });

  test('garbage strings are dropped', () => {
    const stats = extractTurnStats({
      eval_count: 'not-a-number',
      prompt_eval_count: Number.NaN,
      eval_duration: Number.POSITIVE_INFINITY,
    });
    // garbage strings are dropped
    expect(stats.evalCount).toBeUndefined();
    // NaN is dropped
    expect(stats.promptEvalCount).toBeUndefined();
    // Infinity is dropped
    expect(stats.evalDuration).toBeUndefined();
    // no fields survive when all input is garbage
    expect(Object.keys(stats)).toHaveLength(0);
  });

  test('missing fields are absent (not zero)', () => {
    const stats = extractTurnStats({});
    // missing fields are absent (not zero)
    expect(Object.keys(stats)).toHaveLength(0);
  });
});

describe('LiveThroughputMeter', () => {
  test('no report before any tokens', () => {
    const clock = makeClock();
    const meter = new LiveThroughputMeter('test-model', 800, clock.now);
    const reports = [];
    meter.maybeReport((tps) => reports.push(tps));
    // no report before any tokens
    expect(reports).toHaveLength(0);
    meter.onText('hello');
    clock.advance(1100);
    meter.maybeReport((tps) => reports.push(tps));
    // first token-bearing chunk triggers a report after the min window
    expect(reports).toHaveLength(1);
    // reported rate is positive
    expect(reports[0]).toBeGreaterThan(0);
  });

  test('lead time before first chunk is excluded from the rate', () => {
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
    // lead time before first chunk is excluded from the rate
    expect(reportsLate[0]).toBe(reportsEarly[0]);
  });

  test('first report fires after the minimum window', () => {
    // Freeze: no new tokens -> no new emissions (the badge must not decay
    // toward zero while tool-call arguments stream invisibly).
    const clock = makeClock();
    const meter = new LiveThroughputMeter('test-model', 800, clock.now);
    const reports = [];
    meter.onText('some generated text');
    clock.advance(1100);
    meter.maybeReport((tps) => reports.push(tps));
    // first report fires after the minimum window
    expect(reports).toHaveLength(1);
    clock.advance(60_000);
    meter.maybeReport((tps) => reports.push(tps));
    // no new tokens -> no new emission (rate freezes, no decay)
    expect(reports).toHaveLength(1);
    clock.advance(1000);
    meter.onText('more text');
    meter.maybeReport((tps) => reports.push(tps));
    // new tokens resume emissions
    expect(reports).toHaveLength(2);
  });

  test('emissions inside the minimum interval are throttled', () => {
    const clock = makeClock();
    const meter = new LiveThroughputMeter('test-model', 800, clock.now);
    const reports = [];
    meter.onText('first');
    clock.advance(1100);
    meter.maybeReport((tps) => reports.push(tps));
    // first report emitted
    expect(reports).toHaveLength(1);
    clock.advance(100);
    meter.onText('second');
    meter.maybeReport((tps) => reports.push(tps));
    // emission inside the min interval is throttled
    expect(reports).toHaveLength(1);
    clock.advance(900);
    meter.onText('third');
    meter.maybeReport((tps) => reports.push(tps));
    // emission after the min interval passes
    expect(reports).toHaveLength(2);
  });

  test('sub-second measurement window is never reported', () => {
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
    // sub-second measurement window is never reported
    expect(reports).toHaveLength(0);
    clock.advance(2_000_000);
    meter.maybeReport((tps) => reports.push(tps));
    // no new tokens -> still no emission (frozen, not spiking)
    expect(reports).toHaveLength(0);
  });

  test('bounded report emitted once the window reaches one second', () => {
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
    // bounded report emitted once the window reaches one second
    expect(reported).toBeGreaterThan(0);
  });

  test('reset stops emissions (retry safety)', () => {
    const clock = makeClock();
    const meter = new LiveThroughputMeter('test-model', 800, clock.now);
    meter.onText('text');
    clock.advance(1100);
    meter.maybeReport(() => {});
    meter.reset();
    const reports = [];
    meter.maybeReport((tps) => reports.push(tps));
    // reset stops emissions (retry safety)
    expect(reports).toHaveLength(0);
    // reset clears the first-token timestamp
    expect(meter.firstTokenAt).toBeNull();
  });
});

describe('TurnThroughputAggregator', () => {
  test('single call: 60 tokens / 2 s = 30 t/s', () => {
    // Single Ollama-style call: authoritative duration-based rate.
    const agg = new TurnThroughputAggregator();
    agg.recordCall({
      stats: {
        promptEvalCount: 100,
        evalCount: 60,
        promptEvalDuration: 1_000_000_000,
        evalDuration: 2_000_000_000,
      },
    });
    const snap = agg.snapshot();
    // single call: 60 tokens / 2 s = 30 t/s
    expect(snap.evalTps).toBe(30);
    // single call: 100 prompt tokens / 1 s = 100 t/s
    expect(snap.promptTps).toBe(100);
    // duration-based rate is authoritative
    expect(snap.evalTpsEstimated).toBe(false);
  });

  test('400 tokens / 4 s = 100 t/s (not the last call alone)', () => {
    // Multi-call tool loop: rates aggregate as sum/sum, NOT last-call-wins.
    const agg = new TurnThroughputAggregator();
    agg.recordCall({ stats: { evalCount: 300, evalDuration: 3_000_000_000 } });
    agg.recordCall({ stats: { evalCount: 100, evalDuration: 1_000_000_000 } });
    const snap = agg.snapshot();
    // 400 tokens / 4 s = 100 t/s (not the last call alone)
    expect(snap.evalTps).toBe(100);
  });

  test('usage-less terminal chunks do not zero the rate', () => {
    // Zero-usage terminal chunk (heartbeat after the real final chunk, or a
    // usage-less provider) contributes nothing and never zeroes the aggregate.
    const agg = new TurnThroughputAggregator();
    agg.recordCall({ stats: { evalCount: 200, evalDuration: 2_000_000_000 } });
    agg.recordCall({ stats: {} });
    agg.recordCall({ stats: { evalCount: 0, evalDuration: 0 } });
    const snap = agg.snapshot();
    // usage-less terminal chunks do not zero the rate
    expect(snap.evalTps).toBe(100);
  });

  test('wall-clock fallback: 100 tokens / 10 s', () => {
    // OpenAI-compatible provider: no durations at all -> wall-clock fallback,
    // flagged estimated.
    const agg = new TurnThroughputAggregator();
    agg.recordCall({ stats: { evalCount: 100 }, wallElapsedMs: 10_000 });
    const snap = agg.snapshot();
    // wall-clock fallback: 100 tokens / 10 s
    expect(snap.evalTps).toBe(10);
    // wall-clock fallback is tagged estimated
    expect(snap.evalTpsEstimated).toBe(true);
    // no prompt rate without a prompt duration
    expect(snap.promptTps).toBeNull();
  });

  test('mixed-provider rate uses only duration-bearing calls', () => {
    // Mixed providers (mid-turn model switch): duration-based calls dominate
    // and the aggregate is flagged estimated because some generation time is
    // unaccounted for.
    const agg = new TurnThroughputAggregator();
    agg.recordCall({ stats: { evalCount: 100, evalDuration: 1_000_000_000 } });
    agg.recordCall({ stats: { evalCount: 50 }, wallElapsedMs: 5000 });
    const snap = agg.snapshot();
    // mixed-provider rate uses only duration-bearing calls
    expect(snap.evalTps).toBe(100);
    // mixed-provider rate is tagged estimated
    expect(snap.evalTpsEstimated).toBe(true);
  });

  test('no samples -> evalTps null', () => {
    // Empty turn: nothing observed -> all nulls (no NaN, no zeros).
    const agg = new TurnThroughputAggregator();
    const snap = agg.snapshot();
    // no samples -> evalTps null
    expect(snap.evalTps).toBeNull();
    // no samples -> promptTps null
    expect(snap.promptTps).toBeNull();
  });

  test('1 token / 0.3 s rounds to 3.33', () => {
    // Rounding: values are rounded to two decimals.
    const agg = new TurnThroughputAggregator();
    agg.recordCall({ stats: { evalCount: 1, evalDuration: 300_000_000 } });
    const snap = agg.snapshot();
    // 1 token / 0.3 s rounds to 3.33
    expect(snap.evalTps).toBe(3.33);
  });
});

describe('resolveTpsDisplay', () => {
  test.each([
    ['the live value is preferred over the end-of-turn rate', 109.74, { evalTps: 21 }, 109.74],
    ['the end-of-turn evalTps is used when there is no live value', null, { evalTps: 21 }, 21],
    ['a zero live value falls through to the end-of-turn rate', 0, { evalTps: 21 }, 21],
    ['a negative live value falls through', -5, { evalTps: 21 }, 21],
  ])('%s', (_label, live, turn, expected) => {
    expect(resolveTpsDisplay(live, turn).value).toBe(expected);
  });

  test.each([
    [
      'a wall-clock rate is tagged (est)',
      null,
      { evalTps: 21, evalTpsEstimated: true },
      '21.00 t/s (est)',
    ],
    ['an authoritative rate is untagged', null, { evalTps: 21 }, '21.00 t/s'],
    ['a live value is formatted with two decimals', 109.74, null, '109.74 t/s'],
  ])('%s', (_label, live, turn, expected) => {
    expect(resolveTpsDisplay(live, turn).label).toBe(expected);
  });

  test.each([
    [
      'the prompt-processing rate is NEVER displayed as generation t/s',
      null,
      { promptTps: 3120.5, evalTps: null },
    ],
    ['no data shows nothing', null, null],
    ['a NaN live value shows nothing', Number.NaN, { evalTps: null }],
    ['a NaN end-of-turn value shows nothing', null, { evalTps: Number.NaN }],
  ])('%s', (_label, live, turn) => {
    expect(resolveTpsDisplay(live, turn)).toBeNull();
  });
});
