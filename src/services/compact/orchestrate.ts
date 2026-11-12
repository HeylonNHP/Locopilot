/**
 * orchestrate.ts
 *
 * Top-level compaction flow. Wires history splitting, tool distillation,
 * summary generation (single-shot or map-reduce) and result validation into the
 * public `compactHistory` entry point used by the web route, the chat route and
 * the sub-agent auto-compactor.
 */

import type { RecentFileRow } from '@/services/history';
import type { ChatMessage } from '@/services/llm';

import { debugLog } from '@/app/lib/debugLogger';
import { pinTokenCalibration, unpinTokenCalibration } from '@/services/tokenCalibration';
import { countMessagesTokens, countMessageTokens } from '@/services/tokenizer';

import type { CompactionLlmCall, CompactResult } from './types';

import { computeDistillCallCap, evaluateCompactionSizes } from './budget';
import {
  COMPACT_ACCEPTANCE_HEADROOM,
  formatWindowTrimNotice,
  MIN_SUMMARISE_TOKENS,
  SUMMARY_PREAMBLE,
  TOOL_DISTILL_EXTRA_CALLS_MAX,
} from './constants';
import { distillToolMessages } from './distill';
import {
  createDistillBudget,
  type DistillBudget,
  type DistillResult,
  remainingDistillBudgetTokens,
} from './distillPlan';
import { measureConversationTokens } from './measure';
import {
  buildSizeDiagnostic,
  formatDistillationReport,
  formatExtraDistillOutcome,
  formatPreparingLine,
  formatRetryLine,
  formatStubLine,
  formatTrimLine,
} from './progressText';
import {
  attachRecentFilesMessage,
  buildRecentFilesMessage,
  computeBudgetForResult,
  pathsNamedInToolCalls,
  type RecentFileReader,
  type RecentFilesPlan,
} from './recentFiles';
import { readRecentFileFromDisk } from './recentFilesDisk';
import { produceConversationSummary } from './reduce';
import { buildToolNameMap } from './serialize';
import { planCompactionSplit } from './split';
import { computePreservedWindowBudget, planWindowTrim, type WindowTrimPlan } from './windowTrim';

/** The inputs of {@link compactHistory}. */
export interface CompactHistoryOptions extends CompactionLlmCall {
  /**
   * Current conversation history (should include the system prompt). `ctx` is
   * the per-request LLM context (provider, baseUrl, apiKey), threaded through
   * every nested call so concurrent compaction requests cannot clobber each
   * other.
   */
  messages: ChatMessage[];
  /**
   * Whether secrets are redacted out of the tool arguments AND the tool results
   * that reach the summariser. Defaults to true — the same default as
   * `Config.redactSecrets`, which the callers pass in.
   */
  redactSecrets?: boolean | undefined;
  /**
   * The user's `/compact` note about what to keep — text typed after the
   * command, already normalised to one line by `normaliseCompactionFocus`.
   * `undefined` on every automatic path, where it adds nothing to the prompt.
   */
  focus?: string | undefined;
  /**
   * The files this session touched most recently, newest first (usually
   * `loadRecentFiles(sessionId, 12)`), and the directory the excerpt reader is
   * confined to.
   *
   * Their paths — and, when a file fits WHOLE in its per-file budget, its
   * contents — are re-injected as an assistant message right after the summary,
   * so the model does not re-read the files it was working on. The stub is built
   * ONCE, after the size verdict and after any retry, against the FINAL history's
   * budget, so it can neither cause a retry nor be lost to one.
   *
   * `undefined` means "no stub" and is what every sub-agent passes: their tool
   * calls bypass `fileTouchRecorder`, and the only session id in reach there is
   * the PARENT's — stamping the parent's working set onto a sub-agent's prompt
   * would be a confident lie about files the sub-agent never touched.
   *
   * The root is supplied together with the rows because only the caller can: the
   * confinement is the request's agent working directory
   * (`getAgentWorkingDirectory(scope)`), and a stored path is absolute but says
   * nothing about which scope resolved it.
   */
  recentFiles?: { rows: RecentFileRow[]; root: string } | undefined;
}

/**
 * What stays the same across the passes of ONE compaction: where the calls go,
 * the window, the callbacks, the redaction switch and the focus note. The retry
 * pass reuses it as it is, which is how the focus note survives the retry.
 */
type CompactionRequest = Omit<CompactHistoryOptions, 'messages' | 'recentFiles'>;

/** The recent-files input of a pass (see {@link CompactHistoryOptions.recentFiles}). */
type RecentFilesInput = NonNullable<CompactHistoryOptions['recentFiles']>;

/**
 * What differs between the first pass and a retry. Private: every external
 * caller starts at the first pass, and only the retry supplies real values.
 */
