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

import type { CompactionLlmCall, CompactResult } from './types';
import type { WindowTrimPlan } from './windowTrim';

import { evaluateCompactionSizes } from './budget';
import { MIN_SUMMARISE_TOKENS, SUMMARY_PREAMBLE } from './constants';
import {
  type CompactionAttempt,
  createPassEnv,
  distillPass,
  draftResult,
  FIRST_ATTEMPT,
  type PassRequest,
} from './pass';
import {
  attachRecentFilesStub,
  confirmVerdict,
  spendLeftoverDistillBudget,
  trimPreservedWindow,
} from './phases';
import {
  buildSizeDiagnostic,
  formatDistillationReport,
  formatPreparingLine,
  formatRetryLine,
  formatStubLine,
} from './progressText';
import {
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
type CompactionRequest = PassRequest;

/** The recent-files input of a pass (see {@link CompactHistoryOptions.recentFiles}). */
type RecentFilesInput = NonNullable<CompactHistoryOptions['recentFiles']>;


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

  // System rows are not part of the compacted array — the system prompt is
  // injected on the fly by the caller — and a history with nothing else cannot
  // be compacted. Callers already refuse below four messages; this is the last
  // guard, and it is what keeps a degenerate `[system]` history from collapsing
  // into a near-zero-token result.
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
  // WHY the window goes first: `draftResult` keeps the window VERBATIM in the
  // result, so its oversized tool outputs land there at full size, while the
  // older slice is bounded by the serialiser's per-result cap and is only sent to
  // the summariser. Spending the call budget on the window is what turns it into
  // a smaller RESULT rather than a cheaper summary request.
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

  // ── The result as the phases build it ─────────────────────────────
  //
  // The stub is re-attached AFTER every phase, once, against the FINAL history:
  // the verdict and the retry decision are taken on this array instead, so a stub
  // can never make a compaction re-summarise itself, and the retry recursion never
  // reads file heads as prose. `phases.ts` owns that reasoning; this is where the
  // order is.
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

  // If the compacted result still exceeds the context window (with headroom), the
  // pipeline retries with a stronger factor that shrinks preservation budgets and
  // summary targets. The order of what it tries first is the point of the three
  // phases below: the confirm band's one live measurement, the trim (free, costs
  // context but not fidelity), the leftover distillation budget (model calls, but
  // no re-summary), and only then the retry — which re-summarises an
  // ALREADY-compacted array, a summary of a summary. Each phase owns its own WHY;
  // `phases.ts` is where they are.
  const confirmed = await confirmVerdict(env, draft, verdict);
  let shouldRetry = confirmed.overBudget;
  const confirmedTokenCount = confirmed.confirmedTokens;

  const trimmed = shouldRetry ? trimPreservedWindow(env, draft) : undefined;
  let trim: WindowTrimPlan | undefined;
  if (trimmed !== undefined) {
    draft = trimmed.draft;
    shouldRetry = trimmed.overBudget;
    trim = trimmed.trim;
  }

  const spent = shouldRetry ? await spendLeftoverDistillBudget(env, draft, recentDistill) : undefined;
  let extraDistillSummary: { distilledCount: number; prefillTokens: number } | undefined;
  if (spent !== undefined) {
    draft = spent.draft;
    shouldRetry = spent.overBudget;
    extraDistillSummary = spent.extraDistill;
  }

  let retried = false;
  if (shouldRetry && remainingRetries > 0) {
    const retryFactor = Math.max(1.5, draft.tokens / (numCtx * 0.75));
    onProgress?.(formatRetryLine(draft.tokens, numCtx, retryFactor, remainingRetries));
    // The recursion gets the STUB-LESS array and no files (see above); the note
    // survives because `request` carries it, and the retry's summary becomes the
    // ONLY record of the older turns — exactly where the note matters most.
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

  // The recent-files stub is built ONCE, against the FINAL history: after the
  // verdict, the trim, the extra spend and any retry, so it can neither cause a
  // retry nor be lost to one, and the summariser never reads file heads as prose.
  // `attachRecentFilesStub` owns the WHY.
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
        // not reproduced: a window turn usually holds the `read_file` result the
        // model itself asked for, so a second copy is pure waste.
        inContextPaths: [...pathsNamedInToolCalls(draft.messages, root)],
      });
      if (plan.text !== '') {
        const attached = await attachRecentFilesStub(env, draft, plan);
        if (attached !== undefined) {
          draft = attached.draft;
          recentFilesPlan = attached.plan;
          // Emitted HERE, after the stub is in the array that is returned, so the
          // claim and the result cannot disagree.
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
