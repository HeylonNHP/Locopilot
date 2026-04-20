/**
 * chatSession.ts - Manages the chat session state and orchestration
 * 
 * This module provides the core chat session management including:
 * - Model metadata loading and context limit handling
 * - Token estimation and authoritative tracking
 * - Auto-compaction logic
 * - Chat context creation and maintenance
 */

import chalk from 'chalk';

import {
    TOOLS,
    clearInterrupt,
    getToolSystemPrompt,
    handleToolCall,
    installKeyInterruptListener,
    isInterruptRequested,
    removeKeyInterruptListener,
    type ToolCallResult,
} from '../tools/tools';
import { fetchLlmModelInfo, getLlmModelContextLimit, type ChatMessage } from './llm';
import { summarizeCommandError } from './errorSummary';
import { sanitizeChatMessage } from './textUtils';
import {
    printAIResponse,
    renderTurn,
    type StreamAIResponseParams,
} from '../aiResponseRenderer';
import {
    renameSession,
    updateSessionMessages,
    type SessionTokenStats,
} from '../history';
import { countMessagesTokens } from './tokenizer';
import { updatePhase, clearLiveStatus } from '../statusLine';
import { compactHistory, printCompactStats } from './compact';
import { resolveCompactionModel } from './modelManager';
import {
    AUTO_COMPACT_THRESHOLD_PCT,
    COMPACT_WARNING_THRESHOLD_PCT,
    COMPACT_WARNING_TOKEN_INTERVAL,
    DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
    DEFAULT_WEB_SEARCH_MAX_QUERIES,
    DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
    DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY,
} from '../constants';
import { setWebSearchConfig } from '../tools/tools';
import { saveConfig as persistConfig } from './configManager';
import type { Config, ChatContext } from '../slashCommands';

export interface ChatSessionState {
    currentModel: string;
    currentSessionId: number;
    messages: ChatMessage[];
    sessionNamed: boolean;
    numCtx: number;
    requestedNumCtx: number;
    modelContextLimit: number | null;
    thinkingSupported: boolean;
    lastAuthoritativeTokens: number;
    estimatedTokensAtAuthoritative: number;
    lastCompactWarningTokens: number;
}

export interface ChatSessionOptions {
    baseUrl: string;
    initialModel: string;
    initialNumCtx: number;
    sessionId: number;
    config: Config;
    preloadedMessages?: ChatMessage[];
    onSessionUpdate?: (sessionId: number, messages: ChatMessage[], sessionNamed: boolean) => void;
    onModelChange?: (model: string) => Promise<void>;
}

/**
 * Creates the system prompt for the chat session
 */
export function createSystemPrompt(): string {
    return 'You are Locopilot, a helpful AI assistant running inside a terminal application.\n\n' +
        getToolSystemPrompt();
}

/**
 * Creates a new chat session state
 */
export function createChatSessionState(
    initialModel: string,
    initialNumCtx: number,
    sessionId: number,
    config: Config,
    preloadedMessages?: ChatMessage[],
): {
    state: ChatSessionState;
    messages: ChatMessage[];
    context: ChatContext;
    systemPrompt: string;
} {
    const systemPrompt = createSystemPrompt();

    const state: ChatSessionState = {
        currentModel: initialModel,
        currentSessionId: sessionId,
        messages: preloadedMessages && preloadedMessages.length > 0
            ? [...preloadedMessages]
            : [{ role: 'system', content: systemPrompt }],
        sessionNamed: preloadedMessages !== undefined && preloadedMessages.length > 0,
        numCtx: initialNumCtx,
        requestedNumCtx: initialNumCtx,
        modelContextLimit: null,
        thinkingSupported: false,
        lastAuthoritativeTokens: 0,
        estimatedTokensAtAuthoritative: 0,
        lastCompactWarningTokens: 0,
    };

    const context = createChatContext(state, config, systemPrompt);

    return { state, messages: state.messages, context, systemPrompt };
}

/**
 * Creates the chat context for slash commands and handlers
 */