interface CompactionAttempt {
  /** >1 to force stronger compression (the retry pass). */
  aggressiveFactor: number;
  /** How many aggressive retry passes remain. */
  remainingRetries: number;
  /**
   * The tokens of the system prompt this history will be sent with
   * (`resolvedSystemPromptTokens` inside the body, once it has been derived). It
   * exists because the RETRY recursion deliberately passes a history WITHOUT the
   * system row: `newMessages` is an assistant summary plus preserved turns, and
   * the caller re-prepends its own system prompt afterwards. The inner pass
   * therefore cannot derive the number from `messages` (it would compute 0 and
   * understate the real request by the whole system prompt — measured at numCtx
   * 32768 with a 12k system prompt: an inner result of 22k passed the
   * 29,491-token acceptance budget while the true request was 34k, so the
   * route's overflow warning never fired). When absent, the number is computed
   * from the `system` rows of `messages`.
   */
  systemPromptTokens?: number | undefined;
}

/** The first pass of every external call. */
const FIRST_ATTEMPT: CompactionAttempt = { aggressiveFactor: 1, remainingRetries: 2 };

/**
 * Compacts the provided conversation history by asking the LLM to summarise it.
 * Returns the new message array and stats comparing old vs new sizes.
 *
 * Large older histories are processed with a bounded map-reduce pipeline so no
 * single summarisation request can exceed the model's context window.
 *
 * `onTps` is invoked while the distillation and summarisation LLM calls stream,
 * so the UI can show compaction speed. It is not wired to the token-measurement
 * call (it generates at most one token, so it has no meaningful rate).
 *
 * The model's TOKEN CALIBRATION FACTOR is pinned for the whole compaction: the
 * before/after counts have to be measured with the SAME factor, or "did the
 * history shrink?" can flip mid-compaction — a second tab that finished a
 * request in between would move the factor between the two counts and the
 * verdict would compare two different scales. The pin nests (the retry pass
 * re-enters through {@link compactWithPin}), and the samples the compaction's own
 * requests produce are queued and applied when the LAST pin is released.
 */
export async function compactHistory(options: CompactHistoryOptions): Promise<CompactResult> {
  const { messages, recentFiles, ...request } = options;
  return compactWithPin(request, messages, FIRST_ATTEMPT, recentFiles);
}

/**
 * One pass of the compaction with the calibration pinned — the entry the first
 * pass and the retry both go through.
 *
 * WHY the pin is a wrapper and not a `try`/`finally` inside
 * {@link runPinnedAttempt}: the pin has to be held across the WHOLE pass, and a
 * `try`/`finally` around that body would have meant re-indenting several hundred
 * lines — a diff in which a changed indent hides a changed line.
 */
async function compactWithPin(
  request: CompactionRequest,
  messages: ChatMessage[],
  attempt: CompactionAttempt,
  recentFiles?: RecentFilesInput
): Promise<CompactResult> {
  const { model } = request;
  pinTokenCalibration(model);
  try {
    return await runPinnedAttempt(request, messages, attempt, recentFiles);
  } finally {
    unpinTokenCalibration(model);
  }
}

/**
 * What every phase of ONE pass reads and none of them changes: the request, the
 * system prompt's size, the OLD count, the acceptance boundary and the
 * distillation caps — plus the ONE deliberately mutable object, the prefill
 * budget the phases charge as they spend it.
 */
interface PassEnv {
  readonly request: CompactionRequest;
  readonly model: string;
  /** The `system` rows of the input. Empty on a retry pass, whose array has none. */
  readonly systemMessages: ChatMessage[];
  /** The tokens of the system prompt the next request carries (borrowed on a retry). */
  readonly systemPromptTokens: number;
  /** The tokens of the history being replaced, system prompt included. */
  readonly oldTokenCount: number;
  /** `floor(numCtx * COMPACT_ACCEPTANCE_HEADROOM)` — where the result has to land. */
  readonly acceptanceBudget: number;
  /** How many distillation calls this pass may make in total. */
  readonly distillCallCap: number;
  /** The prefill budget of this pass, shared by every distillation pass (mutable). */
  readonly distillBudget: DistillBudget;
}

/**
 * The compaction's result as the phases build it: a summary, the preserved
 * window, where each window row came from, and the array and count the two
 * produce.
 *
 * WHY a value and not a handful of `let`s: every phase that changes the result
 * has to RE-MEASURE it and RE-TAKE the "is it over?" verdict, and a phase that
 * forgot one of the two steps made a stale number decide. {@link draftResult}
 * does both in one place, so the count and the verdict always belong to the
 * array they are about.
 */
