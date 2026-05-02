/**
 * compact.ts
 *
 * Provides the /compact command for Locopilot.
 *
 * Sends the current conversation history to the LLM and asks it to produce a
 * concise summary that preserves all important context. The resulting summary
 * replaces the live message history so that future turns consume less of the
 * model's context window. A preamble is injected into the summarised history
 * so the model understands it is receiving a condensed record rather than a
 * verbatim transcript.
 *
 * This compaction will preserve the most recent user prompt verbatim, summarise
 * older history, and retry once with a stronger compression factor if the
 * first pass still leaves the history too large for the model.
 */

import chalk from 'chalk';
import { sendLlmChat, sendLlmChatStream, getLlmTurnStats } from './llm';
import type { ChatMessage } from './llm';
import { countMessagesTokens } from './tokenizer';

// The instruction sent to the LLM when asking it to compact the history.
function buildCompactSystemPrompt(params: {
    targetSummaryTokens: number;
    minSummaryTokens: number;
    maxSummaryTokens: number;
    preservedRecentTokens: number;
    numCtx: number;
}): string {
    return (
        'You are a conversation summariser. You will be given OLDER conversation history from a ' +
        'chat session between a user and an AI assistant. NEWER recent turns are preserved verbatim ' +
        `outside this summary (${params.preservedRecentTokens} estimated tokens).\n` +
        'Produce one dense narrative summary that:\n' +
        '  1. Retains every decision, fact, file path, code snippet, command, result, and unresolved task ' +
        'that could affect future responses.\n' +
        '  2. Keeps chronology and causality clear (what happened, why, and what the latest status is).\n' +
        '  3. Strips only filler/repetition; do NOT over-compress technical details.\n' +
        '  4. Is written in third person (e.g. "The user asked... The assistant explained...").\n' +
        `  5. Targets approximately ${params.targetSummaryTokens} tokens (acceptable range: ${params.minSummaryTokens}-${params.maxSummaryTokens}) within a context window of ${params.numCtx} tokens.\n` +
        '  6. Never exceed the max token range unless required to avoid losing critical technical facts.\n' +
        'Prefer detail over brevity when details are technical and likely to matter later.\n' +
        'Return ONLY plain summary text (no headings, no markdown, no commentary).'
    );
}

// The instruction used to distill large tool outputs before running full
// conversation compaction.
const TOOL_DISTILL_SYSTEM_PROMPT =
    'You are a tool-output distiller. You will be given one tool result from an AI chat. ' +
    'Produce a compact, loss-minimised digest that preserves durable technical value.\n' +
    'Keep: concrete facts, file paths, URLs, commands, exit codes, errors, versions, and final outcomes.\n' +
    'Drop: boilerplate formatting, duplicated lines, verbose prose, and filler.\n' +
    'If this output is already concise, return a near-verbatim version.\n' +
    'Write plain text only (no markdown).';

const TOOL_DISTILL_CHAR_THRESHOLD = 1200;
const TOOL_DISTILL_MAX_CHARS = 2400;
const TOOL_DISTILL_NUM_PREDICT = 1024;
const MIN_SUMMARISE_TOKENS = 200;
const PRESERVE_RECENT_TOKENS_RATIO = 0.12;
const SUMMARY_TARGET_TOKENS_RATIO = 0.10;
const SUMMARY_MAX_TOKENS_RATIO = 0.18;
const SUMMARY_NUM_PREDICT_BUFFER_RATIO = 1.20;

// Compacted result must fit within this fraction of numCtx to be accepted
// without triggering an automatic aggressive retry pass.
const COMPACT_ACCEPTANCE_HEADROOM = 0.90;

// Preamble injected at the start of the compacted history so the model knows
// it is reading a summary rather than a live transcript.
const SUMMARY_PREAMBLE =
    '[This conversation history has been compacted. What follows is a concise ' +
    'summary of everything important that has occurred so far. Treat it as ' +
    'authoritative context for continuing the conversation.]';

export interface CompactStats {
    oldTokenCount: number;
    newTokenCount: number;
}

export interface CompactResult {
    /** The new, compacted message array that should replace the live history. */
    newMessages: ChatMessage[];
    /** Token counts for display purposes. */
    stats: CompactStats;
}

interface HistorySplit {
    messagesToSummarise: ChatMessage[];
    preservedRecentMessages: ChatMessage[];
    preservedRecentTokens: number;
}

