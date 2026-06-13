/**
 * Content compaction utility for Locopilot web tools.
 *
 * This module provides functionality to summarize or compact extracted web page
 * content when it exceeds the configured character limit. The compaction process
 * uses an LLM to intelligently summarize content while preserving valuable
 * elements like code snippets, tables, and structured data.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { APPROX_CHARS_PER_TOKEN } from '../../constants';
import { type ChatMessage, sendLlmChatStream, type StreamChatParams } from '../../services/llm';
import { countMessagesTokens, countTextTokens } from '../../services/tokenizer';
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
and value. The compacted version must not exceed {charLimit} characters.

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

Original content length: {originalLength} characters
Target maximum length: {charLimit} characters
{retryNote}

Content to compact:
{content}

Provide only the compacted content, without any additional commentary or markup.
`;

const MAX_COMPACTION_ATTEMPTS = 3;
const MIN_COMPACTION_NUM_CTX = 4096;
const COMPACTION_CONTEXT_BUFFER_TOKENS = 256;
const OUTPUT_TOKEN_BUFFER_RATIO = 1.2;
const INITIAL_OUTPUT_SCALE = 0.9;
const RETRY_OUTPUT_SCALE_STEP = 0.1;
const MIN_RETRY_OUTPUT_SCALE = 0.8;
const MIN_CHARS_PER_TOKEN = 2;
const MAX_CHARS_PER_TOKEN = 6;

interface WebCompactionDebugEntry {
  id: number;
  lines: string[];
  timestamp: number;
}

const MAX_DEBUG_ENTRIES = 10;

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

function buildCompactionPrompt(content: string, charLimit: number, attempt: number): string {
  const retryNote =
    attempt > 1
      ? `Retry guidance: this is pass ${attempt} of ${MAX_COMPACTION_ATTEMPTS}. Be more aggressive about removing boilerplate, repetition, and non-essential exposition while preserving facts, URLs, code, tables, and direct quotes.`
      : '';

  return COMPACTION_PROMPT_TEMPLATE.replace('{charLimit}', String(charLimit))
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
  const roughOutputTokens = Math.max(1, Math.ceil(charLimit / charsPerToken));
  const attemptScale = Math.max(
    MIN_RETRY_OUTPUT_SCALE,
    INITIAL_OUTPUT_SCALE - (attempt - 1) * RETRY_OUTPUT_SCALE_STEP
  );
  const overflowScale =
    content.length > charLimit ? Math.max(MIN_RETRY_OUTPUT_SCALE, charLimit / content.length) : 1;
  const numPredict = Math.max(
    1,
    Math.floor(roughOutputTokens * OUTPUT_TOKEN_BUFFER_RATIO * attemptScale * overflowScale)
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
  private debugLog: WebCompactionDebugEntry[] = [];
  private nextDebugId = 1;

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
      this.debugLog.push({
        id: this.nextDebugId++,
        lines: [...this.debugLines],
        timestamp: Date.now(),
      });
      if (this.debugLog.length > MAX_DEBUG_ENTRIES) {
        this.debugLog.shift();
      }
      // Publish the latest debug lines into the request-scoped store
      // so callers like /dump can read them without holding the instance.
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

    const params: StreamChatParams = {
      model,
      messages,
      tools: [],
      numCtx,
      think: false,
      timeoutMs: this.settings.requestTimeoutMs,
      options: {
        temperature: 0,
        num_predict: numPredict,
      },
    };

    return await this.streamCompactionResponse(params);
  }

  private async streamCompactionResponse(params: StreamChatParams): Promise<string> {
    let compactedText = '';
    try {
      for await (const chunk of sendLlmChatStream(this.baseUrl, params)) {
        const thinking = chunk.message?.thinking ?? '';
        if (thinking.length > 0) {
          this.recordDebugLine(`Web content compaction thinking chunk:\n${thinking}`);
        }

        const content = chunk.message?.content ?? '';
        if (!content) {
          continue;
        }
        compactedText += content;
        this.logCompactionProgress(compactedText.length);
      }
    } finally {
      this.clearCompactionProgressLine();
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

  private logCompactionProgress(currentLength: number): void {
    const line = `Web content compaction generating: ${currentLength} chars`;
    this.recordDebugLine(line);

    if (process.stdout.isTTY) {
      this.output.clearInline();
      this.output.writeInline(line);
      return;
    }

    this.output.writeLine(line);
  }

  private logCompactionLine(message: string): void {
    this.recordDebugLine(message);
    this.clearCompactionProgressLine();
    this.output.writeLine(message);
  }

  private recordDebugLine(line: string): void {
    this.debugLines.push(line);
  }

  private clearCompactionProgressLine(): void {
    this.output.clearInline();
  }

  private logCompactionComplete(originalLength: number, finalLength: number): void {
    this.logCompactionLine(
      `Web content compaction complete: ${originalLength} -> ${finalLength} chars`
    );
  }

  getLastWebCompactionDebug(): string[] {
    const last = this.debugLog.at(-1);
    return last ? [...last.lines] : [];
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

/**
 * Standalone function to compact content using default settings.
 * Useful for one-off compaction needs.
 */
export async function compactContent(
  content: string,
  charLimit: number,
  timeoutMs: number = 30000,
  baseUrl: string, // REQUIRED - must be provided by caller
  compactionModel: string
): Promise<string> {
  if (content.length <= charLimit) {
    return content;
  }

  const compactor = new ContentCompactor({
    settings: {
      requestTimeoutMs: timeoutMs,
      perPageCharLimit: charLimit,
      baseUrl, // REQUIRED - no defaults
      compactionModel,
    },
    baseUrl,
  });

  return compactor.compactIfNeeded(content);
}