interface ResultDraft {
  readonly summary: ChatMessage;
  readonly window: ChatMessage[];
  /**
   * The index each row of `window` came from in the ORIGINAL preserved window.
   * The trimmer cuts a prefix and may hoist the anchor, so the two index spaces
   * are not the same — and the extra distillation pass has to know which rows are
   * already digests IN THE SPACE OF THE ARRAY IT IS ABOUT TO WALK.
   */
  readonly windowSources: readonly number[];
  /** The array the caller replaces its history with: the summary, then the window. */
  readonly messages: ChatMessage[];
  /** The tokens of `messages` plus the system prompt the caller re-prepends. */
  readonly tokens: number;
  /** Whether `tokens` is over the acceptance boundary. */
  readonly overBudget: boolean;
}

/** Builds the draft for a summary and a window, measuring it. */
function draftResult(
  env: PassEnv,
  summary: ChatMessage,
  window: ChatMessage[],
  windowSources: readonly number[],
  tokens?: number
): ResultDraft {
  const messages = [summary, ...window];
  const measured = tokens ?? resultTokens(env, messages);
  return {
    summary,
    window,
    windowSources,
    messages,
    tokens: measured,
    overBudget: exceedsAcceptance(env, measured),
  };
}

/** The same draft carrying a different array (a message inserted, not a part replaced). */
function withMessages(env: PassEnv, draft: ResultDraft, messages: ChatMessage[]): ResultDraft {
  const tokens = resultTokens(env, messages);
  return { ...draft, messages, tokens, overBudget: exceedsAcceptance(env, tokens) };
}

/**
 * Everything the phases read about one pass, derived once.
 *
 * The system prompt is NOT part of the compacted array (the caller injects its
 * own), but it IS part of every request the history is sent in — so it is
 * charged to the OLD count as well as the NEW one. `messages` carries its own
 * `system` rows, which `countMessagesTokens` already counts; only a BORROWED
 * count (the retry pass, whose array has no system row) has to be added here.
 * Doing it on both sides keeps the `aborted` verdict (new >= old) comparing like
 * with like: on the retry pass the history has no `system` row, and charging the
 * system prompt to the new count alone could make a genuinely smaller history
 * look like it did not shrink at all.
 *
 * ONE UNIT SYSTEM: both counts are CALIBRATED counts (the tokenizer's own count
 * is never compared against a token budget), and both are in the `chat` class —
 * the compacted history is the MAIN chat request's content, so it is measured the
 * way a chat request is shaped. The acceptance boundary is a share of the model's
 * context window, which is denominated in provider tokens, so the estimate has to
 * be in provider tokens too. (The summariser's own requests are measured in the
 * `summarise` class, in `reduce.ts`.)
 */
function createPassEnv(
  request: CompactionRequest,
  messages: ChatMessage[],
  attempt: CompactionAttempt
): PassEnv {
  const { model, numCtx } = request;
  const { systemPromptTokens: borrowedSystemPromptTokens } = attempt;
  const systemMessages = messages.filter((message) => message.role === 'system');
  const systemPromptTokens =
    borrowedSystemPromptTokens ?? countMessagesTokens(systemMessages, model);
  const oldTokenCount =
    countMessagesTokens(messages, model) + (systemMessages.length === 0 ? systemPromptTokens : 0);
  return {
    request,
    model,
    systemMessages,
    systemPromptTokens,
    oldTokenCount,
    acceptanceBudget: Math.floor(numCtx * COMPACT_ACCEPTANCE_HEADROOM),
    distillCallCap: computeDistillCallCap(numCtx),
    distillBudget: createDistillBudget(numCtx),
  };
}

/** The tokens of an array as the caller's next request carries it: plus the system prompt. */
function resultTokens(env: PassEnv, messages: readonly ChatMessage[]): number {
  return countMessagesTokens([...messages], env.model) + env.systemPromptTokens;
}

/**
 * Whether a count is over the acceptance boundary.
 *
 * A window of 0 or less means "no window": nothing is over a boundary that does
 * not exist. (`budget.ts` asks the same question with a different finite check,
 * because it must also refuse `Infinity`; the two are deliberately not merged.)
 */
function exceedsAcceptance(env: PassEnv, tokens: number): boolean {
  return env.request.numCtx > 0 && tokens > env.acceptanceBudget;
}

/**
 * One distillation pass over a slice, charged to this pass's prefill budget.
 *
 * The CALL cap is the caller's to decide (`maxCalls`); the BUDGET is not — the
 * pass spends what is left of the compaction's one budget, and the charge is made
 * here so that no caller (there are three) can forget it.
 */
