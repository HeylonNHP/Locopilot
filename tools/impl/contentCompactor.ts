/**
 * Content compaction utility for Locopilot web tools.
 *
 * This module provides functionality to summarize or compact extracted web page
 * content when it exceeds the configured character limit. The compaction process
 * uses an LLM to intelligently summarize content while preserving valuable
 * elements like code snippets, tables, and structured data.
 */

import { type WebExtractionSettings } from '../htmlExtractor.js';
import { sendLlmChat, sendLlmChatStream, type ChatMessage, type ChatParams, type StreamChatParams } from '../../services/llm.js';
import { countMessagesTokens } from '../../tokenizer.js';

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

function buildCompactionPrompt(content: string, charLimit: number, attempt: number): string {
    const retryNote = attempt > 1
        ? `Retry guidance: this is pass ${attempt} of ${MAX_COMPACTION_ATTEMPTS}. Be more aggressive about removing boilerplate, repetition, and non-essential exposition while preserving facts, URLs, code, tables, and direct quotes.`
        : '';

    return COMPACTION_PROMPT_TEMPLATE
        .replace('{charLimit}', String(charLimit))
        .replace('{originalLength}', String(content.length))
        .replace('{retryNote}', retryNote)
        .replace('{content}', content);
}

function estimateCompactionContext(messages: ChatMessage[], model: string, charLimit: number): { numCtx: number; numPredict: number } {
    const promptTokens = countMessagesTokens(messages, model);
    const numPredict = Math.max(1, Math.floor(charLimit));

    return {
        numCtx: Math.max(MIN_COMPACTION_NUM_CTX, promptTokens + numPredict + COMPACTION_CONTEXT_BUFFER_TOKENS),
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
        } catch (error) {
            console.warn('Content compaction failed, returning truncated content:', error instanceof Error ? error.message : String(error));
            const finalResult = compactedContent.length <= limit ? compactedContent : compactedContent.slice(0, limit);
            this.logCompactionComplete(content.length, finalResult.length);
            return finalResult;
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
                content: 'You are a helpful assistant that compacts content while preserving valuable information.'
            },
            {
                role: 'user',
                content: prompt
            }
        ];

        const { numCtx, numPredict } = estimateCompactionContext(messages, model, this.settings.perPageCharLimit);

        const params: StreamChatParams = {
            model,
            messages: messages,
            tools: [],
            numCtx,
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
        console.log(`Web content compaction requested: ${originalLength} chars -> ${limit} chars`);
    }

    private logCompactionAttempt(attempt: number, currentLength: number): void {
        console.log(`Web content compaction attempt ${attempt}: ${currentLength} chars`);
    }

    private logCompactionProgress(currentLength: number): void {
        const line = `Web content compaction generating: ${currentLength} chars`;

        if (process.stdout.isTTY) {
            process.stdout.cursorTo(0);
            process.stdout.clearLine(0);
            process.stdout.write(line);
            return;
        }

        process.stdout.write(`${line}\n`);
    }

    private clearCompactionProgressLine(): void {
        if (!process.stdout.isTTY) {
            return;
        }

        process.stdout.cursorTo(0);
        process.stdout.clearLine(0);
    }

    private logCompactionComplete(originalLength: number, finalLength: number): void {
        console.log(`Web content compaction complete: ${originalLength} -> ${finalLength} chars`);
    }

    /**
     * Creates a new ContentCompactor instance with the provided settings.
     */
    static create(settings: WebExtractionSettings, baseUrl: string): ContentCompactor {
        return new ContentCompactor({ settings, baseUrl });
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
    compactionModel: string,
): Promise<string> {
    if (content.length <= charLimit) {
        return content;
    }

    const compactor = new ContentCompactor({
        settings: {
            requestTimeoutMs: timeoutMs,
            perPageCharLimit: charLimit,
            baseUrl: baseUrl, // REQUIRED - no defaults
            compactionModel,
        },
        baseUrl: baseUrl
    });

    return compactor.compactIfNeeded(content);
}