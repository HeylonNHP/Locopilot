/**
 * Content compaction utility for Locopilot web tools.
 *
 * This module provides functionality to summarize or compact extracted web page
 * content when it exceeds the configured character limit. The compaction process
 * uses an LLM to intelligently summarize content while preserving valuable
 * elements like code snippets, tables, and structured data.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  APPROX_CHARS_PER_TOKEN,
  WEB_COMPACTION_MAX_CONCURRENT_REQUESTS,
  WEB_COMPACTION_REQUEST_TIMEOUT_MS,
  WEB_COMPACTION_RETRY_BASE_DELAY_MS,
  WEB_COMPACTION_RETRY_MAX_ATTEMPTS,
  WEB_COMPACTION_RETRY_MAX_DELAY_MS,
} from '@/constants';
import {
  type ChatMessage,
  type LlmRequestContext,
  sendLlmChatStream,
  type StreamChatParams,
} from '@/services/llm';
import { countCalibratedTextTokens, countMessagesTokens } from '@/services/tokenizer';
import { retryOnTransientError, type TransientRetryPolicy } from '@/services/transientRetry';
import { noopToolOutputSink, type ToolOutputSink } from '@/tools/toolOutput';
import { type WebExtractionSettings } from '@/tools/web/htmlExtractor';
import { ConcurrencyLimiter } from '@/util/concurrencyLimiter';
import { fillTemplate } from '@/util/fillTemplate';

/**
 * Prompt template for content compaction.
 * Instructs the LLM to preserve valuable content like code snippets
 * while summarizing other text to stay within the character limit.
 */
const COMPACTION_PROMPT_TEMPLATE = `
You are a content compaction assistant. Your task is to intelligently summarize
or compact the provided web page content while preserving its essential information
and value. The compacted version MUST be between {minCharLimit} and {charLimit}
characters long. Aim for approximately {charLimit} characters.

Guidelines:
1. Preserve verbatim (do not summarize or modify):
   - Code snippets (anything inside <code>, <pre>, or marked as code)
   - Tables and structured data
   - URLs and citations
   - Quotes and direct speech
   - Lists and enumerations

2. Summarize or compact:
   - Descriptive paragraphs
   - Introductory or concluding text
   - Redundant explanations
   - Boilerplate content

3. Always:
   - Maintain the original meaning and key facts
   - Keep the tone and style consistent
   - Ensure the compacted content is coherent and readable
   - Fill most of the allowed length; do not return a tiny summary unless the source is already short

Original content length: {originalLength} characters
Target length: approximately {charLimit} characters (minimum {minCharLimit} characters)
{retryNote}

Content to compact:
{content}

Provide only the compacted content, without any additional commentary or markup.
`;

const MAX_COMPACTION_ATTEMPTS = 3;
const MIN_COMPACTION_NUM_CTX = 4096;
const COMPACTION_CONTEXT_BUFFER_TOKENS = 256;
// Tightened from 1.2 → 1.05: the buffer used to give the model room for
// ~20% more output than the prompted target, which caused the first
// attempt to routinely overshoot the configured char limit and trigger
// a retry. Matching the buffer to the target lets a "good" summary
// land under the limit on the first pass.
const OUTPUT_TOKEN_BUFFER_RATIO = 1.05;
// On attempt 1 we ask the model for a target that's slightly below
// charLimit, so a summary aiming at the upper bound still lands under
// the hard check (`compactedContent.length <= limit`). Without this
// headroom, the prompt's "approximately charLimit" + a 20% buffer
// routinely produced >charLimit on the first pass.
const FIRST_ATTEMPT_TARGET_HEADROOM_RATIO = 0.05;
const RETRY_OUTPUT_SCALE_STEP = 0.1;
const MIN_RETRY_OUTPUT_SCALE = 0.8;
const MIN_CHARS_PER_TOKEN = 2;
const MAX_CHARS_PER_TOKEN = 6;