async function distillPass(
  env: PassEnv,
  historyMessages: ChatMessage[],
  options: { maxCalls: number; skipIndices?: ReadonlySet<number> | undefined }
): Promise<DistillResult> {
  const { ctx, model, numCtx, onProgress, signal, reasoningEffort, onTps } = env.request;
  const result = await distillToolMessages({
    ctx,
    model,
    numCtx,
    historyMessages,
    maxCalls: options.maxCalls,
    onProgress,
    signal,
    reasoningEffort,
    onTps,
    budget: env.distillBudget,
    ...(options.skipIndices === undefined ? {} : { skipIndices: options.skipIndices }),
  });
  env.distillBudget.usedTokens += result.prefillTokens;
  return result;
}

/** Where each original window row ended up in a draft's current window. */
function windowPositionsBySource(draft: ResultDraft): Map<number, number> {
  const positions = new Map<number, number>();
  draft.windowSources.forEach((source, position) => positions.set(source, position));
  return positions;
}

/** The current positions of some original rows, dropping the ones the trimmer removed. */
function positionsOf(
  sources: readonly number[],
  positions: ReadonlyMap<number, number>
): Set<number> {
  const found = new Set<number>();
  for (const source of sources) {
    const position = positions.get(source);
    if (position !== undefined) found.add(position);
  }
  return found;
}

