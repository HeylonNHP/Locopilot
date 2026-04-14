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
import { sendLlmChat, sendLlmChatStream, getLlmTurnStats } from './llm.js';
import type { ChatMessage } from './llm.js';
import { countMessagesTokens } from '../tokenizer.js';

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

export interface CompactResult {
    /** The new, compacted message array that should replace the live history. */
    newMessages: ChatMessage[];
    /** Token counts for display purposes. */
    stats: {
        oldTokenCount: number;
        newTokenCount: number;
    };
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
): Promise<CompactResult> {
    const oldTokenCount = await measureConversationTokens(baseUrl, model, messages, numCtx, onProgress);

    // Separate the system prompt from the rest of the history so we can
    // preserve it verbatim in the compacted result.
    const systemMessage = messages[0];
    if (!systemMessage) {
        throw new Error('Cannot compact an empty message history.');
    }
    const historyMessages = messages.slice(1);
    let historySplit = splitHistoryForCompaction(historyMessages, model, numCtx, aggressiveFactor);

    // If the split leaves too little content to summarize, expand the summarised
    // section — but still respect the latest-user-message anchor so it is never
    // compacted away.
    const splitEstimate = countMessagesTokens(historySplit.messagesToSummarise, model);
    if (splitEstimate < MIN_SUMMARISE_TOKENS && historySplit.preservedRecentMessages.length > 0) {
        const anchorIndex = findLatestUserMessageIndex(historyMessages);
        if (anchorIndex > 0) {
            historySplit = {
                messagesToSummarise: historyMessages.slice(0, anchorIndex),
                preservedRecentMessages: historyMessages.slice(anchorIndex),
                preservedRecentTokens: countMessagesTokens(historyMessages.slice(anchorIndex), model),
            };
        } else {
            // No prior history before the anchor (or no user message found) —
            // fall back to summarising the full history as a last resort.
            historySplit = {
                messagesToSummarise: historyMessages,
                preservedRecentMessages: [],
                preservedRecentTokens: 0,
            };
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
        systemMessage,
        {
            role: 'assistant',
            content: `${SUMMARY_PREAMBLE}\n\n${summary}`,
        },
        ...historySplit.preservedRecentMessages,
    ];

    const newTokenCount = await measureConversationTokens(baseUrl, model, newMessages, numCtx, onProgress);

    if (newTokenCount >= oldTokenCount && oldTokenCount > 0) {
        throw new Error(
            `Compaction failed to reduce history size (old: ${oldTokenCount}, new: ${newTokenCount} tokens). ` +
            'Aborting to avoid increasing context usage.'
        );
    }

    // If the compacted result still exceeds the context window (with headroom),
    // retry once with a stronger factor that shrinks preservation budgets and
    // summary targets, forcing more aggressive compression.
    const acceptanceBudget = Math.floor(numCtx * COMPACT_ACCEPTANCE_HEADROOM);
    if (newTokenCount > acceptanceBudget && aggressiveFactor <= 1.0) {
        const retryFactor = Math.max(1.5, newTokenCount / (numCtx * 0.75));
        onProgress?.(
            `Compacted to ${newTokenCount} tokens but limit is ${numCtx} — ` +
            `retrying with ${retryFactor.toFixed(1)}x stronger compression...`,
        );
        const retryResult = await compactHistory(
            baseUrl, model, newMessages, numCtx, onProgress, retryFactor,
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

    return {
        newMessages,
        stats: {
            oldTokenCount,
            newTokenCount,
        },
    };
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