// Per-request scoped storage for the latest web-compaction debug output.
// This lets callers like /dump and /slash-commands access debug data
// without holding the compactor instance, while keeping data isolated
// across concurrent requests.
const compactionDebugStore = new AsyncLocalStorage<string[]>();

/**
 * Returns the most recent web-compaction debug lines from the current
 * request scope.  Falls back to an empty array if no compaction has run.
 */
export function getLastWebCompactionDebug(): string[] {
  return compactionDebugStore.getStore() ?? [];
}

/**
 * Computes the prompted upper bound (in chars) for the current compaction
 * attempt. This is the value the LLM is asked to "aim for" in the prompt,
 * and is also the basis for sizing `numPredict`. Sharing it between the
 * prompt and the budget keeps them consistent.
 *
 * - Attempt 1: charLimit minus a small headroom so a summary aiming at
 *   the upper bound of the prompted band still lands under the hard
 *   check (`compactedContent.length <= charLimit`).
 * - Retries: scale charLimit down by RETRY_OUTPUT_SCALE_STEP per attempt
 *   so the model is forced to produce progressively shorter output.
 */
function computeEffectiveCharLimit(charLimit: number, attempt: number): number {
  if (attempt === 1) {
    const headroom = Math.max(1, Math.ceil(charLimit * FIRST_ATTEMPT_TARGET_HEADROOM_RATIO));
    return Math.max(1, charLimit - headroom);
  }
  return Math.max(
    Math.floor(
      charLimit * Math.max(MIN_RETRY_OUTPUT_SCALE, 1 - (attempt - 1) * RETRY_OUTPUT_SCALE_STEP)
    ),
    Math.floor(charLimit * 0.5)
  );
}

/** Exported for unit tests (`tests/web-compaction-prompt.test.mjs`). */
export function buildCompactionPrompt(content: string, charLimit: number, attempt: number): string {
  const retryNote =
    attempt > 1
      ? `Retry guidance: this is pass ${attempt} of ${MAX_COMPACTION_ATTEMPTS}. Be more aggressive about removing boilerplate, repetition, and non-essential exposition while preserving facts, URLs, code, tables, and direct quotes.`
      : '';

  const effectiveCharLimit = computeEffectiveCharLimit(charLimit, attempt);
  const minCharLimit = Math.max(1, Math.floor(effectiveCharLimit * 0.85));

  return fillTemplate(COMPACTION_PROMPT_TEMPLATE, {
    charLimit: effectiveCharLimit,
    minCharLimit,
    originalLength: content.length,
    retryNote,
    content,
  });
}

/**
 * How many characters a token of THIS model's text is worth.
 *
 * ONE UNIT SYSTEM: the count is the CALIBRATED one, because the number this
 * feeds (the output budget, `numPredict`) is compared against a token budget
 * — the context window the provider enforces. A raw count is 25–40 % smaller
 * than the provider's own count of the same text, so a raw count here makes
 * the model believe a token is worth more characters than it is, asks for too
 * few output tokens, and the compacted page comes back truncated.
 *
 * The class is `summarise`: a web compaction request is a system prompt and
 * ONE big user message, which is the shape the `summarise` factor is
 * measured from.
 */
function estimateCharsPerToken(content: string, model: string): number {
  const tokenCount = countCalibratedTextTokens(content, model, 'summarise');
  if (tokenCount <= 0) {
    return APPROX_CHARS_PER_TOKEN;
  }

  return Math.max(MIN_CHARS_PER_TOKEN, Math.min(MAX_CHARS_PER_TOKEN, content.length / tokenCount));
}

