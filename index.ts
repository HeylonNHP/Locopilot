/**
 * index.ts - Locopilot CLI Application Entry Point
 * 
 * Main orchestrator for the terminal-based Ollama chat client.
 * Handles configuration, session management, and the main chat loop.
 */

import path from 'path';

import chalk from 'chalk';
import { select } from '@inquirer/prompts';

import { printSplashScreen } from './services/splashScreen';
import {
    isYolo,
    TOOLS,
    installKeyInterruptListener,
    removeKeyInterruptListener,
    clearInterrupt,
    isInterruptRequested,
    setWebSearchConfig,
} from './tools/tools';
import { getLlmApiErrorMessage, type ChatMessage, type LlmTurnStats } from './services/llm';
import { printAIResponse, renderTurn, type StreamAIResponseParams } from './aiResponseRenderer';
import { updateSessionMessages } from './history';
import { COMMAND_HANDLERS, getMultilineInput, withExitGuard, type Config } from './slashCommands';
import { getModels, resolveCompactionModel } from './services/modelManager';
import { countMessagesTokens } from './services/tokenizer';
import { clearLiveStatus } from './statusLine';
import {
    DEFAULT_NUM_CTX,
    DEFAULT_WEB_SEARCH_MAX_QUERIES,
    DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
    DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY,
    DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
} from './constants';
import {
    loadConfig,
    saveConfig,
    setupOllama as setupOllamaService,
    handleUnexpectedError,
} from './services/configManager';
import {
    selectExecutionMode,
    selectOrCreateSession,
} from './services/sessionManager';
import {
    createChatSessionState,
    loadModelMetadata,
    refreshTokenStatus,
    printFinalTokenSnapshot,
    autoCompactIfNeeded,
    processAITurn,
    handleEmptyResponseRecovery,
    nameSessionFromPrompt,
} from './services/chatSession';

let cleanupBeforeExit: (() => void) | null = null;

// --- Application Entry Point ---

async function main(): Promise<void> {
    printSplashScreen();

    // Load or create configuration
    let config = await loadConfig();
    config = await setupOllamaService(config);

    // Select execution mode (Standard or YOLO)
    const yoloActive = await selectExecutionMode(config);
    config.yolo = yoloActive;

    // Get available models
    console.log(chalk.blue('Fetching models from ' + config.baseUrl + '...'));
    const models = await getModels(config.baseUrl);

    if (!models || models.length === 0) {
        console.log(chalk.red('No models found in Ollama. Please pull a model first (e.g., ollama pull llama3).'));
        return;
    }

    // Configure model and context
    let selectedModel = config.lastModel && models.includes(config.lastModel)
        ? config.lastModel
        : null;
    const selectedNumCtx = config.numCtx ?? DEFAULT_NUM_CTX;

    const savedWebSearch = config.webSearch;
    const selectedWebSearchMaxQueries = savedWebSearch?.maxQueries ?? DEFAULT_WEB_SEARCH_MAX_QUERIES;
    const selectedWebSearchResultsPerQuery = savedWebSearch?.resultsPerQuery ?? DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY;
    const selectedWebSearchPerPageCharLimit = savedWebSearch?.perPageCharLimit ?? DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT;

    if (!selectedModel) {
        selectedModel = await withExitGuard(async () => {
            return await select({
                message: 'Select a model to chat with:',
                choices: models.map((m: string) => ({ name: m, value: m })),
                pageSize: 10
            });
        });

        if (selectedModel === null) process.exit(0);
    }

    config.lastModel = selectedModel;
    config.numCtx = selectedNumCtx;
    config.webSearch = {
        maxQueries: selectedWebSearchMaxQueries,
        resultsPerQuery: selectedWebSearchResultsPerQuery,
        perPageCharLimit: selectedWebSearchPerPageCharLimit,
    };
    await saveConfig(config);

    setWebSearchConfig({
        maxQueries: config.webSearch.maxQueries,
        resultsPerQuery: config.webSearch.resultsPerQuery,
        perPageCharLimit: config.webSearch.perPageCharLimit,
        baseUrl: config.baseUrl,
        compactionModel: resolveCompactionModel(config.compactionModel, selectedModel as string),
    });

    // Select or create session
    const { sessionId, messages: startingMessages, model: finalModel } = await selectOrCreateSession(models, selectedModel);

    // Start the chat
    await startChat(finalModel, selectedNumCtx, sessionId, config, startingMessages);
}

// --- Chat Logic ---

