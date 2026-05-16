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
    isInterruptRequested,
    type ToolCallResult,
} from '../tools/tools';
import { fetchLlmModelInfo, getLlmModelContextLimit, type ChatMessage, type LlmModelInfo } from './llm';
import { summarizeCommandError } from './errorSummary';
import { sanitizeChatMessage } from './textUtils';
import {
    renderTurn,
} from '../aiResponseRenderer';
import {
    renameSession,
    updateSessionMessages,
    updateSessionModel,
    type SessionTokenStats,
} from '../history';
import { countMessagesTokens } from './tokenizer';
import { updatePhase, clearLiveStatus, updateVram } from '../statusLine';
import { fetchLlmRunningModelVram } from './llm';
import { compactHistory, printCompactStats, type CompactStats } from './compact';
import { generateFallbackTitle } from './titleUtils';
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
import { saveConfig as persistConfig } from './configManager';
import {
    discoverSkills,
    loadSkillState,
    getEnabledSkills,
    buildAlwaysApplyPrompt,
    buildAvailableSkillsSummary,
} from './skillManager';
import type { Config, ChatContext } from '../types/chatConfig';

export interface ChatSessionState {
    currentModel: string;
    baseUrl: string;
    currentSessionId: number;
    messages: ChatMessage[];
    sessionNamed: boolean;
    numCtx: number;
    requestedNumCtx: number;
    modelContextLimit: number | null;
    thinkingSupported: boolean;
    visionSupported?: boolean;
    lastAuthoritativeTokens: number;
    estimatedTokensAtAuthoritative: number;
    lastCompactWarningTokens: number;
    /** Cached total token count for state.messages — avoids re-encoding the
     *  entire message history on every streaming chunk. Invalidated when the
     *  messages array length changes or the active model changes. */
    cachedTokenTotal: number;
    /** Length of state.messages at the time cachedTokenTotal was computed. */
    cachedMessagesLength: number;
    /** Model name used when cachedTokenTotal was computed. */
    cachedTokenTotalModel: string | null;
    /** Callback fired whenever session messages are updated. */
    onSessionUpdate?: (sessionId: number, messages: ChatMessage[], sessionNamed: boolean) => void;
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
export function createSystemPrompt(visionSupported?: boolean, yoloMode: boolean = false): string {
    const now = new Date();
    const dateTimeStr = now.toLocaleString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        timeZoneName: "short"
    });

    // Load skills
    const allSkills = discoverSkills();
    const state = loadSkillState();
    const enabledSkills = getEnabledSkills(allSkills, state);
    const alwaysApplySection = buildAlwaysApplyPrompt(enabledSkills);
    const availableSkillsSection = buildAvailableSkillsSummary(enabledSkills);

    return (
        `You are Locopilot, a helpful AI assistant running inside a terminal application.\n` +
        `Current date and time: ${dateTimeStr}\n` +
        `${alwaysApplySection}` +
        `\n` +
        getToolSystemPrompt(yoloMode, visionSupported) +
        `${availableSkillsSection}` +
        `\nYou may call \`load_skill\` to load the full instructions for any available skill listed above.\n` +
        `Skill creation: You can create new skills for the user by calling create_skill(name, description, body, ...). This writes a SKILL.md file to .locopilot/skills/<name>/ that becomes immediately available. Use this proactively when the user describes a reusable convention or workflow they'd like to preserve. You can also update existing skills by calling create_skill with the same name.\n`
    );
}

/**
 * Invalidates the cached token total, forcing the next call to
 * getCurrentTokenEstimate() to recompute from scratch.
 */