function createChatContext(state: ChatSessionState, config: Config, systemPrompt: string): ChatContext {
    return {
        get baseUrl() { return config.baseUrl; },
        get currentModel() { return state.currentModel; },
        get numCtx() { return state.numCtx; },
        get messages() { return state.messages; },
        get currentSessionId() { return state.currentSessionId; },
        get config() { return config; },
        get systemPrompt() { return systemPrompt; },
        get thinkingSupported() { return state.thinkingSupported; },
        saveConfig: async (newConfig: Config) => {
            Object.assign(config, newConfig);
            await persistConfig(config);
        },
        updateNumCtx: (newNumCtx: number) => {
            state.requestedNumCtx = newNumCtx;
            applyEffectiveNumCtx(state);
        },
        saveSession: (tokenStats?: SessionTokenStats | null) =>
            updateSessionMessages(state.currentSessionId, state.messages, tokenStats),
        refreshTokenStatus: (
            phase: string,
            tokensUsedOverride?: number,
            tokenSource: 'estimated' | 'ollama' = 'estimated',
            modelOverride?: string,
        ) => refreshTokenStatus(state, phase, tokensUsedOverride, tokenSource, modelOverride),
        updateModel: async (model: string) => {
            state.currentModel = model;
            config.lastModel = state.currentModel;
            setWebSearchConfig({
                maxQueries: config.webSearch?.maxQueries ?? DEFAULT_WEB_SEARCH_MAX_QUERIES,
                resultsPerQuery: config.webSearch?.resultsPerQuery ?? DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY,
                perPageCharLimit: config.webSearch?.perPageCharLimit ?? DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
                baseUrl: config.baseUrl,
                compactionModel: resolveCompactionModel(config.compactionModel, state.currentModel),
            });
            await loadModelMetadata(state, config);
            console.log(chalk.green(`\nSwitched to model: ${state.currentModel}`));
        },
        updateSession: (sessionId: number, newMessages: ChatMessage[], isNamed: boolean) => {
            state.messages = newMessages;
            state.currentSessionId = sessionId;
            state.sessionNamed = isNamed;
            state.lastAuthoritativeTokens = 0;
            state.estimatedTokensAtAuthoritative = 0;
        }
    };
}

/**
 * Applies the effective context limit based on model capabilities
 */
function applyEffectiveNumCtx(state: ChatSessionState): void {
    state.numCtx = state.modelContextLimit && state.modelContextLimit > 0
        ? Math.min(state.requestedNumCtx, state.modelContextLimit)
        : state.requestedNumCtx;
}

/**
 * Loads model metadata including thinking support and context limits
 */
export async function loadModelMetadata(
    state: ChatSessionState,
    config: Config,
): Promise<void> {
    state.thinkingSupported = false;
    state.modelContextLimit = null;

    try {
        const info = await fetchLlmModelInfo(config.baseUrl, state.currentModel);
        state.thinkingSupported = !!(info.capabilities && info.capabilities.includes('thinking'));
        state.modelContextLimit = getLlmModelContextLimit(info);
        applyEffectiveNumCtx(state);
        
        if (state.thinkingSupported) {
            console.log(chalk.dim(`(Model ${state.currentModel} supports thinking)`));
        }
        if (state.modelContextLimit && state.requestedNumCtx > state.modelContextLimit) {
            console.log(
                chalk.yellow(
                    `\n⚠️  Model ${state.currentModel} reports max context num_ctx=${state.modelContextLimit}; ` +
                    `using that temporarily instead of requested ${state.requestedNumCtx}.\n`,
                ),
            );
        }
    } catch {
        state.thinkingSupported = false;
        state.modelContextLimit = null;
        applyEffectiveNumCtx(state);
    }
}

/**
 * Gets the current token estimate using authoritative Ollama counts when available
 */