async function startChat(
    model: string,
    requestedNumCtxInput: number,
    sessionId: number,
    config: Config,
    preloadedMessages?: ChatMessage[],
): Promise<void> {
    // Create the chat session state and context
    const { state, context } = createChatSessionState(
        model,
        requestedNumCtxInput,
        sessionId,
        config,
        preloadedMessages,
    );

    // Load model metadata
    await loadModelMetadata(state, config);

    // Print welcome message
    printWelcomeMessage(state);

    // Register cleanup for SIGINT (Ctrl+C)
    cleanupBeforeExit = () => {
        updateSessionMessages(state.currentSessionId, state.messages);
    };

    // Main chat loop
    while (true) {
        let prompt: string;
        try {
            prompt = await getMultilineInput(chalk.cyan('You > '));
        } catch (e: unknown) {
            if (e instanceof Error && e.name === 'ExitPromptError') break;
            throw e;
        }

        if (!prompt || prompt.trim() === '') continue;
        if (prompt.toLowerCase() === 'exit') break;

        // Normalize prompt formatting
        prompt = prompt.replace(/^"""|"""$/g, '');

        // Handle slash commands or add user message
        const [cmdName = ''] = prompt.trim().split(/\s+/);
        const normalizedCmdName = cmdName.toLowerCase();
        
        if (normalizedCmdName.startsWith('/')) {
            const handler = COMMAND_HANDLERS[normalizedCmdName];
            if (handler) {
                const result = await handler(context);
                if (result === 'break') break;
                if (result === true) continue;
            } else {
                console.log(chalk.red(`\nUnknown command: ${normalizedCmdName}`));
                continue;
            }
        } else {
            // Standard user message
            state.messages.push({ role: 'user', content: prompt });
            nameSessionFromPrompt(state, prompt);
        }

        // Initialize turn state
        refreshTokenStatus(state, 'AI request queued...');
        clearLiveStatus();
        let emptyResponseRecoveryAttempts = 0;

        // Install interrupt listener for this turn
        installKeyInterruptListener('Ctrl+X');

        try {
            // Tool-call loop: keep sending results back until the LLM has no more tool calls
            while (true) {
                if (isInterruptRequested()) {
                    clearLiveStatus();
                    console.log(chalk.yellow('AI loop interrupted by user.\n'));
                    updateSessionMessages(state.currentSessionId, state.messages);
                    break;
                }

                // Auto-compact if context is getting full
                await autoCompactIfNeeded(state, config);

                // Build streaming parameters
                const streamParams: StreamAIResponseParams = {
                    model: state.currentModel,
                    messages: state.messages,
                    tools: TOOLS,
                    numCtx: state.numCtx,
                    think: config.thinkingEnabled !== false && state.thinkingSupported,
                    ...(state.visionSupported !== undefined ? { visionSupported: state.visionSupported } : {}),
                };

                // Create callback that updates token baseline - receive stats as parameter
                const onFinalStats = (authoritativeTokensUsed: number, stats: LlmTurnStats | null) => {
                    clearLiveStatus();
                    printFinalTokenSnapshot(state, authoritativeTokensUsed);
                    
                    // Update authoritative token baseline
                    if (stats) {
                        state.lastAuthoritativeTokens = stats.promptEvalCount + stats.evalCount;
                        state.estimatedTokensAtAuthoritative = countMessagesTokens(state.messages, state.currentModel);
                    }
                };

                // Render the AI turn
                const renderResult = await renderTurn(
                    config.baseUrl,
                    streamParams,
                    {
                        onStatusUpdate: (phase: string) => refreshTokenStatus(state, phase),
                        timeoutMs: config.chatTimeoutMs ?? DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
                        onFinalStats,
                    },
                );

                const { assistantMessage, interrupted: interruptedDuringStream, sessionTokenStats } = renderResult;

                if (interruptedDuringStream) {
                    updateSessionMessages(state.currentSessionId, state.messages);
                    break;
                }

                if (!assistantMessage) {
                    throw new Error('Invariant violation: assistantMessage was expected after successful renderTurn.');
                }

                // Process the AI response and tool calls
                const turnResult = await processAITurn(state, config, assistantMessage, sessionTokenStats);

                if (turnResult.wasInterrupted) {
                    updateSessionMessages(state.currentSessionId, state.messages);
                    break;
                }

                if (turnResult.shouldContinue) {
                    // Continue the tool-call loop
                    continue;
                }

                // No tool calls — check for empty response recovery
                if (handleEmptyResponseRecovery(state, assistantMessage, emptyResponseRecoveryAttempts)) {
                    emptyResponseRecoveryAttempts++;
                    continue;
                }

                // Final reply — print empty fallback if needed
                const assistantContent = assistantMessage.content?.trim() ?? '';
                if (assistantContent.length === 0) {
                    printAIResponse('[No response content was returned by the model after tool execution.]');
                }

                // Save session state
                config.lastModel = state.currentModel;
                await saveConfig(config);
                updateSessionMessages(state.currentSessionId, state.messages, sessionTokenStats ?? undefined);
                break;
            }
        } catch (error) {
            clearLiveStatus();
            console.error(chalk.red('Error communicating with Ollama:'), await getLlmApiErrorMessage(error));
            updateSessionMessages(state.currentSessionId, state.messages);
        } finally {
            clearLiveStatus();
            removeKeyInterruptListener();
            clearInterrupt();
        }
    }
}

/**
 * Prints the welcome message with model and mode information
 */
function printWelcomeMessage(state: { currentModel: string; numCtx: number; thinkingSupported: boolean }): void {
    console.log(chalk.green(`\nChatting with ${state.currentModel}. Type 'exit' or '/exit' to quit. Type '/' for commands.`));
    console.log(chalk.dim(`(Using context length num_ctx=${state.numCtx})`));
    
    if (isYolo()) {
        console.log(chalk.red.bold('(YOLO mode enabled — terminal commands will execute automatically!)\n'));
    } else {
        console.log(chalk.dim('(Tool calling enabled — the AI may request to run terminal commands.)\n'));
    }
}

// --- Application Bootstrap ---

process.on('SIGINT', () => {
    if (cleanupBeforeExit) {
        cleanupBeforeExit();
    }
    console.log('\nExiting Locopilot.');
    process.exit(0);
});

main().catch(handleUnexpectedError);