function invalidateTokenCache(state: ChatSessionState): void {
    state.cachedTokenTotal = 0;
    state.cachedMessagesLength = 0;
    state.cachedTokenTotalModel = null;
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
    onSessionUpdate?: (sessionId: number, messages: ChatMessage[], sessionNamed: boolean) => void,
): {
    state: ChatSessionState;
    messages: ChatMessage[];
    context: ChatContext;
    systemPrompt: string;
} {
    const systemPrompt = createSystemPrompt(undefined, config.yolo ?? false);


    const state: ChatSessionState = {
        currentModel: initialModel,
        baseUrl: config.baseUrl,
        currentSessionId: sessionId,
        messages: preloadedMessages && preloadedMessages.length > 0
            ? [{ role: 'system', content: systemPrompt }, ...preloadedMessages.filter((m) => m.role !== 'system')]
            : [{ role: 'system', content: systemPrompt }],
        sessionNamed: preloadedMessages !== undefined && preloadedMessages.length > 0,
        numCtx: initialNumCtx,
        requestedNumCtx: initialNumCtx,
        modelContextLimit: null,
        thinkingSupported: false,
        lastAuthoritativeTokens: 0,
        estimatedTokensAtAuthoritative: 0,
        lastCompactWarningTokens: 0,
        cachedTokenTotal: 0,
        cachedMessagesLength: 0,
        cachedTokenTotalModel: null,
        ...(onSessionUpdate ? { onSessionUpdate } : {}),
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
            state.baseUrl = config.baseUrl;
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
            updateSessionModel(state.currentSessionId, state.currentModel);
            await loadModelMetadata(state, config);

            if (state.visionSupported === false &&
                state.messages.some(message => Array.isArray(message.images) && message.images.length > 0)) {
                console.log(chalk.yellow(
                    `\n⚠️  Model ${state.currentModel} does not support vision input; ` +
                    `existing image attachments in this session will be ignored by the model.\n`
                ));
            }

            console.log(chalk.green(`\nSwitched to model: ${state.currentModel}`));
        },
        updateSession: (sessionId: number, newMessages: ChatMessage[], isNamed: boolean) => {
            state.messages = newMessages;
            state.currentSessionId = sessionId;
            state.sessionNamed = isNamed;
            state.lastAuthoritativeTokens = 0;
            state.estimatedTokensAtAuthoritative = 0;
            invalidateTokenCache(state);
            state.onSessionUpdate?.(state.currentSessionId, state.messages, state.sessionNamed);
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

async function refreshVram(state: ChatSessionState): Promise<void> {
    try {
        const vram = await fetchLlmRunningModelVram(state.baseUrl, state.currentModel);
        updateVram(vram ?? undefined);
    } catch {
        // Ignore VRAM fetch failures; they are non-fatal.
    }
}

/**
 * Loads model metadata including thinking support and context limits
 */
function getModelVisionSupport(info: LlmModelInfo): boolean {
    if (Array.isArray(info.capabilities)) {
        const capabilities = info.capabilities.map(String);
        return capabilities.includes('vision') || capabilities.includes('multimodal') || capabilities.includes('image');
    }
    return false;
}

export async function loadModelMetadata(
    state: ChatSessionState,
    config: Config,
): Promise<void> {
    state.thinkingSupported = false;
    state.modelContextLimit = null;

    try {
        const info = await fetchLlmModelInfo(config.baseUrl, state.currentModel);
        state.thinkingSupported = !!(info.capabilities && info.capabilities.includes('thinking'));
        state.visionSupported = getModelVisionSupport(info);
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
 * Gets the current token estimate using authoritative Ollama counts when available.
 *
 * This function caches the token total for the current messages array so that
 * callers (e.g. the per-chunk status update during streaming) do not pay the
 * cost of re-encoding the entire message history on every invocation. The
 * cache is invalidated automatically when messages are mutated (length change)
 * or the active model changes.
 */
export function getCurrentTokenEstimate(state: ChatSessionState): number {
    // Recompute the cached total only when the messages array or model has changed
    if (state.messages.length !== state.cachedMessagesLength ||
        state.currentModel !== state.cachedTokenTotalModel ||
        state.cachedTokenTotal === 0) {
        const rawEstimate = countMessagesTokens(state.messages, state.currentModel);
        state.cachedTokenTotal = rawEstimate;
        state.cachedMessagesLength = state.messages.length;
        state.cachedTokenTotalModel = state.currentModel;
    }

    // Apply authoritative anchoring
    if (state.lastAuthoritativeTokens > 0 && state.estimatedTokensAtAuthoritative > 0) {
        return Math.max(0, state.lastAuthoritativeTokens + (state.cachedTokenTotal - state.estimatedTokensAtAuthoritative));
    }
    return state.cachedTokenTotal;
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

    void refreshVram(state);

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
export interface TokenSnapshotStats {
    tokensUsed: number;
    tokenLimit: number;
    percentage: number;
    model: string;
}

export function printFinalTokenSnapshot(
    state: ChatSessionState,
    tokensUsed: number,
    onStats?: (stats: TokenSnapshotStats) => void,
): void {
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

    onStats?.({
        tokensUsed,
        tokenLimit: state.numCtx,
        percentage,
        model: state.currentModel,
    });

    void refreshVram(state);
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
            (status: string) => refreshTokenStatus(state, status, undefined, 'estimated', compactionModel),
            1.0,
            2,
            (stats) => {
                printCompactStats(stats);
            },
        );
        
        if (result.stats.newTokenCount > state.numCtx) {
            console.log(chalk.red(
                `⚠️  Compaction reduced context but history is still over the model limit ` +
                `(${result.stats.newTokenCount}/${state.numCtx} tokens). The next turn may fail.\n`,
            ));
        }

        state.messages = [
            { role: 'system', content: createSystemPrompt(state.visionSupported, config.yolo ?? false) },
            ...result.newMessages,
        ];
        state.messages.push({
            role: 'user',
            content:
                'The conversation history was automatically compacted due to context length. ' +
                'Your original request and the most recent tool-call results have been preserved above. ' +
                'Please continue working on the original task without asking for confirmation.',
        });
        
        updateSessionMessages(state.currentSessionId, state.messages, {
            promptEvalCount: result.stats.oldTokenCount,
            evalCount: 0
        });

        state.lastAuthoritativeTokens = 0;
        state.estimatedTokensAtAuthoritative = 0;
        invalidateTokenCache(state);
        state.onSessionUpdate?.(state.currentSessionId, state.messages, state.sessionNamed);
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

    state.onSessionUpdate?.(state.currentSessionId, state.messages, state.sessionNamed);

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
                tool_call_id: tc.id,
                ...(tokenResult.images ? { images: tokenResult.images } : {}),
            }));
            refreshTokenStatus(state, `Token result: ${tc.function.name}`);
            state.onSessionUpdate?.(state.currentSessionId, state.messages, state.sessionNamed);

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
                state.onSessionUpdate?.(state.currentSessionId, state.messages, state.sessionNamed);
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
 * Names the session from the first user message.
 *
 * NOTE: CLI uses the user prompt as the fallback title source, while the
 * web path uses the first assistant response for better topic summarisation.
 * This divergence is intentional: in the CLI we only have the prompt at the
 * moment the session is created, whereas on the web we wait for the first
 * response and then call generateFallbackTitle() with the assistant content.
 */
export function nameSessionFromPrompt(state: ChatSessionState, prompt: string): void {
    if (!state.sessionNamed) {
        state.sessionNamed = true;
        renameSession(state.currentSessionId, generateFallbackTitle(prompt));
    }
}