export function getCurrentTokenEstimate(state: ChatSessionState): number {
    const rawEstimate = countMessagesTokens(state.messages, state.currentModel);
    if (state.lastAuthoritativeTokens > 0 && state.estimatedTokensAtAuthoritative > 0) {
        return Math.max(0, state.lastAuthoritativeTokens + (rawEstimate - state.estimatedTokensAtAuthoritative));
    }
    return rawEstimate;
}

/**
 * Refreshes the token status display with current usage
 */
export function refreshTokenStatus(
    state: ChatSessionState,
    phase: string,
    tokensUsedOverride?: number,
    tokenSource: 'estimated' | 'ollama' = 'estimated',
    modelOverride?: string,
): void {
    const tokensUsed = tokensUsedOverride ?? getCurrentTokenEstimate(state);
    updatePhase(phase, {
        tokensUsed,
        tokenLimit: state.numCtx,
        model: modelOverride ?? state.currentModel,
        tokenSource,
    });

    if (state.numCtx > 0) {
        const percentage = (tokensUsed / state.numCtx) * 100;
        if (percentage >= COMPACT_WARNING_THRESHOLD_PCT && 
            (tokensUsed - state.lastCompactWarningTokens) > COMPACT_WARNING_TOKEN_INTERVAL) {
            state.lastCompactWarningTokens = tokensUsed;
            clearLiveStatus();
            console.log(
                chalk.yellow.bold(`\n⚠️  Context is ${percentage.toFixed(0)}% full. `) +
                chalk.yellow(`Consider running `) + chalk.cyan(`/compact`) + chalk.yellow(` to save tokens.\n`)
            );
        }
    }
}

/**
 * Prints the final token snapshot after an AI turn
 */
export function printFinalTokenSnapshot(state: ChatSessionState, tokensUsed: number): void {
    const percentage = state.numCtx > 0
        ? Math.min(100, Math.round((tokensUsed / state.numCtx) * 100))
        : 0;
    const pctColor = percentage >= 90
        ? chalk.red
        : percentage >= 75
            ? chalk.yellow
            : chalk.green;

    console.log(
        chalk.dim(`[${state.currentModel}] `) +
        pctColor(`${tokensUsed}/${state.numCtx} tokens`) +
        chalk.dim(` (${percentage}%)`) +
        chalk.cyan.dim(' (ollama)') +
        chalk.dim(` (Used ${tokensUsed} ${tokensUsed === 1 ? 'token' : 'tokens'})`),
    );
}

/**
 * Checks whether auto-compaction is needed and runs it if necessary
 */
export async function autoCompactIfNeeded(
    state: ChatSessionState,
    config: Config,
): Promise<boolean> {
    const tokensUsed = getCurrentTokenEstimate(state);
    if (state.numCtx <= 0) return false;
    
    const pct = (tokensUsed / state.numCtx) * 100;
    if (pct < AUTO_COMPACT_THRESHOLD_PCT) return false;

    clearLiveStatus();
    console.log(
        chalk.yellow(`\n⚡ Context at ${pct.toFixed(0)}% — auto-compacting before continuing...\n`)
    );

    try {
        const compactionModel = resolveCompactionModel(config.compactionModel, state.currentModel);
        const result = await compactHistory(
            config.baseUrl,
            compactionModel,
            state.messages,
            state.numCtx,
            (status) => refreshTokenStatus(state, status, undefined, 'estimated', compactionModel),
        );
        clearLiveStatus();
        printCompactStats(result.stats);
        
        if (result.stats.newTokenCount > state.numCtx) {
            console.log(chalk.red(
                `⚠️  Compaction reduced context but history is still over the model limit ` +
                `(${result.stats.newTokenCount}/${state.numCtx} tokens). The next turn may fail.\n`,
            ));
        }

        state.messages = result.newMessages;
        state.messages.push({
            role: 'user',
            content:
                'The conversation history was automatically compacted due to context length. ' +
                'Your original request and the most recent tool-call results have been preserved above. ' +
                'Please continue working on the original task without asking for confirmation.',
        });
        
        updateSessionMessages(state.currentSessionId, state.messages, {
            promptEvalCount: result.stats.oldTokenCount,
            evalCount: result.stats.newTokenCount - result.stats.oldTokenCount
        });

        state.lastAuthoritativeTokens = 0;
        state.estimatedTokensAtAuthoritative = 0;
        return true;
    } catch (err) {
        clearLiveStatus();
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.yellow(`⚠️  Auto-compact skipped: ${msg}\n`));
        return false;
    }
}

