/**
 * Content compaction utility for Locopilot web tools.
 *
 * This module provides functionality to summarize or compact extracted web page
 * content when it exceeds the configured character limit. The compaction process
 * uses an LLM to intelligently summarize content while preserving valuable
 * elements like code snippets, tables, and structured data.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { APPROX_CHARS_PER_TOKEN } from '@/constants';
import { countMessagesTokens, countTextTokens } from '@/services/tokenizer';

import {
  buildLlmRequestContext,
  type ChatMessage,
  type LlmRequestContext,
  sendLlmChatStream,
  type StreamChatParams,
} from '../../services/llm';
import { noopToolOutputSink, type ToolOutputSink } from '../toolOutput';
import { type WebExtractionSettings } from '../web/htmlExtractor';

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
    Math.floor(charLimit * Math.max(MIN_RETRY_OUTPUT_SCALE, 1 - (attempt - 1) * RETRY_OUTPUT_SCALE_STEP)),
    Math.floor(charLimit * 0.5)
  );
}

function buildCompactionPrompt(content: string, charLimit: number, attempt: number): string {
  const retryNote =
    attempt > 1
      ? `Retry guidance: this is pass ${attempt} of ${MAX_COMPACTION_ATTEMPTS}. Be more aggressive about removing boilerplate, repetition, and non-essential exposition while preserving facts, URLs, code, tables, and direct quotes.`
      : '';

  const effectiveCharLimit = computeEffectiveCharLimit(charLimit, attempt);
  const minCharLimit = Math.max(1, Math.floor(effectiveCharLimit * 0.85));

  return COMPACTION_PROMPT_TEMPLATE.replace('{charLimit}', String(effectiveCharLimit))
    .replace('{minCharLimit}', String(minCharLimit))
    .replace('{originalLength}', String(content.length))
    .replace('{retryNote}', retryNote)
    .replace('{content}', content);
}

function estimateCharsPerToken(content: string, model: string): number {
  const tokenCount = countTextTokens(content, model);
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
  const promptTokens = countMessagesTokens(messages, model);
  const charsPerToken = estimateCharsPerToken(content, model);

  // Size numPredict against the SAME prompted upper bound the model sees
  // in the compaction prompt, so the model's output capacity tracks the
  // target band instead of exceeding it. This is what lets a "good"
  // summary land under the hard limit on the first attempt.
  const effectiveCharLimit = computeEffectiveCharLimit(charLimit, attempt);

  const roughOutputTokens = Math.max(1, Math.ceil(effectiveCharLimit / charsPerToken));
  const numPredict = Math.max(
    1,
    Math.floor(roughOutputTokens * OUTPUT_TOKEN_BUFFER_RATIO)
  );

  return {
    numCtx: Math.max(
      MIN_COMPACTION_NUM_CTX,
      promptTokens + numPredict + COMPACTION_CONTEXT_BUFFER_TOKENS
    ),
    numPredict,
  };
}

export interface ContentCompactorOptions {
  settings: WebExtractionSettings;
  baseUrl: string; // REQUIRED - always from config, never optional
}

export class ContentCompactor {
  private readonly settings: WebExtractionSettings;
  private readonly baseUrl: string;
  private debugLines: string[] = [];

  constructor(options: ContentCompactorOptions) {
    this.settings = options.settings;
    this.baseUrl = options.baseUrl;
  }

  /**
   * Compacts content if it exceeds the character limit.
   * Returns the original content if it's within the limit or if compaction fails.
   */
  async compactIfNeeded(content: string): Promise<string> {
    const limit = this.settings.perPageCharLimit;
    if (limit <= 0 || content.length <= limit) {
      return content;
    }

    // ── Skip-when-unconfigured guard ─────────────────────────────────
    // The web content compactor needs a valid `compactionModel` and
    // `baseUrl` to make its LLM call. If either is empty, the LLM
    // request would 404 (or hit the wrong provider) and `compactContent`
    // would throw — the catch below would still recover, but the LLM
    // round-trip is wasted and the user sees a noisy failure log. Skip
    // the LLM call entirely and degrade to a hard slice so the page is
    // still returned within the per-page budget. This is the last line
    // of defence: the upstream tool registry
    // (`src/tools/toolRegistry.ts`) already tries to inherit a real
    // baseUrl/compactionModel from the per-request subAgent config.
    const compactionModel = this.settings.compactionModel?.trim() ?? '';
    const baseUrl = this.settings.baseUrl?.trim() ?? '';
    if (!compactionModel || !baseUrl) {
      this.debugLines = [];
      this.logCompactionRequested(content.length, limit);
      this.logCompactionLine(
        `Web content compaction skipped: compactionModel or baseUrl not configured; falling back to hard truncation.`
      );
      const truncated = content.slice(0, limit);
      this.logCompactionComplete(content.length, truncated.length);
      compactionDebugStore.enterWith([...this.debugLines]);
      return truncated;
    }

    this.debugLines = [];
    let compactedContent = content;
    this.logCompactionRequested(content.length, limit);

    try {
      let previousLength = content.length;
      for (let attempt = 1; attempt <= MAX_COMPACTION_ATTEMPTS; attempt += 1) {
        compactedContent = await this.compactContent(compactedContent, attempt);
        this.logCompactionAttempt(attempt, compactedContent.length);

        if (compactedContent.length <= limit) {
          this.logCompactionComplete(content.length, compactedContent.length);
          return compactedContent;
        }

        if (compactedContent.length >= previousLength) {
          break;
        }

        previousLength = compactedContent.length;
      }

      const finalResult = compactedContent.slice(0, limit);
      this.logCompactionComplete(content.length, finalResult.length);
      return finalResult;
    } catch (err) {
      this.output.writeLine(
        `Content compaction failed, returning truncated content: ${err instanceof Error ? err.message : String(err)}`
      );
      const finalResult =
        compactedContent.length <= limit ? compactedContent : compactedContent.slice(0, limit);
      this.logCompactionComplete(content.length, finalResult.length);
      return finalResult;
    } finally {
      compactionDebugStore.enterWith([...this.debugLines]);
    }
  }

  /**
   * Uses LLM to compact the content according to the compaction guidelines.
   */
  private async compactContent(content: string, attempt: number): Promise<string> {
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
      timeoutMs: this.settings.requestTimeoutMs,
      maxOutputTokens: numPredict,
    };

    const charLimit = this.settings.perPageCharLimit;
    const effectiveCharLimit = computeEffectiveCharLimit(charLimit, attempt);
    const minCharLimit = Math.max(1, Math.floor(effectiveCharLimit * 0.85));

    this.output.writeLine(
      `Web content compaction prompt: model=${model} numCtx=${numCtx} maxOutputTokens=${numPredict} (~${numPredict * 4} chars) promptTokens=${countMessagesTokens(messages, model)} targetBand=${minCharLimit}..${effectiveCharLimit} chars (hardLimit=${charLimit})`
    );

    return await this.streamCompactionResponse(params);
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
    // Use the LlmRequestContext threaded through the ContentCompactor's
    // own baseUrl. We build the context here so the per-request
    // Authorization header (openai-compatible) is the right one.
    const compactorContext: LlmRequestContext = buildLlmRequestContext({
      baseUrl: this.baseUrl,
    });
    for await (const chunk of sendLlmChatStream(compactorContext, params)) {
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

    this.recordDebugLine(`Web content compaction stream ended: ${chunkCount} chunks, last chunk ${lastChunkDebug}`);

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
   */
  static create(settings: WebExtractionSettings, baseUrl: string): ContentCompactor {
    return new ContentCompactor({ settings, baseUrl });
  }

  private get output(): ToolOutputSink {
    return this.settings.output ?? noopToolOutputSink;
  }
}