/** The compaction itself — one pass, with the calibration already pinned. */
async function runPinnedAttempt(
  request: CompactionRequest,
  messages: ChatMessage[],
  attempt: CompactionAttempt,
  recentFiles?: RecentFilesInput
): Promise<CompactResult> {
  const env = createPassEnv(request, messages, attempt);
  const { ctx, model, numCtx, onProgress, signal, reasoningEffort, onTps } = request;
  const { aggressiveFactor, remainingRetries } = attempt;
  const { focus, redactSecrets = true } = request;

  // Filter out system messages — the system prompt is injected on-the-fly by
  // the caller and should not be preserved through compaction.
  const historyMessages = messages.filter((m) => m.role !== 'system');
  if (historyMessages.length === 0) {
    throw new Error('Cannot compact: conversation has no content beyond the system prompt.');
  }

  // Tool-call id → tool name, built from the FULL conversation (system rows
  // included: they never carry tool calls, so this is a superset of the
  // summarised slice). A tool result can outlive the assistant row that issued
  // it — the history split may bisect an assistant+tool block — so the name
  // has to be resolvable even when the owning assistant is not part of the
  // summarised slice.
  const toolNames = buildToolNameMap(messages);

  // ── Guard against degenerate empty-summary crash ─────────────────────────
  // Subagents (and any short-history code path) can reach this point with
  // messages === [system] — i.e. zero history beyond the system prompt.
  // splitHistoryForCompaction would then return an empty messagesToSummarise,
  // and the downstream estimate collapses to a tiny value. Callers already
  // refuse to compact when fewer than 4 messages exist; this guard is the
  // final safety net against a confusing near-zero-token estimate.

  // The split also carries the fallback ladder for a history that leaves too
  // little to summarise: widen the summarised slice to the anchor, or summarise
  // everything as a last resort (see `planCompactionSplit`). What is still too
  // short after that is refused below.
  const { split: historySplit, summariseTokens: fullEstimate } = planCompactionSplit(
    historyMessages,
    model,
    numCtx,
    aggressiveFactor
  );
  if (fullEstimate < MIN_SUMMARISE_TOKENS) {
    throw new Error(
      `The conversation history is too short to compact (~${fullEstimate} tokens). ` +
        'Continue the conversation and try /compact again when there is more context.'
    );
  }

  onProgress?.(
    formatPreparingLine(
      historySplit.messagesToSummarise.length,
      historySplit.preservedRecentMessages.length
    )
  );

  // ── Distillation, PRESERVED WINDOW FIRST ────────────────────────────────
  //
  // WHY the window goes first: the window is what decides whether the
  // compacted result FITS. `newMessages` keeps it verbatim, so its oversized
  // tool outputs land in the result at full size; the older slice is already
  // bounded by the serialiser's per-result character cap and is only sent to
  // the summariser. Spending the call budget on the window is therefore what
  // turns the budget into a smaller RESULT, not just a cheaper summary
  // request.
  //
  // The PREFILL budget of this compaction bounds what the calls may COST — eight
  // calls at half a million tokens each is several windows' worth of prefill
  // inside one compaction — beside the call cap, which bounds how MANY there are.
  const recentDistill = await distillPass(env, historySplit.preservedRecentMessages, {
    maxCalls: env.distillCallCap,
  });
  const preparedRecentMessages = recentDistill.messages;

  // The older slice gets whatever the window did not spend — the CALL budget
  // and the PREFILL budget, both of them.
  //
  // WHY the CALLS MADE and not the calls that succeeded: a call that failed
  // still cost a model call (and its prefill), so it spends the cap. Counting
  // only the successes would let a flaky provider push the compaction past
  // its call budget.
  const historyDistill = await distillPass(env, historySplit.messagesToSummarise, {
    maxCalls: Math.max(0, env.distillCallCap - recentDistill.attemptedCount),
  });
  const preparedHistoryMessages = historyDistill.messages;

  // The report is ALWAYS emitted, not only when something was left behind: its
  // numbers are the only record of what the distillation cost and of what it did
  // NOT manage to do (see `formatDistillationReport`).
  for (const line of formatDistillationReport({
    window: recentDistill,
    history: historyDistill,
    budgetTotalTokens: env.distillBudget.totalTokens,
    callCap: env.distillCallCap,
    numCtx,
  })) {
    onProgress?.(line);
  }

  // Generate the summary: single-shot when it fits, bounded map-reduce when the
  // older history exceeds the safe input budget.
  //
  // The REAL preserved-recent token count goes down with it: the summariser
  // used to be told "0 estimated tokens" while the prompt also claimed that
  // the summary was the only record of the older turns — a prompt that
  // contradicts itself, and that misinforms the model about what it has to
  // write down.
  //
  // The count is the RAW one: it is measured by the splitter, BEFORE the
  // distiller has replaced the large tool outputs of the preserved window
  // with digests, so it OVERSTATES the window. The prompt says exactly that
  // ("the count is measured before tool outputs are distilled, so it can
  // overstate the window") and does not claim the preserved turns are
  // verbatim — their large tool outputs arrive as digests.
  const summary = await produceConversationSummary({
    ctx,
    model,
    numCtx,
    aggressiveFactor,
    historyMessages: preparedHistoryMessages,
    onProgress,
    signal,
    reasoningEffort,
    onTps,
    toolNames,
    redactSecrets,
    preservedRecentTokens: historySplit.preservedRecentTokens,
    focus,
  });

  // Rebuild the message history: a single assistant message holds the preamble
  // + summary, followed by the distilled recent messages.
  const summaryMessage: ChatMessage = {
    role: 'assistant',
    content: `${SUMMARY_PREAMBLE}\n\n${summary}`,
  };

  // ── The result, WITHOUT the recent-files stub ─────────────────────
  //
  // The stub is re-attached BELOW, once, against the FINAL history. It is
  // deliberately not an input to anything that decides what the result is:
  //
  //   - The retry decision is taken on this array, so the stub can never be the
  //     reason a compaction re-summarises itself.
  //   - The retry recursion receives this array, which has no stub in it — so
  //     the summariser never sees a few thousand tokens of file heads as prose
  //     to compress, and the recursion does not have to know the stub exists.
  //   - The progress line is emitted only after the stub is IN the array that
  //     is returned, so "the files were re-attached" and "the returned messages
  //     carry them" cannot disagree.
  //
  // That ordering is the fix for a stub built too early. It used to be
  // assembled before the size verdict, and on a tight window one of two things
  // happened: a stub big enough to matter pushed the verdict into a retry — and
  // the retry, which deliberately did not forward the rows, came back with NO
  // stub at all after the user had been told the files were re-attached; or the
  // trim paid for the stub's tokens out of the preserved window, dropping turns
  // to fund a convenience.
  let draft = draftResult(
    env,
    summaryMessage,
    preparedRecentMessages,
    preparedRecentMessages.map((_, index) => index)
  );

  const verdict = evaluateCompactionSizes(env.oldTokenCount, draft.tokens, numCtx);

  if (verdict.aborted) {
    throw new Error(
      `Compaction failed to reduce history size (old: ${env.oldTokenCount}, new: ${draft.tokens} tokens). ` +
        'Aborting to avoid increasing context usage.'
    );
  }

  // If the compacted result still exceeds the context window (with headroom),
  // retry with a stronger factor that shrinks preservation budgets and summary
  // targets, forcing more aggressive compression. Bounded by remainingRetries.
  //
  // The estimate alone decides this UNLESS it lands inside the confirmation
  // band around the acceptance boundary, where a tokenizer's few-percent error
  // could flip the answer: only then is ONE live measurement paid for. The
  // measured figure is used for the decision only — `stats.newTokenCount`
  // stays the estimate, so the number the UI shows is always reproducible from
  // the stored history.
  //
  // WHAT the measurement actually measures — not the request shape, an
  // APPROXIMATION of it: the same messages, with `tools: []` and with NO
  // post-compaction nudge (the caller appends that after compaction), so it
  // can under-count by the size of the tool schemas. It is a prompt-eval
  // count of the conversation text only; it exists to break a tie the local
  // tokenizer cannot, not to certify the next request.
  let shouldRetry = verdict.retry;
  let confirmedTokenCount: number | undefined;
  if (verdict.confirm) {
    // A borrowed system prompt (the retry pass) cannot be sent with the
    // measurement — the text is not in this array — so its tokens are added to
    // whatever the provider (or the fallback estimate) reports.
    const borrowedSystemPromptTokens =
      env.systemMessages.length === 0 ? env.systemPromptTokens : 0;
    confirmedTokenCount =
      (await measureConversationTokens(
        ctx,
        [...env.systemMessages, ...draft.messages],
        model,
        numCtx,
        onProgress,
        signal,
        reasoningEffort
      )) + borrowedSystemPromptTokens;
    shouldRetry = exceedsAcceptance(env, confirmedTokenCount);
  }

  // ── Drop the oldest preserved messages BEFORE re-summarising ──────────────
  //
  // WHY this comes before the retry: the retry re-enters `compactHistory` on
  // the ALREADY-compacted array, so its summary is a summary of a summary —
  // the first pass's paraphrase, compressed again, with no dialogue left to
  // check it against. The preserved window is the cheap way out: it is only
  // older recent turns, dropping its oldest end costs context but not
  // FIDELITY, it costs no model call, and it works when `remainingRetries` is
  // already 0.
  //
  // The budget for the window is what the acceptance boundary leaves once
  // everything the result can NOT drop has been paid for: the summary message
  // (preamble + summary + notice) and — the part that used to be missing — the
  // SYSTEM PROMPT. A planner that never paid for it trimmed until the WINDOW
  // fitted, the total stayed over by exactly the system prompt, and the
  // summary-of-a-summary recursion fired anyway. See
  // `computePreservedWindowBudget` for the measurement.
  //
  // The notice is charged at its WORST CASE (every preserved message dropped),
  // so the budget is fixed before the planner runs instead of depending on how
  // much it ends up dropping — a notice that only shows up after the trim would
  // otherwise push the result a few tokens back over the boundary and trigger
  // the re-summary this whole block exists to avoid.
  let trim: WindowTrimPlan | undefined;
  if (shouldRetry) {
    // The header the trim charges is the SUMMARY alone. The stub is attached
    // afterwards, out of whatever room the trimmed result leaves — so it can
    // never cause a preserved turn to be dropped to fund it, and the planner
    // is still not allowed to drop anything it cannot see.
    const headerTokens = countMessagesTokens([draft.summary], model);
    const noticeTokens = countMessageTokens(
      {
        role: 'assistant',
        content: formatWindowTrimNotice(draft.window.length),
      },
      model
    );
    const windowBudget = computePreservedWindowBudget({
      acceptanceBudget: env.acceptanceBudget,
      headerTokens,
      noticeTokens,
      systemPromptTokens: env.systemPromptTokens,
    });
    const trimPlan = planWindowTrim(draft.window, windowBudget, model);
    if (trimPlan.droppedCount > 0) {
      draft = draftResult(
        env,
        {
          ...draft.summary,
          content: `${draft.summary.content}${formatWindowTrimNotice(trimPlan.droppedCount)}`,
        },
        trimPlan.messages,
        trimPlan.keptIndices
      );
      shouldRetry = draft.overBudget;
      trim = trimPlan;
      onProgress?.(formatTrimLine(trimPlan, shouldRetry, draft.tokens, env.acceptanceBudget));
    }
  }

  // ── Spend the leftover distillation budget BEFORE re-summarising ─────────
  //
  // WHY here, and nowhere else: this is the one point where the compaction
  // KNOWS the result does not fit — the trim has been tried and was not
  // enough — and the only lever left that does not cost FIDELITY. The retry
  // recursion re-summarises the ALREADY-compacted array (a summary of a
  // summary, the worst quality leak in the pipeline) and the trim has already
  // dropped everything it may drop.
  //
  // WHY the WINDOW and not the older slice: the preserved window is kept
  // VERBATIM in the result, so digesting its tool outputs shrinks the result
  // DIRECTLY and needs NO extra summariser call. Digesting the older slice
  // would shrink the SUMMARY's input instead — which would need a whole extra
  // summarisation pass, the exact cost this block exists to avoid.
  //
  // WHY the leftover budget is worth spending: the call cap saturates at 8,
  // but the prefill budget is ONE WINDOW. At a 262 144-token window the two
  // bind together (eight calls at ~32 000 tokens each is the whole budget),
  // but at a 1 048 576-token window the CAP binds FIRST — eight calls spend
  // ~258 000 of 1 048 576 tokens, so ~790 000 tokens of the budget went
  // UNSPENT while the oversized outputs that were not digested stayed
  // VERBATIM in the window. A verbatim tool output in the result is exactly
  // what makes it too big, so the leftover budget is worth more spent than
  // idle.
  //
  // THE BUDGET IS THE SAME BUDGET: the extra calls are charged to it (by
  // `distillPass`), so the total prefill of ONE compaction still respects
  // `computeDistillPrefillBudgetTokens(numCtx)`. The call ceiling
  // (`TOOL_DISTILL_EXTRA_CALLS_MAX`) is the other bound — it keeps the
  // latency of the extra spend finite.
  let extraDistillSummary: { distilledCount: number; prefillTokens: number } | undefined;
  if (shouldRetry) {
    // The rows the FIRST window pass already dealt with, in the index space
    // of the window that is about to be walked:
    //
    // - the ones it turned into DIGESTS: a digest must never be distilled
    //   again — a digest is the model's own answer about the output and can
    //   be LONGER than the output it replaced, so distilling it again would
    //   make the window BIGGER.
    // - the ones whose call FAILED: a failure is not retried here. The
    //   provider that just refused the request will refuse it again, and the
    //   extra spend may make up to 32 calls — a failing provider would cost
    //   32 more failures for nothing.
    //
    // What is left is exactly the set the extra spend targets: the oversized
    // outputs the call cap or the prefill budget never ATTEMPTED.
    const positions = windowPositionsBySource(draft);
    const digestedRows = positionsOf(recentDistill.distilledIndices, positions);
    const failedRows = positionsOf(recentDistill.failedIndices, positions);
    const handledRows = new Set([...digestedRows, ...failedRows]);
    const leftoverBudgetTokens = remainingDistillBudgetTokens(env.distillBudget);
    const extraDistill = await distillPass(env, draft.window, {
      maxCalls: TOOL_DISTILL_EXTRA_CALLS_MAX,
      skipIndices: handledRows,
    });
    extraDistillSummary = {
      distilledCount: extraDistill.distilledCount,
      prefillTokens: extraDistill.prefillTokens,
    };

    if (extraDistill.distilledCount > 0) {
      // The digests are only KEPT when they made the result SMALLER: a digest
      // is the model's own answer about the output, and on a small output it
      // can be longer than the output itself. Spending the budget must never
      // make the result bigger.
      const digested = draftResult(
        env,
        draft.summary,
        extraDistill.messages,
        draft.windowSources
      );
      if (digested.tokens < draft.tokens) {
        draft = digested;
        shouldRetry = draft.overBudget;
        onProgress?.(
          formatExtraDistillOutcome({
            kind: 'kept',
            distilledCount: extraDistill.distilledCount,
            prefillTokens: extraDistill.prefillTokens,
            stillOverBudget: shouldRetry,
            newTokenCount: draft.tokens,
            acceptanceBudget: env.acceptanceBudget,
          })
        );
      } else {
        onProgress?.(
          formatExtraDistillOutcome({
            kind: 'rejected',
            distilledCount: extraDistill.distilledCount,
            prefillTokens: extraDistill.prefillTokens,
          })
        );
      }
    } else if (extraDistill.candidateCount === 0) {
      // NOTHING LEFT TO SPEND ON. Two shapes reach this line: the window has
      // no oversized output at all, or every oversized output in it was
      // already distilled or already attempted (and failed).
      onProgress?.(
        formatExtraDistillOutcome({
          kind: 'nothing-left',
          leftoverBudgetTokens,
          failedRows: failedRows.size,
        })
      );
    } else if (extraDistill.attemptedCount === 0) {
      // The leftover budget cannot pay for even ONE call — the candidates are
      // all bigger than what is left of the budget.
      onProgress?.(
        formatExtraDistillOutcome({
          kind: 'unaffordable',
          leftoverBudgetTokens,
          candidateCount: extraDistill.candidateCount,
        })
      );
    } else {
      onProgress?.(
        formatExtraDistillOutcome({
          kind: 'all-failed',
          attemptedCount: extraDistill.attemptedCount,
          candidateCount: extraDistill.candidateCount,
        })
      );
    }
  }

  let retried = false;
  if (shouldRetry && remainingRetries > 0) {
    const retryFactor = Math.max(1.5, draft.tokens / (numCtx * 0.75));
    onProgress?.(formatRetryLine(draft.tokens, numCtx, retryFactor, remainingRetries));
    // The recursion is handed the STUB-LESS array, and it does not receive the
    // rows: a second stub would be built on top of a first one, charged twice,
    // and — worse — the summariser would read a few thousand tokens of file
    // heads as part of the history it is compressing. The stub is attached
    // once, below, to whatever this returns. The note survives the retry
    // because `request` carries it: a second pass re-summarises the
    // already-compacted array, which is exactly where a note the user cares
    // about would otherwise be lost.
    const retryResult = await compactWithPin(request, draft.messages, {
      aggressiveFactor: retryFactor,
      remainingRetries: remainingRetries - 1,
      // The inner pass sees a history WITHOUT the `system` row, so it cannot
      // work the system prompt out for itself: pass the number through, or its
      // retry/confirm decision, its trim budget and its `stats.newTokenCount`
      // would all be short by the whole system prompt.
      systemPromptTokens: env.systemPromptTokens,
    });
    retried = true;
    draft = draftResult(
      env,
      retryResult.newMessages[0] ?? draft.summary,
      retryResult.newMessages.slice(1),
      [],
      retryResult.stats.newTokenCount
    );
  }

  // ── The recent-files stub: built ONCE, against the FINAL history ──────
  //
  // WHY a stub at all: the summary replaces every `read_file` /
  // `patch_file` / `write_file` call of the summarised turns, so the model
  // loses the one cheap fact it had — WHICH files this session is working on —
  // and pays a full round of tool calls to get it back. `session_recent_files`
  // already remembers it (see `fileTouchRecorder.ts`), and the files are still
  // on disk, so the stub re-states the working set and — when a file fits WHOLE
  // in the per-file budget — reproduces it.
  //
  // WHY an ASSISTANT message between the summary and the window:
  //
  //   - NEVER a `user`-role row. `findLatestUserMessageIndex` anchors the next
  //     compaction on the latest real user message; a user-role stub would
  //     become that anchor, and on a second compaction in the same turn the
  //     REAL prompt (which sits earlier) would be summarised away.
  //   - Between the summary and the window it reads as one unit with the
  //     summary — "this is what came before" — and chronologically it is right
  //     (the excerpts are the files as they were at compaction time). After the
  //     window it would read as the newest event in the conversation, which
  //     invites the model to answer the content of a file instead of the user's
  //     request.
  //
  // The budget is charged against `draft.tokens` — everything the finished
  // result already carries, system prompt included — and capped by
  // `min(acceptanceBudget, oldTokenCount - 1)`, so the stub can never push the
  // result past the acceptance boundary, and never back to (or past) the size
  // of the history it replaced: that would trip the `aborted` verdict above and
  // throw "failed to reduce history".
  let recentFilesPlan: RecentFilesPlan | undefined;
  if (recentFiles !== undefined && recentFiles.rows.length > 0) {
    const budgetTokens = computeBudgetForResult({
      numCtx,
      acceptanceBudget: env.acceptanceBudget,
      oldTokenCount: env.oldTokenCount,
      resultTokens: draft.tokens,
    });
    if (budgetTokens > 0) {
      // The reader is confined to the agent's working directory: the rows carry
      // absolute paths, but a path is only safe to READ if it is inside the
      // directory the session is allowed to work in (see
      // `readRecentFileFromDisk`).
      const { root, rows } = recentFiles;
      const readExcerpt: RecentFileReader = (absPath) => readRecentFileFromDisk(absPath, root);
      const plan = await buildRecentFilesMessage({
        files: rows,
        budgetTokens,
        model,
        redactSecrets,
        readExcerpt,
        // The files the preserved window ALREADY carries verbatim are named but
        // not reproduced: the window is several turns and usually contains the
        // `read_file` result the model itself asked for, so a second copy of
        // the same head is pure waste.
        inContextPaths: [...pathsNamedInToolCalls(draft.messages, root)],
      });
      if (plan.text !== '') {
        // The attach is a CHECKED step, not a `splice`: it returns `null` when
        // the stub would un-shrink the history or push it past the acceptance
        // boundary, and `null` is the only path on which nothing is claimed.
        const stubbedMessages = attachRecentFilesMessage({
          messages: draft.messages,
          message: { role: 'assistant', content: plan.text },
          model,
          systemPromptTokens: env.systemPromptTokens,
          oldTokenCount: env.oldTokenCount,
          acceptanceBudget: env.acceptanceBudget,
        });
        if (stubbedMessages !== null) {
          recentFilesPlan = plan;
          draft = withMessages(env, draft, stubbedMessages);
          // The line says WHAT was re-attached, because "paths only" and "with
          // excerpts" are very different amounts of context for the same count —
          // and it is emitted HERE, after the stub is in the array that is
          // returned, so the claim and the result cannot disagree.
          onProgress?.(formatStubLine(plan));
        }
      }
    }
  }

  debugLog.diagnostic(
    buildSizeDiagnostic({
      numCtx,
      acceptanceBudget: env.acceptanceBudget,
      oldTokenCount: env.oldTokenCount,
      estimatedNewTokens: draft.tokens,
      systemPromptTokens: env.systemPromptTokens,
      confirmedNewTokens: confirmedTokenCount,
      recentFiles: recentFilesPlan,
      trim,
      extraDistill: extraDistillSummary,
      retried,
      retry: shouldRetry,
    })
  );

  return {
    newMessages: draft.messages,
    stats: {
      oldTokenCount: env.oldTokenCount,
      newTokenCount: draft.tokens,
    },
  };
}