async function measureConversationTokens(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    numCtx: number,
    onProgress?: (message: string) => void,
): Promise<number> {
    onProgress?.('Measuring conversation tokens...');
    
    try {
        // Use a significantly larger context window for the measurement call
        // to avoid Status 400 errors when the history is already at 100% capacity.
        const measurementCtx = Math.max(numCtx * 2, 32768);
        
        const response = await sendLlmChat(baseUrl, {
            model,
            messages,
            tools: [],
            numCtx: measurementCtx,
            options: {
                num_predict: 1, // Set to 1 to minimize generation overhead
                temperature: 0,
            },
        });

        const stats = getLlmTurnStats(response);
        if (stats) {
            return stats.promptEvalCount + stats.evalCount;
        }
    } catch (err) {
        // If the API call fails (e.g. backend is very strict), fall back to 
        // the local tiktoken estimate instead of crashing.
        onProgress?.('API measurement failed; falling back to local estimate...');
    }

    return countMessagesTokens(messages, model);
}

function clamp(value: number, minValue: number, maxValue: number): number {
    return Math.max(minValue, Math.min(maxValue, value));
}

function computeRecentMessageFloor(numCtx: number): number {
    return clamp(Math.round(numCtx / 32768) + 2, 2, 8);
}

/** Returns the index of the most recent `role === 'user'` message, or -1 if none. */
function findLatestUserMessageIndex(messages: ChatMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') return i;
    }
    return -1;
}

function splitHistoryForCompaction(
    historyMessages: ChatMessage[],
    model: string,
    numCtx: number,
    aggressiveFactor: number = 1.0,
): HistorySplit {
    if (historyMessages.length <= 1) {
        return {
            messagesToSummarise: historyMessages,
            preservedRecentMessages: [],
            preservedRecentTokens: 0,
        };
    }

    const preserveRecentTokenBudget = clamp(
        Math.floor(numCtx * PRESERVE_RECENT_TOKENS_RATIO / aggressiveFactor),
        Math.max(300, Math.floor(numCtx * 0.03 / aggressiveFactor)),
        Math.floor(numCtx * 0.30 / aggressiveFactor),
    );
    const minMessagesToSummarise = Math.min(
        Math.max(1, Math.ceil(historyMessages.length * 0.25)),
        historyMessages.length - 1,
    );
    const maxPreservedMessages = Math.max(1, historyMessages.length - minMessagesToSummarise);
    const preserveRecentMessageFloor = Math.min(
        Math.max(1, Math.floor(computeRecentMessageFloor(numCtx) / aggressiveFactor)),
        maxPreservedMessages,
    );

    const preservedFromEnd: ChatMessage[] = [];
    let preservedRecentTokens = 0;

    for (let index = historyMessages.length - 1; index >= 0; index -= 1) {
        if (index === 0) {
            break;
        }

        const message = historyMessages[index];
        if (!message) {
            continue;
        }

        if (preservedFromEnd.length >= maxPreservedMessages) {
            break;
        }

        const estimatedMessageTokens = countMessagesTokens([message], model);
        const meetsFloor = preservedFromEnd.length >= preserveRecentMessageFloor;
        const meetsBudget = preservedRecentTokens >= preserveRecentTokenBudget;

        if (meetsFloor && meetsBudget) {
            break;
        }

        preservedFromEnd.push(message);
        preservedRecentTokens += estimatedMessageTokens;
    }

    const windowSplitIndex = historyMessages.length - preservedFromEnd.length;
    const windowPreservedMessages = preservedFromEnd.reverse();

    // ── Latest-user-message anchor ────────────────────────────────────────
    // The most recent user message is a hard anchor: it must always appear in
    // preservedRecentMessages (verbatim) and must never be summarised.
    const latestUserIndex = findLatestUserMessageIndex(historyMessages);

    // If the anchor is already inside the preserved window (or there is no user
    // message at all), the normal result is correct — return it directly.
    if (latestUserIndex < 0 || latestUserIndex >= windowSplitIndex) {
        return {
            messagesToSummarise: historyMessages.slice(0, windowSplitIndex),
            preservedRecentMessages: windowPreservedMessages,
            preservedRecentTokens: countMessagesTokens(windowPreservedMessages, model),
        };
    }

    // The user prompt sits in the "to-summarise" portion — it must be rescued.
    const anchorMessage = historyMessages[latestUserIndex]!;
    const prePromptMessages = historyMessages.slice(0, latestUserIndex);
    const postPromptPreWindowMessages = historyMessages.slice(latestUserIndex + 1, windowSplitIndex);

    // Try A: summarise only the pre-prompt history (cleanest split).
    if (countMessagesTokens(prePromptMessages, model) >= MIN_SUMMARISE_TOKENS) {
        const preservedMessages = [anchorMessage, ...windowPreservedMessages];
        return {
            messagesToSummarise: prePromptMessages,
            preservedRecentMessages: preservedMessages,
            preservedRecentTokens: countMessagesTokens(preservedMessages, model),
        };
    }

    // Try B: pre-prompt content alone is too small. Also fold in the post-prompt
    // assistant/tool messages that sit between the anchor and the sliding-window
    // boundary. The user prompt itself is still held out verbatim.
    const combinedToSummarise = [...prePromptMessages, ...postPromptPreWindowMessages];
    if (countMessagesTokens(combinedToSummarise, model) >= MIN_SUMMARISE_TOKENS) {
        const preservedMessages = [anchorMessage, ...windowPreservedMessages];
        return {
            messagesToSummarise: combinedToSummarise,
            preservedRecentMessages: preservedMessages,
            preservedRecentTokens: countMessagesTokens(preservedMessages, model),
        };
    }

    // Fallback: still not enough. Return the pre-prompt slice; the caller's
    // MIN_SUMMARISE_TOKENS guard will decide whether to abort or expand.
    const preservedMessages = [anchorMessage, ...windowPreservedMessages];
    return {
        messagesToSummarise: prePromptMessages,
        preservedRecentMessages: preservedMessages,
        preservedRecentTokens: countMessagesTokens(preservedMessages, model),
    };
    // ── End anchor adjustment ─────────────────────────────────────────────
}