function estimateCompactionContext(
  messages: ChatMessage[],
  model: string,
  content: string,
  charLimit: number,
  attempt: number
): { numCtx: number; numPredict: number } {
  // ONE UNIT SYSTEM: the prompt count and the chars-per-token ratio are both
  // calibrated counts of the SAME request shape, so `promptTokens +
  // numPredict` is a number of provider tokens — the unit the context window
  // is denominated in.
  const promptTokens = countMessagesTokens(messages, model, 'summarise');
  const charsPerToken = estimateCharsPerToken(content, model);

  // Size numPredict against the SAME prompted upper bound the model sees
  // in the compaction prompt, so the model's output capacity tracks the
  // target band instead of exceeding it. This is what lets a "good"
  // summary land under the hard limit on the first attempt.
  const effectiveCharLimit = computeEffectiveCharLimit(charLimit, attempt);

  const roughOutputTokens = Math.max(1, Math.ceil(effectiveCharLimit / charsPerToken));
  const numPredict = Math.max(1, Math.floor(roughOutputTokens * OUTPUT_TOKEN_BUFFER_RATIO));

  return {
    numCtx: Math.max(
      MIN_COMPACTION_NUM_CTX,
      promptTokens + numPredict + COMPACTION_CONTEXT_BUFFER_TOKENS
    ),
    numPredict,
  };
}

/**
 * The ONE limiter every web-page compaction request goes through, shared by
 * all queries of all `web_search` / `fetch_url` calls in the process. A
 * provider's rate limit belongs to the account, not to a query, so the cap has
 * to be process-wide.
 */
const sharedCompactionLimiter = new ConcurrencyLimiter(WEB_COMPACTION_MAX_CONCURRENT_REQUESTS);

const DEFAULT_RETRY_POLICY: TransientRetryPolicy = {
  maxAttempts: WEB_COMPACTION_RETRY_MAX_ATTEMPTS,
  baseDelayMs: WEB_COMPACTION_RETRY_BASE_DELAY_MS,
  maxDelayMs: WEB_COMPACTION_RETRY_MAX_DELAY_MS,
};

/**
 * What became of the text:
 * - `unchanged`: it was already within the limit.
 * - `compacted`: the model summarised it to within the limit.
 * - `truncated`: it was NOT summarised; the first `limit` characters were kept
 *   (the model call failed, timed out, or never got the text under the limit).
 *   The reader of the result must be told (`buildTruncationNote`).
 */
export type CompactionOutcome = 'unchanged' | 'compacted' | 'truncated';

export interface CompactionResult {
  text: string;
  outcome: CompactionOutcome;
  /** Why the text was truncated; set only when `outcome` is `truncated`. */
  reason?: string;
  originalLength: number;
  limit: number;
}

/**
 * The sentence appended to a page that was cut instead of summarised, so the
 * LLM knows the page is incomplete and how to get the rest.
 */
export function buildTruncationNote(result: CompactionResult): string {
  return (
    `[Note: this page was NOT summarised. Its ${result.originalLength} characters were cut to the first ${result.limit} ` +
    `because ${result.reason ?? 'compaction did not complete'}. The rest of the page is missing; ` +
    `call fetch_url with this page's URL and full_content=true if you need all of it.]`
  );
}

/** A compaction request that ran past `WEB_COMPACTION_REQUEST_TIMEOUT_MS`. */
class CompactionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the compaction request timed out after ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'CompactionTimeoutError';
  }
}

