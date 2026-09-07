/**
 * tokenThroughput.ts
 *
 * Shared tokens-per-second (t/s) policy for the web UI status bar. Both
 * agentic surfaces — the main chat loop (src/app/api/chat/route.ts) and the
 * sub-agent loop (src/tools/impl/subAgentTool.ts) — use the live meter, and
 * the chat route uses the turn aggregator, so the measurement semantics can
 * never drift between them.
 *
 * Measurement semantics (deliberate choices):
 *
 * - Live meter: the clock is REBASELINED at the first token-bearing chunk,
 *   so connection setup, model load, and prompt-processing time are excluded
 *   from the rate (matching the authoritative eval_duration-based figure
 *   Ollama reports). Emissions are gated on NEW tokens having arrived since
 *   the last emission: while the model streams a large tool-call argument
 *   (invisible to the chunk stream) the previously reported rate is frozen
 *   instead of decaying toward zero, and the tool-call arguments are counted
 *   into the numerator once they surface.
 * - Turn aggregator: rates are aggregated as sum(evalCount)/sum(evalDuration)
 *   across every LLM call in the turn, so a multi-call tool loop reports the
 *   turn's true generation speed instead of "last (shortest) call wins".
 *   When a provider supplies no durations (OpenAI-compatible), the fallback
 *   is sum(evalCount)/sum(wall-clock) and the result is flagged estimated so
 *   the UI can tag it "(est)".
 * - All extraction from wire chunks is guarded: numeric strings are coerced
 *   and non-finite values are dropped, so a malformed provider can neither
 *   zero the metrics nor string-concatenate the token counts.
 */

import { countTextTokens } from '@/services/tokenizer';

/**
 * How long the generation phase took per LLM call, plus the raw wire metrics
 * it was derived from.
 */
export interface TurnCallSample {
  /**
   * Guard-extracted metrics from the call's final chunk. Absent fields mean
   * the provider did not report them (or reported garbage) — they contribute
   * nothing rather than zeroing the aggregate.
   */
  stats: CleanTurnStats;
  /**
   * Milliseconds from the call's first token-bearing chunk to the end of the
   * call. Null when no tokens were observed streaming. Used only for the
   * wall-clock fallback when the provider reports no durations.
   */
  wallElapsedMs?: number | null;
}

/** Authoritative, estimated-tagged rate snapshot for a completed turn. */
export interface TurnThroughputSnapshot {
  /**
   * Aggregate generation speed in tokens/second across the turn, or null
   * when no generation was observed. Estimated (wall-clock) when the
   * provider reports no eval durations — see evalTpsEstimated.
   */
  evalTps: number | null;
  /** Aggregate prompt-processing speed, or null when not reported. */
  promptTps: number | null;
  /**
   * True when evalTps is derived from wall-clock time (no provider
   * durations) or from a mix of duration-based and wall-clock calls, so the
   * UI should present it with an "(est)" caveat.
   */
  evalTpsEstimated: boolean;
}

/** Raw per-chunk LLM metrics as they appear on the wire (Ollama-style keys). */
export interface RawTurnStats {
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  prompt_eval_duration?: unknown;
  eval_duration?: unknown;
}

/** Guard-extracted, finite (or absent) versions of the raw wire metrics. */
export interface CleanTurnStats {
  promptEvalCount?: number;
  evalCount?: number;
  promptEvalDuration?: number;
  evalDuration?: number;
}

/**
 * Coerce a wire value into a finite number: numbers pass through (NaN and
 * infinities dropped), numeric strings are parsed (some proxies quote usage
 * values), everything else becomes undefined.
 */
function coerceFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Extract the turn metrics from a terminal LLM chunk with full validation.
 * Only finite values survive; absent/garbage fields are simply absent from
 * the result so callers can retain previous values instead of zeroing them.
 */
export function extractTurnStats(chunk: RawTurnStats): CleanTurnStats {
  const stats: CleanTurnStats = {};
  const promptEvalCount = coerceFiniteNumber(chunk.prompt_eval_count);
  const evalCount = coerceFiniteNumber(chunk.eval_count);
  const promptEvalDuration = coerceFiniteNumber(chunk.prompt_eval_duration);
  const evalDuration = coerceFiniteNumber(chunk.eval_duration);
  if (promptEvalCount !== undefined) stats.promptEvalCount = promptEvalCount;
  if (evalCount !== undefined) stats.evalCount = evalCount;
  if (promptEvalDuration !== undefined) stats.promptEvalDuration = promptEvalDuration;
  if (evalDuration !== undefined) stats.evalDuration = evalDuration;
  return stats;
}

function round2(value: number): number {
  return +(value.toFixed(2));
}

/**
 * Live tokens-per-second meter for one LLM call (streaming). Counts tokens
 * from thinking/content/tool-argument chunks, rebaselines its clock at the
 * first token, and emits throttled progress reports — but only while new
 * tokens are actually arriving, so the displayed rate freezes (rather than
 * decaying toward zero) while the model streams unobservable tokens such as
 * tool-call arguments.
 *
 * The clock source is injectable for tests.
 */