function getToolMessageName(message: ChatMessage): string {
    const firstToolCall = message.tool_calls?.[0];
    const name = firstToolCall?.function?.name;
    return typeof name === 'string' && name.trim().length > 0
        ? name.trim()
        : 'unknown_tool';
}

async function distillToolMessages(
    baseUrl: string,
    model: string,
    historyMessages: ChatMessage[],
    numCtx: number,
    onProgress?: (message: string) => void,
): Promise<ChatMessage[]> {
    const distilledMessages: ChatMessage[] = [];

    for (let index = 0; index < historyMessages.length; index += 1) {
        const message = historyMessages[index];
        if (!message) {
            continue;
        }

        const shouldDistill =
            message.role === 'tool' &&
            (message.content?.length ?? 0) >= TOOL_DISTILL_CHAR_THRESHOLD;

        if (!shouldDistill) {
            distilledMessages.push(message);
            continue;
        }

        const previous = historyMessages[index - 1];
        const toolName = previous ? getToolMessageName(previous) : 'unknown_tool';
        const input =
            `Tool name: ${toolName}\n` +
            `Tool output length: ${message.content.length} chars\n\n` +
            'Tool output:\n' +
            message.content;

        let distilledContent = '';
        const distillResponse = await sendLlmChat(baseUrl, {
            model,
            messages: [
                { role: 'system', content: TOOL_DISTILL_SYSTEM_PROMPT },
                { role: 'user', content: input },
            ],
            tools: [],
            numCtx,
            options: {
                temperature: 0,
                num_predict: TOOL_DISTILL_NUM_PREDICT,
            },
        }, (chunk) => {
            if (chunk.message?.content) {
                distilledContent += chunk.message.content;
                onProgress?.(
                    `Distilling tool output ${index + 1}/${historyMessages.length} (${toolName})... (${distilledContent.length} chars)`
                );
            }
        });

        const rawDigest = (distillResponse.message?.content ?? '').trim();
        const digest = rawDigest.length > 0
            ? rawDigest.slice(0, TOOL_DISTILL_MAX_CHARS)
            : message.content.slice(0, TOOL_DISTILL_MAX_CHARS);

        distilledMessages.push({
            ...message,
            content:
                `[Distilled tool output from ${toolName}; original length ${message.content.length} chars]\n` +
                digest,
        });

        onProgress?.(
            `Distilled tool output ${distilledMessages.length}/${historyMessages.length} (${toolName})`
        );
    }

    return distilledMessages;
}