/**
 * Processes a single AI turn and handles tool call execution
 */
export async function processAITurn(
    state: ChatSessionState,
    config: Config,
    assistantMessage: ChatMessage,
    sessionTokenStats: SessionTokenStats | null,
): Promise<{
    shouldContinue: boolean;
    wasInterrupted: boolean;
    finalStats: SessionTokenStats | null;
}> {
    const sanitizedAssistantMessage = sanitizeChatMessage(assistantMessage);
    state.messages.push(sanitizedAssistantMessage);

    if (sessionTokenStats) {
        state.lastAuthoritativeTokens = sessionTokenStats.promptEvalCount + sessionTokenStats.evalCount;
        state.estimatedTokensAtAuthoritative = countMessagesTokens(state.messages, state.currentModel);
    }

    if (sanitizedAssistantMessage.tool_calls && sanitizedAssistantMessage.tool_calls.length > 0) {
        for (const tc of sanitizedAssistantMessage.tool_calls) {
            clearLiveStatus();
            refreshTokenStatus(state, `Tool call: ${tc.function.name}`);
            
            const tokenResult: ToolCallResult = await handleToolCall(
                tc.function.name,
                tc.function.arguments,
                (message: string) => refreshTokenStatus(state, message),
            );
            
            clearLiveStatus();
            state.messages.push(sanitizeChatMessage({
                role: 'tool',
                content: tokenResult.content,
                ...(tokenResult.images ? { images: tokenResult.images } : {}),
            }));
            refreshTokenStatus(state, `Token result: ${tc.function.name}`);

            if (tc.function.name === 'run_command' && 
                tokenResult.content.includes('(COMMAND FAILED') && 
                !isInterruptRequested()) {
                refreshTokenStatus(state, 'Summarizing command error...');
                const errorSummary = await summarizeCommandError(
                    config.baseUrl,
                    state.currentModel,
                    tokenResult.content,
                    state.numCtx
                );
                clearLiveStatus();
                console.log(chalk.red('AI Error Summary: ') + chalk.yellow(errorSummary) + '\n');
                
                state.messages.push(sanitizeChatMessage({
                    role: 'user',
                    content: `Command failed. AI Error Analysis: ${errorSummary}\nPlease analyze the failure and propose a correction.`
                }));
                refreshTokenStatus(state, 'Retry requested after command failure.');
            }

            if (isInterruptRequested()) {
                return { shouldContinue: false, wasInterrupted: true, finalStats: null };
            }
        }
        return { shouldContinue: true, wasInterrupted: false, finalStats: sessionTokenStats };
    }

    return { shouldContinue: false, wasInterrupted: false, finalStats: sessionTokenStats };
}

/**
 * Handles empty response recovery
 */
export function handleEmptyResponseRecovery(
    state: ChatSessionState,
    assistantMessage: ChatMessage,
    recoveryAttempts: number,
): boolean {
    const assistantContent = assistantMessage.content?.trim() ?? '';
    
    if (assistantContent.length === 0 && recoveryAttempts < 3) {
        state.messages.push(sanitizeChatMessage({
            role: 'user',
            content:
                'Your last response was empty. Provide a direct answer now. ' +
                'If commands are needed, call run_command. If commands already ran, summarize their output and errors.'
        }));
        return true;
    }
    
    return false;
}

/**
 * Names the session from the first user message
 */
export function nameSessionFromPrompt(state: ChatSessionState, prompt: string): void {
    if (!state.sessionNamed) {
        state.sessionNamed = true;
        const name = prompt.trim().slice(0, 60);
        renameSession(state.currentSessionId, name);
    }
}