export class LiveThroughputMeter {
  private readonly model: string;
  private readonly minIntervalMs: number;
  private readonly now: () => number;

  /** Timestamp of the first token-bearing chunk (rebaseline point). */
  private startMs = 0;
  private tokens = 0;
  private tokensAtLastEmit = 0;
  private lastEmitMs = 0;

  constructor(
    model: string,
    minIntervalMs: number,
    now: () => number = Date.now
  ) {
    this.model = model;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
  }

  /** Count tokens carried by a text chunk (thinking or content). */
  onText(text: string): void {
    if (!text) return;
    const t = this.now();
    if (this.startMs === 0) this.startMs = t;
    this.tokens += countTextTokens(text, this.model);
  }

  /**
   * Count tokens carried by tool-call arguments once they surface (they
   * stream invisibly through most adapters, so they are usually counted
   * retroactively from the terminal chunk).
   */
  onJson(json: string): void {
    this.onText(json);
  }

  /** True once at least one token-bearing chunk has been observed. */
  get hasTokens(): boolean {
    return this.startMs !== 0;
  }

  /** Timestamp of the first token-bearing chunk, or null before one arrives. */
  get firstTokenAt(): number | null {
    return this.startMs === 0 ? null : this.startMs;
  }

  /**
   * Emit a progress report through the callback if (and only if) new tokens
   * have arrived since the last report and the minimum interval has elapsed.
   * While no new tokens arrive, nothing is emitted and the consumer's
   * previously displayed rate stays frozen.
   */
  maybeReport(report: (tps: number) => void): void {
    if (this.startMs === 0 || this.tokens === 0) return;
    if (this.tokens === this.tokensAtLastEmit) return;
    const t = this.now();
    if (this.lastEmitMs !== 0 && t - this.lastEmitMs <= this.minIntervalMs) return;
    const elapsedSec = (t - this.startMs) / 1000;
    if (elapsedSec <= 0) return;
    report(round2(this.tokens / elapsedSec));
    this.tokensAtLastEmit = this.tokens;
    this.lastEmitMs = t;
  }

  /** Drop all state (used when a retry attempt restarts the LLM call). */
  reset(): void {
    this.startMs = 0;
    this.tokens = 0;
    this.tokensAtLastEmit = 0;
    this.lastEmitMs = 0;
  }
}

/**
 * Aggregates per-call throughput samples into one turn-level rate. Duration
 * pairs (evalCount + evalDuration) from every call that reported them are
 * summed; calls without durations fall back to their wall-clock window and
 * flag the aggregate as estimated. Zero-usage terminal chunks (heartbeats,
 * usage-less providers on a given call) contribute nothing — they can never
 * zero out or overwrite a previous call's contribution.
 */
export class TurnThroughputAggregator {
  private evalCountSum = 0;
  private evalDurationNsSum = 0;
  private wallCountSum = 0;
  private wallElapsedMsSum = 0;
  private promptCountSum = 0;
  private promptDurationNsSum = 0;
  private sawDurationBasedEval = false;
  private sawWallClockEval = false;

  recordCall(call: TurnCallSample): void {
    const { stats, wallElapsedMs } = call;
    const evalCount = stats.evalCount ?? 0;
    const evalDuration = stats.evalDuration ?? 0;
    const promptCount = stats.promptEvalCount ?? 0;
    const promptDuration = stats.promptEvalDuration ?? 0;

    if (evalCount > 0) {
      if (evalDuration > 0) {
        this.evalCountSum += evalCount;
        this.evalDurationNsSum += evalDuration;
        this.sawDurationBasedEval = true;
      } else {
        this.wallCountSum += evalCount;
        if (wallElapsedMs !== null && wallElapsedMs !== undefined && wallElapsedMs > 0) {
          this.wallElapsedMsSum += wallElapsedMs;
        }
        this.sawWallClockEval = true;
      }
    }

    if (promptCount > 0 && promptDuration > 0) {
      this.promptCountSum += promptCount;
      this.promptDurationNsSum += promptDuration;
    }
  }

  snapshot(): TurnThroughputSnapshot {
    let evalTps: number | null = null;
    let evalTpsEstimated = false;
    if (this.evalDurationNsSum > 0) {
      evalTps = round2(this.evalCountSum / (this.evalDurationNsSum / 1_000_000_000));
      evalTpsEstimated = this.sawWallClockEval;
    } else if (this.wallElapsedMsSum > 0) {
      evalTps = round2(this.wallCountSum / (this.wallElapsedMsSum / 1000));
      evalTpsEstimated = true;
    }
    const promptTps =
      this.promptDurationNsSum > 0
        ? round2(this.promptCountSum / (this.promptDurationNsSum / 1_000_000_000))
        : null;
    return { evalTps, promptTps, evalTpsEstimated };
  }
}