export interface ContentCompactorOptions {
  settings: WebExtractionSettings;
  /**
   * The resolved LLM context the compactor must use. It may target the
   * selected compaction provider rather than the main chat provider. It must
   * include the `provider` and `apiKey` so the right adapter is selected;
   * without `provider`, `selectLlmAdapter(undefined)` falls back to Ollama.
   * `baseUrl` is taken from this context, not `settings.baseUrl`, so the
   * compaction request uses the selected provider's endpoint and credentials.
   */
  llmRequestContext: LlmRequestContext;
  /** Replaceable for tests; defaults to the real streaming call. */
  streamChat?: typeof sendLlmChatStream;
  /** Replaceable for tests; defaults to the process-wide limiter. */
  limiter?: ConcurrencyLimiter;
  /** Replaceable for tests; defaults to the `WEB_COMPACTION_RETRY_*` constants. */
  retryPolicy?: TransientRetryPolicy;
  /** Replaceable for tests; defaults to `WEB_COMPACTION_REQUEST_TIMEOUT_MS`. */
  requestTimeoutMs?: number;
  /** Replaceable for tests; resolves true when the sleep was cut short by an abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
}

export class ContentCompactor {
  private readonly settings: WebExtractionSettings;
  private readonly llmRequestContext: LlmRequestContext;
  private readonly streamChat: typeof sendLlmChatStream;
  private readonly limiter: ConcurrencyLimiter;
  private readonly retryPolicy: TransientRetryPolicy;
  private readonly requestTimeoutMs: number;
  private readonly sleep: ContentCompactorOptions['sleep'];
  private debugLines: string[] = [];

  constructor(options: ContentCompactorOptions) {
    this.settings = options.settings;
    this.llmRequestContext = options.llmRequestContext;
    this.streamChat = options.streamChat ?? sendLlmChatStream;
    this.limiter = options.limiter ?? sharedCompactionLimiter;
    this.requestTimeoutMs = options.requestTimeoutMs ?? WEB_COMPACTION_REQUEST_TIMEOUT_MS;
    // An OpenAI-compatible adapter already retries a transient failure before
    // the error reaches us; retrying here too would multiply the attempts.
    this.retryPolicy =
      options.retryPolicy ??
      (options.llmRequestContext.provider === 'openai-compatible'
        ? { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 }
        : DEFAULT_RETRY_POLICY);
    this.sleep = options.sleep;
  }

  /**
   * Compacts content if it exceeds the character limit.
   * Returns the original content if it's within the limit, and the first
   * `limit` characters if compaction fails. Callers that must tell the reader
   * about that cut use `compact` instead.
   */
  async compactIfNeeded(content: string, signal?: AbortSignal): Promise<string> {
    const result = await this.compact(content, signal);
    return result.text;
  }

  /**
   * Like `compactIfNeeded`, but says what happened to the text, so a page that
   * was cut instead of summarised is never mistaken for a summary. An abort
   * (`signal`) is NOT a failure to fall back from: it rejects.
   */
  async compact(content: string, signal?: AbortSignal): Promise<CompactionResult> {
    const limit = this.settings.perPageCharLimit;
    const originalLength = content.length;
    if (limit <= 0 || content.length <= limit) {
      return { text: content, outcome: 'unchanged', originalLength, limit };
    }

    this.debugLines = [];
    let compactedContent = content;
    this.logCompactionRequested(content.length, limit);

    try {
      let previousLength = content.length;
      for (let attempt = 1; attempt <= MAX_COMPACTION_ATTEMPTS; attempt += 1) {
        compactedContent = await this.compactContent(compactedContent, attempt, signal);
        this.logCompactionAttempt(attempt, compactedContent.length);

        if (compactedContent.length <= limit) {
          this.logCompactionComplete(content.length, compactedContent.length);
          return { text: compactedContent, outcome: 'compacted', originalLength, limit };
        }

        if (compactedContent.length >= previousLength) {
          break;
        }

        previousLength = compactedContent.length;
      }

      const finalResult = compactedContent.slice(0, limit);
      this.logCompactionComplete(content.length, finalResult.length);
      return {
        text: finalResult,
        outcome: 'truncated',
        reason: 'the model could not bring the summary under the limit',
        originalLength,
        limit,
      };
    } catch (err) {
      if (signal?.aborted) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      this.output.writeLine(`Content compaction failed, returning truncated content: ${reason}`);
      // Any text that reached the catch is over the limit (a pass that landed
      // under it returned above), so it is always cut: the first pass's
      // failure leaves the page itself, a later one leaves an over-long summary.
      const finalResult = compactedContent.slice(0, limit);
      this.logCompactionComplete(content.length, finalResult.length);
      return {
        text: finalResult,
        outcome: 'truncated',
        reason: `summarising it failed (${reason})`,
        originalLength,
        limit,
      };
    } finally {
      compactionDebugStore.enterWith([...this.debugLines]);
    }
  }

