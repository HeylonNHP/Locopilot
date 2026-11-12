/**
 * pass.ts
 *
 * What ONE pass of a compaction carries between its phases: the environment the
 * phases read (`PassEnv`), the result as they build it (`ResultDraft`), and the
 * two operations every phase needs from them — measuring an array the way the
 * caller's next request will carry it, and deciding whether that is over the
 * acceptance boundary.
 *
 * The pass environment exists because those facts must be derived ONCE: the
 * system prompt's size, the old count and the boundary are compared against each
 * other, and a phase that derived one of them its own way would compare two
 * different scales. The result draft exists for the same reason one step later:
 * a phase that changes the result has to re-measure AND re-take the verdict, and
 * a phase that forgot the second step let a stale number decide.
 */

import type { ChatMessage } from '@/services/llm';

import { countMessagesTokens } from '@/services/tokenizer';

import type { CompactionLlmCall } from './types';

import { computeDistillCallCap } from './budget';
import { COMPACT_ACCEPTANCE_HEADROOM } from './constants';
import { distillToolMessages } from './distill';
import { createDistillBudget, type DistillBudget, type DistillResult } from './distillPlan';

/** Everything a pass needs from the caller except the history and the files. */
export interface PassRequest extends CompactionLlmCall {
  /** Whether secrets are redacted out of what reaches the summariser and distiller. */
  redactSecrets?: boolean | undefined;
  /** The `/compact` focus note, already normalised. */
  focus?: string | undefined;
}

/**
 * What differs between the first pass and a retry. Private to the compaction:
 * every external caller starts at the first pass, and only the retry supplies
 * real values.
 */
export interface CompactionAttempt {
  /** >1 to force stronger compression (the retry pass). */
  aggressiveFactor: number;
  /** How many aggressive retry passes remain. */
  remainingRetries: number;
  /**
   * The tokens of the system prompt this history will be sent with. It exists
   * because the RETRY recursion deliberately passes a history WITHOUT the system
   * row: `newMessages` is an assistant summary plus preserved turns, and the
   * caller re-prepends its own system prompt afterwards. The inner pass therefore
   * cannot derive the number from `messages` (it would compute 0 and understate
   * the real request by the whole system prompt — measured at numCtx 32768 with a
   * 12k system prompt: an inner result of 22k passed the 29,491-token acceptance
   * budget while the true request was 34k, so the route's overflow warning never
   * fired). When absent, the number is computed from the `system` rows of
   * `messages`.
   */
  systemPromptTokens?: number | undefined;
}

/** The first pass of every external call. */
export const FIRST_ATTEMPT: CompactionAttempt = { aggressiveFactor: 1, remainingRetries: 2 };

/**
 * What every phase of ONE pass reads and none of them changes: the request, the
 * system prompt's size, the OLD count, the acceptance boundary and the
 * distillation caps — plus the ONE deliberately mutable object, the prefill
 * budget the phases charge as they spend it.
 */
export interface PassEnv {
  readonly request: PassRequest;
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
 *
 * @param request   - what stays the same across the passes of one compaction.
 * @param messages  - the input history of this pass (system rows included).
 * @param attempt   - what differs between the first pass and a retry.
 */
export function createPassEnv(
  request: PassRequest,
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
export function resultTokens(env: PassEnv, messages: readonly ChatMessage[]): number {
  return countMessagesTokens([...messages], env.model) + env.systemPromptTokens;
}

/**
 * Whether a count is over the acceptance boundary.
 *
 * A window of 0 or less means "no window": nothing is over a boundary that does
 * not exist. (`budget.ts` asks the same question with a different finite check,
 * because it must also refuse `Infinity`; the two are deliberately not merged.)
 */
export function exceedsAcceptance(env: PassEnv, tokens: number): boolean {
  return env.request.numCtx > 0 && tokens > env.acceptanceBudget;
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
export interface ResultDraft {
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

/**
 * Builds the draft for a summary and a window, measuring it.
 *
 * @param env           - the pass.
 * @param summary       - the summary message the result starts with.
 * @param window        - the preserved window beside it.
 * @param windowSources - where each window row came from in the original window.
 * @param tokens        - the count, when the caller already has it (a retry's
 *                        own stats); measured here otherwise.
 */
export function draftResult(
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
export function withMessages(
  env: PassEnv,
  draft: ResultDraft,
  messages: ChatMessage[]
): ResultDraft {
  const tokens = resultTokens(env, messages);
  return { ...draft, messages, tokens, overBudget: exceedsAcceptance(env, tokens) };
}

/**
 * One distillation pass over a slice, charged to this pass's prefill budget.
 *
 * The CALL cap is the caller's to decide (`maxCalls`); the BUDGET is not — the
 * pass spends what is left of the compaction's one budget, and the charge is made
 * here so that no caller (there are three) can forget it.
 *
 * @param env            - the pass.
 * @param historyMessages - the slice to digest.
 * @param options        - the call cap, and the rows this pass must not touch.
 * @returns what the pass produced, and what it charged to the budget.
 */
export async function distillPass(
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