/**
 * Compacts the provided conversation history by asking the LLM to summarise
 * it. Returns the new message array and stats comparing old vs new sizes.
 *
 * @param baseUrl   - Ollama base URL (e.g. http://localhost:11434)
 * @param model     - Model name to use for summarisation
 * @param messages  - Current conversation history (should include system prompt)
 * @param numCtx    - Context length to pass to the API
 * @param onProgress - Optional callback for live progress updates
 */
export async function compactHistory(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    numCtx: number,
    onProgress?: (message: string) => void,
    aggressiveFactor: number = 1.0,
    remainingRetries: number = 2,
    onStats?: (stats: CompactStats) => void,
): Promise<CompactResult> {
    const oldTokenCount = await measureConversationTokens(baseUrl, model, messages, numCtx, onProgress);

    // Filter out system messages — the system prompt is injected on-the-fly
    // by the caller and should not be preserved through compaction.
    const historyMessages = messages.filter((m) => m.role !== 'system');
    if (historyMessages.length === 0) {
        throw new Error('Cannot compact: conversation has no content beyond the system prompt.');
    }
    // ── Guard against degenerate "~2 tokens" crash ────────────────────────────
    // Subagents (and any short-history code path) can reach this point with
    // messages === [system] — i.e. zero history beyond the system prompt.
    // splitHistoryForCompaction would then return an empty messagesToSummarise,
    // and countMessagesTokens([], model) returns exactly 2 (the +2 overhead in
    // the tokenizer).  That produces the cryptic error:
    //   "The conversation history is too short to compact (~2 tokens)."
    // which is impossible to debug because 2 tokens is nowhere near the
    // MIN_SUMMARISE_TOKENS threshold of 200.
    //
    // The deeper root: when the latest user message is the FIRST history entry
    // (index 0), the anchor-rescue logic in splitHistoryForCompaction tries to
    // preserve it verbatim.  If the preservation loop consumed everything after
    // it, there is nothing left to summarise — prePromptMessages is empty and
    // postPromptPreWindowMessages is also empty — so the fallback returns an
    // empty messagesToSummarise array.
    //
    // The fix has two layers:
    // 1. Callers (autoCompactSubAgentIfNeeded, the web chat route) now refuse
    //    to compact when fewer than 4 messages exist (system + at least one
    //    user/assistant/tool exchange), which is the practical guard.
    // 2. Below, if historyMessages is empty despite that guard, we fail fast
    //    with a meaningful error instead of letting the empty-array propagate.
    //
    // For the edge case where anchorIndex === 0 and the split IS empty, the
    // expansion block further down falls back to summarising the whole
    // historyMessages array rather than silently doing nothing and crashing.

    let historySplit = splitHistoryForCompaction(historyMessages, model, numCtx, aggressiveFactor);

    // If the split leaves too little content to summarize, expand the summarised
    // section only when there is pre-anchor history to include. Otherwise keep
    // the anchored split and let the too-short guard abort compaction.
    const splitEstimate = countMessagesTokens(historySplit.messagesToSummarise, model);
    if (splitEstimate < MIN_SUMMARISE_TOKENS && historySplit.preservedRecentMessages.length > 0) {
        const anchorIndex = findLatestUserMessageIndex(historyMessages);
        if (anchorIndex > 0) {
            historySplit = {
                messagesToSummarise: historyMessages.slice(0, anchorIndex),
                preservedRecentMessages: historyMessages.slice(anchorIndex),
                preservedRecentTokens: countMessagesTokens(historyMessages.slice(anchorIndex), model),
            };
        } else if (anchorIndex < 0) {
            // No user anchor found — fall back to summarising the full history as
            // a last resort.
            historySplit = {
                messagesToSummarise: historyMessages,
                preservedRecentMessages: [],
                preservedRecentTokens: 0,
            };
        } else {
            // anchorIndex === 0: the first history message is the latest user prompt.
            // There is no pre-anchor history, but if the split left nothing to
            // summarise (which can happen when the preservation loop consumed
            // everything), fall back to summarising the whole history so we don't
            // abort with a confusing "~2 tokens" error.
            if (historySplit.messagesToSummarise.length === 0) {
                historySplit = {
                    messagesToSummarise: historyMessages,
                    preservedRecentMessages: [],
                    preservedRecentTokens: 0,
                };
            }
            // Otherwise keep the anchored split intact and let the too-short guard
            // decide whether to abort.
        }
    }

    const fullEstimate = countMessagesTokens(historySplit.messagesToSummarise, model);
    if (fullEstimate < MIN_SUMMARISE_TOKENS) {
        throw new Error(
            `The conversation history is too short to compact (~${fullEstimate} tokens). ` +
            'Continue the conversation and try /compact again when there is more context.',
        );
    }

    onProgress?.(
        `Preparing compaction: summarizing ${historySplit.messagesToSummarise.length} messages, preserving ${historySplit.preservedRecentMessages.length} recent messages`
    );

    const preparedHistoryMessages = await distillToolMessages(
        baseUrl,
        model,
        historySplit.messagesToSummarise,
        numCtx,
        onProgress,
    );

    // Also distill large tool outputs in the preserved window so they don't
    // land in newMessages at full size, which is the main cause of compaction
    // failing to bring token counts under the model context limit.
    const preparedRecentMessages = await distillToolMessages(
        baseUrl,
        model,
        historySplit.preservedRecentMessages,
        numCtx,
        onProgress,
    );

    const summarisedSourceTokenEstimate = Math.max(
        1,
        countMessagesTokens(preparedHistoryMessages, model),
    );

    const rawMaxSummaryTokens = clamp(
        Math.floor(numCtx * SUMMARY_MAX_TOKENS_RATIO / aggressiveFactor),
        Math.max(600, Math.floor(numCtx * 0.05 / aggressiveFactor)),
        Math.max(1200, Math.floor(numCtx * 0.30 / aggressiveFactor)),
    );
    // Cap the summary budget so it can never exceed the source it is compressing.
    // Without this a tiny conversation gets a confusingly large target, which
    // can cause some models to output nothing.
    const sourceCappedMaxSummaryTokens = Math.max(
        50,
        Math.floor(summarisedSourceTokenEstimate * 0.70),
    );
    const maxSummaryTokens = Math.min(rawMaxSummaryTokens, sourceCappedMaxSummaryTokens);
    const rawTargetSummaryTokens = clamp(
        Math.floor(numCtx * SUMMARY_TARGET_TOKENS_RATIO / aggressiveFactor),
        Math.max(500, Math.floor(numCtx * 0.04 / aggressiveFactor)),
        rawMaxSummaryTokens,
    );
    const targetSummaryTokens = clamp(
        Math.min(rawTargetSummaryTokens, maxSummaryTokens),
        50,
        maxSummaryTokens,
    );
    const minSummaryTokens = Math.max(50, Math.floor(targetSummaryTokens * 0.65));
    const summaryNumPredict = Math.max(
        Math.floor(targetSummaryTokens * SUMMARY_NUM_PREDICT_BUFFER_RATIO),
        minSummaryTokens,
    );

    // Build a single user turn that presents the history to the summariser.
    const historyText = preparedHistoryMessages
        .map(m => `[${m.role.toUpperCase()}]: ${m.content ?? ''}`)
        .join('\n\n');

    const summarisationMessages: ChatMessage[] = [
        {
            role: 'system',
            content: buildCompactSystemPrompt({
                targetSummaryTokens,
                minSummaryTokens,
                maxSummaryTokens,
                preservedRecentTokens: historySplit.preservedRecentTokens,
                numCtx,
            }),
        },
        {
            role: 'user',
            content:
                'Please summarise the following conversation history:\n\n' +
                historyText,
        },
    ];

    const streamSummary = async (msgs: ChatMessage[], numPredict: number): Promise<string> => {
        let text = '';
        for await (const chunk of sendLlmChatStream(baseUrl, {
            model,
            messages: msgs,
            tools: [],
            numCtx,
            options: {
                temperature: 0,
                num_predict: numPredict,
            },
        })) {
            const content = chunk.message?.content ?? '';
            if (content.length > 0) {
                text += content;
                onProgress?.(`AI is summarizing... (${text.length} chars)`);
            }
        }
        return text.trim();
    };

    let summary = await streamSummary(summarisationMessages, summaryNumPredict);

    // If the model returned nothing (can happen with very small inputs and a
    // large target), retry once with a dead-simple prompt and no token cap.
    if (!summary) {
        onProgress?.('Empty response — retrying with simplified prompt...');
        const retryMessages: ChatMessage[] = [
            {
                role: 'system',
                content:
                    'You are a summariser. Produce a short plain-text summary of the conversation below. ' +
                    'Keep all technical details. Return only the summary text.',
            },
            {
                role: 'user',
                content: 'Summarise this conversation:\n\n' + historyText,
            },
        ];
        summary = await streamSummary(retryMessages, summarisedSourceTokenEstimate * 2);
    }

    if (!summary) {
        throw new Error(
            'The model returned an empty summary after two attempts. ' +
            'Try a different model or continue the conversation before compacting.',
        );
    }

    // Rebuild the message history: original system prompt + a single assistant
    // message that holds the preamble + summary.
    const newMessages: ChatMessage[] = [
        {
            role: 'assistant',
            content: `${SUMMARY_PREAMBLE}\n\n${summary}`,
        },
        ...preparedRecentMessages,
    ];

    const newTokenCount = await measureConversationTokens(baseUrl, model, newMessages, numCtx, onProgress);

    if (newTokenCount >= oldTokenCount && oldTokenCount > 0) {
        throw new Error(
            `Compaction failed to reduce history size (old: ${oldTokenCount}, new: ${newTokenCount} tokens). ` +
            'Aborting to avoid increasing context usage.'
        );
    }

    // If the compacted result still exceeds the context window (with headroom),
    // retry with a stronger factor that shrinks preservation budgets and summary
    // targets, forcing more aggressive compression. Bounded by remainingRetries.
    const acceptanceBudget = Math.floor(numCtx * COMPACT_ACCEPTANCE_HEADROOM);
    if (newTokenCount > acceptanceBudget && remainingRetries > 0) {
        const retryFactor = Math.max(1.5, newTokenCount / (numCtx * 0.75));
        onProgress?.(
            `Compacted to ${newTokenCount} tokens but limit is ${numCtx} — ` +
            `retrying with ${retryFactor.toFixed(1)}x stronger compression (${remainingRetries} attempt(s) left)...`,
        );
        const retryResult = await compactHistory(
            baseUrl, model, newMessages, numCtx, onProgress, retryFactor, remainingRetries - 1, onStats,
        );
        // Report stats relative to the original pre-compaction history.
        return {
            newMessages: retryResult.newMessages,
            stats: {
                oldTokenCount,
                newTokenCount: retryResult.stats.newTokenCount,
            },
        };
    }

    onStats?.({
        oldTokenCount,
        newTokenCount,
    });

    return {
        newMessages,
        stats: {
            oldTokenCount,
            newTokenCount,
        },
    };
}