  /**
   * Uses LLM to compact the content according to the compaction guidelines.
   */
  private async compactContent(
    content: string,
    attempt: number,
    signal: AbortSignal | undefined
  ): Promise<string> {
    const model = this.settings.compactionModel.trim();
    if (!model) {
      throw new Error('No compaction model configured for web content compaction');
    }

    const prompt = buildCompactionPrompt(content, this.settings.perPageCharLimit, attempt);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a helpful assistant that compacts content while preserving valuable information.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    const { numCtx, numPredict } = estimateCompactionContext(
      messages,
      model,
      content,
      this.settings.perPageCharLimit,
      attempt
    );

    // Force reasoning OFF for compaction. Models like gpt-5-nano otherwise
    // burn the entire maxOutputTokens budget on hidden chain-of-thought
    // (reasoning_tokens == maxOutputTokens) and stream zero visible content,
    // so compaction fails. `think: false` makes the adapter set
    // reasoning_effort="low" on the request, which suppresses the
    // hidden reasoning and produces real output tokens.
    const params: StreamChatParams = {
      model,
      messages,
      tools: [],
      numCtx,
      think: false,
      maxOutputTokens: numPredict,
    };

    const charLimit = this.settings.perPageCharLimit;
    const effectiveCharLimit = computeEffectiveCharLimit(charLimit, attempt);
    const minCharLimit = Math.max(1, Math.floor(effectiveCharLimit * 0.85));

    this.output.writeLine(
      `Web content compaction prompt: model=${model} numCtx=${numCtx} maxOutputTokens=${numPredict} (~${numPredict * 4} chars) promptTokens=${countMessagesTokens(messages, model, 'summarise')} targetBand=${minCharLimit}..${effectiveCharLimit} chars (hardLimit=${charLimit})`
    );

    // The slot is taken per REQUEST attempt and given back during a retry's
    // backoff sleep, so a rate-limited provider is not kept saturated by
    // requests that are only waiting.
    return await retryOnTransientError(
      (retryAttempt) =>
        this.limiter.run(() => this.requestWithDeadline(params, signal, retryAttempt), signal),
      {
        ...this.retryPolicy,
        signal,
        ...(this.sleep ? { sleep: this.sleep } : {}),
        onRetry: ({ attempt: n, maxAttempts, delayMs, status }) =>
          this.logCompactionLine(
            `Web content compaction: provider answered ${status ?? 'a transient error'}; retry ${n}/${maxAttempts - 1} in ${delayMs} ms.`
          ),
      }
    );
  }

  /**
   * One request, cut off after `requestTimeoutMs`. The deadline is a wall-clock
   * cap on the whole request, including the stream; the adapter's own
   * `timeoutMs` only covers a silent socket. Aborting the stream can end the
   * iteration quietly with a PARTIAL text, so the deadline is checked after it.
   */
  private async requestWithDeadline(
    params: StreamChatParams,
    signal: AbortSignal | undefined,
    retryAttempt: number
  ): Promise<string> {
    if (retryAttempt > 1) {
      this.recordDebugLine(`Web content compaction: request attempt ${retryAttempt}.`);
    }
    const deadline = AbortSignal.timeout(this.requestTimeoutMs);
    const requestParams: StreamChatParams = {
      ...params,
      timeoutMs: this.requestTimeoutMs,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    };
    try {
      const text = await this.streamCompactionResponse(requestParams);
      if (deadline.aborted && !signal?.aborted) throw new CompactionTimeoutError(this.requestTimeoutMs);
      return text;
    } catch (err) {
      if (deadline.aborted && !signal?.aborted) throw new CompactionTimeoutError(this.requestTimeoutMs);
      throw err;
    }
  }