function looksLikeApologyTitle(title: string): boolean {
    return /\b(?:i['’]?m sorry|sorry|apolog(?:y|ize)|can(?:'t|not)|cannot|unable|won't|will not|no permission|cannot create|cannot write|no access|not allowed)\b/i.test(title);
}

function extractTitleFromResponse(rawTitle: string): string {
    // Take the first non-empty line
    const lines = rawTitle.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) return '';

    let title = (lines[0] ?? '').trim();

    // Strip surrounding quotes (both single and double, including smart quotes)
    title = title.replace(/^['""'']+|['""'']+$/g, '');

    // Strip common prefixes like "Title:", "Title - ", etc.
    title = title.replace(/^(?:title|session|conversation|chat)\s*[:\-–—]\s*/i, '');

    // Strip trailing punctuation that isn't part of the actual title
    title = title.replace(/[.,;:!?]+$/, '');

    // Collapse multiple spaces
    title = title.replace(/\s{2,}/g, ' ');

    return title.trim().slice(0, 80).trim();
}

export async function generateSessionTitle(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    numCtx: number,
    onProgress?: (message: string) => void,
): Promise<string> {
    if (messages.length <= 1) {
        throw new Error('Not enough conversation history to generate a session title.');
    }

    // Prepare conversation text (shared across retries)
    const trimmedHistory: ChatMessage[] = messages.length > 64
        ? [messages[0] as ChatMessage, ...messages.slice(-63)]
        : messages;

    const conversationText = trimmedHistory
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => `[${message.role.toUpperCase()}] ${message.content ?? ''}`)
        .join('\n\n');

    // Get first user message for fallback
    const firstUserContent = messages.find((m) => m.role === 'user')?.content?.trim() ?? '';

    // Multiple prompt strategies tried in order
    const promptStrategies: Array<{ system: string; user: string }> = [
        // Strategy 1: Standard prompt with few-shot examples
        {
            system:
                'You are a concise session title generator. Given a conversation between a user and an AI assistant, ' +
                'generate a short descriptive title (2-8 words).\n' +
                '\n' +
                'Examples:\n' +
                '[USER] How do I fix a 503 error on Nginx?\n' +
                '[ASSISTANT] Check upstream server configs and restart.\n' +
                'Title: Nginx 503 Error Troubleshooting\n' +
                '\n' +
                '[USER] Explain how Python async/await works\n' +
                '[ASSISTANT] Async/await is syntactic sugar over coroutines...\n' +
                'Title: Python Async/Await Explained\n' +
                '\n' +
                'Rules:\n' +
                '- Return ONLY the title — no quotes, no prefixes, no explanation\n' +
                '- 2 to 8 words, under 80 characters\n' +
                '- Capture the main topic or task\n' +
                '- Use descriptive, active language\n' +
                '- Do NOT include refusals, apologies, or limitation language in the title',
            user:
                'Generate a short session title for this conversation:\n\n' + conversationText + '\n\nTitle:',
        },
        // Strategy 2: Direct instruction, no examples (different prompt shape)
        {
            system:
                'You generate short titles for chat conversations. Output exactly one line of plain text. ' +
                'No quotes, no formatting, no prefixes like "Title:". Just the title.',
            user:
                'Conversation:\n' + conversationText.slice(0, 2000) + '\n\nShort title (2-8 words):',
        },
        // Strategy 3: Minimalist prompt (some models work better with less noise)
        {
            system: 'Generate a brief title for this chat. Output only the title text.',
            user:
                conversationText.slice(0, 1500) + '\n\nTitle:',
        },
    ];

    let lastError: string | null = null;

    for (let attempt = 0; attempt < promptStrategies.length; attempt += 1) {
        const strategy = promptStrategies[attempt]!;

        if (attempt > 0) {
            onProgress?.(`Retrying title generation (attempt ${attempt + 1}/${promptStrategies.length})...`);
        } else {
            onProgress?.('Generating session title...');
        }

        try {
            const response = await sendLlmChat(baseUrl, {
                model,
                messages: [
                    { role: 'system', content: strategy.system },
                    { role: 'user', content: strategy.user },
                ],
                tools: [],
                numCtx,
                options: {
                    temperature: 0.2,
                    num_predict: 128,
                },
            });

            const rawContent = response.message?.content?.trim() ?? '';
            if (rawContent.length === 0) {
                lastError = 'empty response';
                continue;
            }

            const title = extractTitleFromResponse(rawContent);
            if (!title) {
                lastError = 'extracted title was empty';
                continue;
            }

            if (looksLikeApologyTitle(title)) {
                lastError = 'apology or refusal detected';
                continue;
            }

            // Success — return the first valid title
            return title;
        } catch (err) {
            lastError = err instanceof Error ? err.message : 'Unknown error';
            continue;
        }
    }

    // ── Fallback: derive title from first user message ────────────────────
    if (firstUserContent.length > 0) {
        const fallback = firstUserContent
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60)
            .trim();
        if (fallback.length > 0) {
            onProgress?.('Using first message as fallback title.');
            return fallback;
        }
    }

    // ── Ultimate fallback ────────────────────────────────────────────────
    throw new Error(
        lastError
            ? `Title generation failed after ${promptStrategies.length} attempts: ${lastError}`
            : 'The model returned an empty title after multiple attempts.',
    );
}

/**
 * Prints a human-readable compaction report to the terminal.
 */
export function printCompactStats(stats: CompactResult['stats']): void {
    const tokensSaved = stats.oldTokenCount - stats.newTokenCount;
    const ratio = stats.oldTokenCount > 0
        ? ((tokensSaved / stats.oldTokenCount) * 100).toFixed(1)
        : '0.0';

    console.log(chalk.green('\n── Compaction complete ──────────────────────────'));
    console.log(
        chalk.white('  Tokens   : ') +
        chalk.red(String(stats.oldTokenCount)) +
        chalk.white(' → ') +
        chalk.green(String(stats.newTokenCount)) +
        chalk.dim(` (−${tokensSaved} tokens, ${ratio}% reduction)`),
    );
    console.log(chalk.green('─────────────────────────────────────────────────\n'));
}