  private async streamCompactionResponse(params: StreamChatParams): Promise<string> {
    try {
      return await this.runCompactionStream(params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Some providers reject `reasoning_effort` for non-reasoning models
      // (e.g. Airia returning 400 for gpt-5-nano). Retry once with the
      // thinking flag dropped so the adapter omits `reasoning_effort`.
      if (params.think === false && /400|reasoning|unsupported/i.test(message)) {
        this.recordDebugLine(
          `Web content compaction: provider rejected reasoning_effort (${message}); retrying without it.`
        );
        const fallbackParams: StreamChatParams = { ...params };
        delete (fallbackParams as { think?: boolean }).think;
        return await this.runCompactionStream(fallbackParams);
      }
      throw err;
    }
  }

  private async runCompactionStream(params: StreamChatParams): Promise<string> {
    let compactedText = '';
    let reasoningText = '';
    let chunkCount = 0;
    let lastChunkDebug = 'none';
    // Use the LlmRequestContext the compactor was constructed with. It
    // carries the right provider + apiKey + baseUrl for the current
    // request, so the adapter is selected correctly and the Authorization
    // header (openai-compatible) matches the rest of the request.
    for await (const chunk of this.streamChat(this.llmRequestContext, params)) {
      chunkCount += 1;
      const thinking = chunk.message?.thinking ?? '';
      const content = chunk.message?.content ?? '';
      const toolCalls = chunk.message?.tool_calls;
      lastChunkDebug = JSON.stringify({
        hasContent: content.length > 0,
        contentLen: content.length,
        hasThinking: thinking.length > 0,
        thinkingLen: thinking.length,
        hasToolCalls: (toolCalls?.length ?? 0) > 0,
        done: chunk.done,
        doneReason: chunk.done_reason,
        model: chunk.model,
      });

      if (thinking.length > 0) {
        this.recordDebugLine(`Web content compaction thinking chunk:\n${thinking}`);
        reasoningText += thinking;
      }

      if (!content) {
        continue;
      }
      compactedText += content;
      this.recordDebugLine(`Web content compaction generating: ${compactedText.length} chars`);
    }

    this.recordDebugLine(
      `Web content compaction stream ended: ${chunkCount} chunks, last chunk ${lastChunkDebug}`
    );

    // Some providers/models (e.g. OpenAI-compatible reasoning models) stream
    // their output as `reasoning_content` with an empty `content` field.
    // Preserve that output as the compacted text so compaction doesn't fail.
    if (!compactedText.trim() && reasoningText.trim()) {
      this.recordDebugLine(
        'Web content compaction: model returned reasoning content only; using it as compacted text.'
      );
      return reasoningText.trim();
    }

    const trimmed = compactedText.trim();
    if (!trimmed) {
      throw new Error('No content received from LLM for compaction');
    }

    return trimmed;
  }

  private logCompactionRequested(originalLength: number, limit: number): void {
    this.logCompactionLine(
      `Web content compaction requested: ${originalLength} chars -> ${limit} chars`
    );
  }

  private logCompactionAttempt(attempt: number, currentLength: number): void {
    this.logCompactionLine(`Web content compaction attempt ${attempt}: ${currentLength} chars`);
  }

  private logCompactionLine(message: string): void {
    this.recordDebugLine(message);
    this.output.writeLine(message);
  }

  private recordDebugLine(line: string): void {
    this.debugLines.push(line);
  }

  private logCompactionComplete(originalLength: number, finalLength: number): void {
    this.logCompactionLine(
      `Web content compaction complete: ${originalLength} -> ${finalLength} chars`
    );
  }

  /**
   * Creates a new ContentCompactor instance with the provided settings.
   *
   * The caller must pass the resolved `LlmRequestContext` for the
   * compaction request. The compactor reuses that context so it hits the
   * selected compaction provider's endpoint with its credentials.
   */
  static create(
    settings: WebExtractionSettings,
    llmRequestContext: LlmRequestContext,
    overrides: Omit<ContentCompactorOptions, 'settings' | 'llmRequestContext'> = {}
  ): ContentCompactor {
    return new ContentCompactor({ settings, llmRequestContext, ...overrides });
  }

  private get output(): ToolOutputSink {
    return this.settings.output ?? noopToolOutputSink;
  }
}
