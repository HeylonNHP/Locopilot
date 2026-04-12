import { access, readFile, writeFile } from 'fs/promises';
import path from 'path';
import * as readline from 'readline';

import chalk from 'chalk';
import { input, select } from '@inquirer/prompts';

import {
    TOOLS,
    clearInterrupt,
    getToolSystemPrompt,
    handleToolCall,
    installKeyInterruptListener,
    isInterruptRequested,
    isYolo,
    removeKeyInterruptListener,
    setWebSearchConfig,
    setYoloMode,
    type ToolCallResult,
} from './tools/tools.js';
import {
    validateLlmConnection,
    getLlmApiErrorMessage,
    fetchLlmModelInfo,
    type ChatMessage,
} from './services/llm.js';
import { summarizeCommandError } from './services/errorSummary.js';
import {
    printAIResponse,
    renderTurn,
    type StreamAIResponseParams,
} from './aiResponseRenderer.js';
import {
    createSession,
    listSessions,
    loadSessionMessages,
    renameSession,
    type Session,
    type SessionTokenStats,
    updateSessionMessages,
} from './history.js';
import { countMessagesTokens } from './tokenizer.js';
import { updatePhase, clearLiveStatus } from './statusLine.js';
import {
    COMMAND_HANDLERS,
    getModels,
    replaceMessages,
    SLASH_COMMANDS,
    type ChatContext,
    type Config,
    withExitGuard,
} from './slashCommands.js';
import { compactHistory, printCompactStats } from './services/compact.js';
import {
    DEFAULT_NUM_CTX,
    DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
    DEFAULT_WEB_SEARCH_MAX_QUERIES,
    DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY,
    OLLAMA_CONNECT_TIMEOUT_MS,
} from './constants.js';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const SESSION_NAME_MAX_LENGTH = 60;
const COMPACT_WARNING_THRESHOLD_PCT = 85;
const COMPACT_WARNING_TOKEN_INTERVAL = 500;
const AUTO_COMPACT_THRESHOLD_PCT = 92;
const MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 2;

let cleanupBeforeExit: (() => void) | null = null;

// --- Helper Functions ---

async function loadConfig(): Promise<Config | null> {
    try {
        await access(CONFIG_PATH);
        const data = await readFile(CONFIG_PATH, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        if (e && (e as any).code !== 'ENOENT') {
            console.error(chalk.red('Error reading or parsing config file.'));
        }
        return null;
    }
}

async function saveConfig(config: Config): Promise<void> {
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function handleUnexpectedError(err: any): void {
    if (err && err.name === 'ExitPromptError') {
        console.log('\nExiting Locopilot.');
        process.exit(0);
    }
    console.error(chalk.red('An unexpected error occurred:'), err);
    process.exit(1);
}

// --- Logic Blocks ---

async function setupOllama(initialConfig: Config | null): Promise<Config> {
    let config = initialConfig;

    while (true) {
        if (!config) {
            console.log(chalk.blue('Initial Configuration Required'));
            const host = await input({ message: 'Enter Ollama host (e.g., localhost):', default: 'localhost' });
            const port = await input({ message: 'Enter Ollama port:', default: '11434' });
            config = {
                baseUrl: `http://${host}:${port}`
            };
        }

        try {
            await validateLlmConnection(config.baseUrl, OLLAMA_CONNECT_TIMEOUT_MS);
            await saveConfig(config);
            return config;
        } catch (error) {
            console.error(chalk.red('\nCould not connect to Ollama at ' + config.baseUrl));
            console.error(chalk.yellow('Please check if Ollama is running and the address is correct.\n'));
            
            const action = await withExitGuard(async () => {
                return await select({
                    message: 'What would you like to do?',
                    choices: [
                        { name: 'Retry connection', value: 'retry' },
                        { name: 'Edit configuration', value: 'edit' },
                        { name: 'Exit', value: 'exit' }
                    ]
                });
            });

            if (action === 'exit' || action === null) process.exit(0);
            if (action === 'edit') {
                config = null;
                continue;
            }
            // if retry, loop will continue with existing config
        }
    }
}

async function selectExecutionMode(config: Config): Promise<boolean> {
    const yoloEnv = process.env.YOLO?.toLowerCase();
    let yoloActive = process.argv.some(arg => arg === '--yolo' || arg === '-y') ||
                     yoloEnv === 'true' ||
                     yoloEnv === '1';

    if (!yoloActive && config.yolo !== undefined) {
        yoloActive = config.yolo;
    }

    setYoloMode(yoloActive);
    if (yoloActive) {
        console.log(chalk.red.bold('\n⚠️  YOLO MODE ACTIVATED: Commands will execute automatically without confirmation. ⚠️\n'));
    }

    return yoloActive;
}

async function configureModelAndContext(config: Config, models: string[]): Promise<{ model: string, numCtx: number }> {
    let selectedModel = config.lastModel && models.includes(config.lastModel)
        ? config.lastModel
        : null;
    const selectedNumCtx = config.numCtx ?? DEFAULT_NUM_CTX;

    const savedWebSearch = config.webSearch;
    const selectedWebSearchMaxQueries = savedWebSearch?.maxQueries ?? DEFAULT_WEB_SEARCH_MAX_QUERIES;
    const selectedWebSearchResultsPerQuery = savedWebSearch?.resultsPerQuery ?? DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY;

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
    };
    await saveConfig(config);

    setWebSearchConfig({
        maxQueries: config.webSearch.maxQueries,
        resultsPerQuery: config.webSearch.resultsPerQuery,
    });

    return { model: selectedModel as string, numCtx: selectedNumCtx };
}

async function selectOrCreateSession(models: string[], selectedModel: string): Promise<{ sessionId: number, messages?: ChatMessage[], model: string }> {
    const savedSessions = listSessions();
    if (savedSessions.length === 0) {
        const sessionId = createSession('New Session', selectedModel);
        return { sessionId, model: selectedModel };
    }

    const sessionChoice = await withExitGuard(async () => {
        return await select<'new' | number>({
            message: 'Start a new conversation or resume a previous one?',
            choices: [
                { name: chalk.green('+ New conversation'), value: 'new' },
                ...savedSessions.slice(0, 10).map((s: Session) => ({
                    name: `[${s.id}] ${s.name}  ${chalk.dim('(' + s.model + ' · ' + s.updated_at + ')')}`,
                    value: s.id as 'new' | number,
                })),
            ],
            pageSize: 12,
        });
    });

    if (sessionChoice === null) process.exit(0);

    let currentModel = selectedModel;
    if (sessionChoice === 'new') {
        const sessionId = createSession('New Session', currentModel);
        return { sessionId, model: currentModel };
    }

    const resumedSession = savedSessions.find(s => s.id === sessionChoice);
    if (resumedSession) {
        if (models.includes(resumedSession.model)) {
            currentModel = resumedSession.model;
        } else {
            console.log(chalk.yellow(`\n⚠️ Resumed session used model '${resumedSession.model}', which is not currently available.`));
            console.log(chalk.yellow(`Continuing with '${currentModel}' instead.\n`));
        }
    }
    const messages = loadSessionMessages(sessionChoice);
    console.log(chalk.dim(`Resuming session [${sessionChoice}] with ${messages.length} messages.`));
    return { sessionId: sessionChoice, messages, model: currentModel };
}

async function getMultilineInput(promptStr: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const commands = SLASH_COMMANDS.map(c => c.value);
        const completer = (line: string) => {
            const hits = commands.filter((c) => c.startsWith(line));
            return [hits.length ? hits : commands, line];
        };

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: promptStr,
            terminal: true,
            historySize: 500,
            completer
        });

        let buffer: string[] = [];
        let pasteTimeout: ReturnType<typeof setTimeout> | null = null;
        let inBlock = false;

        const onKeypress = async (str: string, key: any) => {
            // Only show menu for the very first character of the very first line
            if (buffer.length > 0 || inBlock || rl.line.length > 1) return;
            
            const line = rl.line;
            if (line === '/') {
                // Pause rl to prevent it from consuming arrow keys/enter while select is active
                rl.pause();
                process.stdin.removeListener('keypress', onKeypress);

                // Clear the "/" character before showing select
                process.stdout.write('\r\x1B[K');

                const choice = await withExitGuard(async () => {
                    return await select({
                        message: 'Select a command:',
                        choices: SLASH_COMMANDS.map(c => ({ 
                            name: c.name, 
                            value: c.value 
                        })),
                        pageSize: 10
                    });
                });

                if (choice) {
                    // Replace "/" with the chosen command and immediately resolve
                    cleanup();
                    rl.close();
                    resolve(choice);
                    return;
                } else {
                    // User cancelled, restore the "/"
                    rl.write('/');
                }

                // Resume rl and re-attach listener
                rl.resume();
                process.stdin.on('keypress', onKeypress);
                rl.prompt(true);
            }
        };

        process.stdin.on('keypress', onKeypress);

        rl.prompt();

        const cleanup = () => {
            process.stdin.removeListener('keypress', onKeypress);
        };

        rl.on('line', (line) => {
            buffer.push(line);

            if (pasteTimeout) clearTimeout(pasteTimeout);

            // Toggle block mode on """
            if (line.trim() === '"""') {
                inBlock = !inBlock;
            }

            if (inBlock) {
                rl.setPrompt('... ');
                rl.prompt();
                return;
            }

            // Normal line continuation via backslash
            if (line.endsWith('\\')) {
                buffer[buffer.length - 1] = line.slice(0, -1);
                rl.setPrompt('... ');
                rl.prompt();
                return;
            }

            pasteTimeout = setTimeout(() => {
                cleanup();
                rl.close();
                resolve(buffer.join('\n'));
            }, 30);
        });

        rl.on('SIGINT', () => {
            cleanup();
            rl.close();
            const err = new Error('ExitPromptError');
            err.name = 'ExitPromptError';
            reject(err);
        });
    });
}

async function startChat(
    model: string,
    numCtx: number,
    sessionId: number,
    config: Config,
    preloadedMessages?: ChatMessage[],
): Promise<void> {
    let currentModel = model;
    let currentSessionId = sessionId;
    const baseUrl = config.baseUrl;
    let thinkingSupported = false;

    async function checkThinkingSupport(modelName: string) {
        try {
            const info = await fetchLlmModelInfo(baseUrl, modelName);
            thinkingSupported = !!(info.capabilities && info.capabilities.includes('thinking'));
            if (thinkingSupported) {
                console.log(chalk.dim(`(Model ${modelName} supports thinking)`));
            }
        } catch (e) {
            thinkingSupported = false;
        }
    }

    await checkThinkingSupport(currentModel);

    console.log(chalk.green(`\nChatting with ${currentModel}. Type 'exit' or '/exit' to quit. Type '/' for commands.`));
    console.log(chalk.dim(`(Using context length num_ctx=${numCtx})`));
    if (isYolo()) {
        console.log(chalk.red.bold('(YOLO mode enabled — terminal commands will execute automatically!)\n'));
    } else {
        console.log(chalk.dim('(Tool calling enabled — the AI may request to run terminal commands.)\n'));
    }
    if (config.webSearch) {
        console.log(
            chalk.dim(
                `(Web search defaults: maxQueries=${config.webSearch.maxQueries}, resultsPerQuery=${config.webSearch.resultsPerQuery})\n`,
            ),
        );
    }

    const systemPrompt =
        'You are Locopilot, a helpful AI assistant running inside a terminal application.\n\n' +
        getToolSystemPrompt();

    let messages: ChatMessage[] = preloadedMessages && preloadedMessages.length > 0
        ? [...preloadedMessages]
        : [{ role: 'system', content: systemPrompt }];

    // Whether the session name has been set from the first user message.
    let sessionNamed = preloadedMessages !== undefined && preloadedMessages.length > 0;

    const context: ChatContext = {
        get baseUrl() { return baseUrl; },
        get currentModel() { return currentModel; },
        get numCtx() { return numCtx; },
        get messages() { return messages; },
        get currentSessionId() { return currentSessionId; },
        get config() { return config; },
        get systemPrompt() { return systemPrompt; },
        get thinkingSupported() { return thinkingSupported; },
        saveConfig: async (newConfig: Config) => {
            Object.assign(config, newConfig);
            await saveConfig(config);
        },
        updateNumCtx: (newNumCtx: number) => {
            numCtx = newNumCtx;
        },
        saveSession: (tokenStats?: SessionTokenStats | null) =>
            updateSessionMessages(currentSessionId, messages, tokenStats),
        refreshTokenStatus: (phase: string) => refreshTokenStatus(phase),
        updateModel: async (model: string) => {
            currentModel = model;
            config.lastModel = currentModel;
            config.numCtx = numCtx;
            await saveConfig(config);
            await checkThinkingSupport(currentModel);
            console.log(chalk.green(`\nSwitched to model: ${currentModel}`));
        },
        updateSession: (sessionId: number, newMessages: ChatMessage[], isNamed: boolean) => {
            replaceMessages(messages, newMessages);
            currentSessionId = sessionId;
            sessionNamed = isNamed;
            lastAuthoritativeTokens = 0;
            estimatedTokensAtAuthoritative = 0;
        }
    };

    let lastCompactWarningTokens = 0;

    // Track the last exact token count from Ollama and the local Tkiktoken estimate
    // at that exact same point. This allows us to track tokens using the highly accurate
    // Ollama baseline plus the delta of any new messages, rather than relying solely
    // on the less accurate local estimator for the entire context window.
    let lastAuthoritativeTokens = 0;
    let estimatedTokensAtAuthoritative = 0;

    function getCurrentTokenEstimate(): number {
        const rawEstimate = countMessagesTokens(messages, currentModel);
        if (lastAuthoritativeTokens > 0 && estimatedTokensAtAuthoritative > 0) {
            // Apply the delta of recent messages to our last known exact count
            return Math.max(0, lastAuthoritativeTokens + (rawEstimate - estimatedTokensAtAuthoritative));
        }
        return rawEstimate;
    }

    /**
     * Checks whether the context is above AUTO_COMPACT_THRESHOLD_PCT and, if so,
     * runs compaction automatically. Prints a one-liner to inform the user.
     * Returns true if compaction ran (caller should re-check interrupt state).
     */
    async function autoCompactIfNeeded(): Promise<boolean> {
        const tokensUsed = getCurrentTokenEstimate();
        if (numCtx <= 0) return false;
        const pct = (tokensUsed / numCtx) * 100;
        if (pct < AUTO_COMPACT_THRESHOLD_PCT) return false;

        clearLiveStatus();
        console.log(
            chalk.yellow(`\n⚡ Context at ${pct.toFixed(0)}% — auto-compacting before continuing...\n`)
        );
        try {
            const result = await compactHistory(
                baseUrl,
                currentModel,
                messages,
                numCtx,
                (status) => refreshTokenStatus(status),
            );
            clearLiveStatus();
            printCompactStats(result.stats);
            replaceMessages(messages, result.newMessages);
            context.saveSession();
            
            // Compaction completely changes the context, meaning our old baseline is no longer valid
            lastAuthoritativeTokens = 0;
            estimatedTokensAtAuthoritative = 0;
        } catch (err) {
            clearLiveStatus();
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.yellow(`⚠️  Auto-compact skipped: ${msg}\n`));
        }
        return true;
    }
    function refreshTokenStatus(
        phase: string,
        tokensUsedOverride?: number,
        tokenSource: 'estimated' | 'ollama' = 'estimated',
    ) {
        const tokensUsed = tokensUsedOverride ?? getCurrentTokenEstimate();
        updatePhase(phase, {
            tokensUsed,
            tokenLimit: numCtx,
            model: currentModel,
            tokenSource,
        });

        // ── Suggestion #7: Auto-compact warning (once every 500 tokens after 85%) 
        if (numCtx > 0) {
            const percentage = (tokensUsed / numCtx) * 100;
            // Only warn if >85% full and we haven't warned in the last 500 tokens
            if (percentage >= COMPACT_WARNING_THRESHOLD_PCT && (tokensUsed - lastCompactWarningTokens) > COMPACT_WARNING_TOKEN_INTERVAL) {
                lastCompactWarningTokens = tokensUsed;
                clearLiveStatus();
                console.log(
                    chalk.yellow.bold(`\n⚠️  Context is ${percentage.toFixed(0)}% full (${tokensUsed}/${numCtx}). `) +
                    chalk.yellow(`Consider running `) + chalk.cyan(`/compact`) + chalk.yellow(` to save tokens.\n`)
                );
            }
        }
        // ─────────────────────────────────────────────────────────────
    }

    // Register cleanup for SIGINT (Ctrl+C)
    cleanupBeforeExit = () => context.saveSession();

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

        // Note: the prompt is already visible via readline so we don't need to manually print it again.
        
        // Let's ensure string formatting is standard before sending to model
        prompt = prompt.replace(/^"""|"""$/g, '');

        // Handle slash commands via registry
        const [cmdName = ''] = prompt.trim().split(/\s+/);
        const normalizedCmdName = cmdName.toLowerCase();
        if (normalizedCmdName.startsWith('/')) {
            const handler = COMMAND_HANDLERS[normalizedCmdName];
            if (handler) {
                const result = await handler(context);
                if (result === 'break') break;
                if (result === true) continue;
                // If false, it falls through to the AI turn (like /nudge)
            } else {
                console.log(chalk.red(`\nUnknown command: ${normalizedCmdName}`));
                continue;
            }
        } else {
            // Standard user message
            messages.push({ role: 'user', content: prompt });

            // Name the session from the first user message.
            if (!sessionNamed) {
                sessionNamed = true;
                const name = prompt.trim().slice(0, SESSION_NAME_MAX_LENGTH);
                renameSession(currentSessionId, name);
            }
        }

        const historyLengthBeforeTurn = messages.length - 1;
        refreshTokenStatus('AI request queued...');
        clearInterrupt();
        let emptyResponseRecoveryAttempts = 0;

        installKeyInterruptListener('Ctrl+X');

        try {
            // Tool-call loop: keep sending results back until the LLM has no more tool calls
            while (true) {
                if (isInterruptRequested()) {
                    clearLiveStatus();
                    console.log(chalk.yellow('AI loop interrupted by user.\n'));
                    context.saveSession();
                    break;
                }

                // Auto-compact if we've grown too close to the context limit between iterations.
                await autoCompactIfNeeded();

                const streamParams: StreamAIResponseParams = {
                    model: currentModel,
                    messages,
                    tools: TOOLS,
                    numCtx,
                    think: config.thinkingEnabled !== false && thinkingSupported,
                };

                const { assistantMessage, interrupted: interruptedDuringStream, sessionTokenStats, finalStats } = await renderTurn(
                    baseUrl,
                    streamParams,
                    {
                        onStatusUpdate: refreshTokenStatus,
                        timeoutMs: config.chatTimeoutMs ?? DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
                        onFinalStats: (authoritativeTokensUsed, finalStats) => {
                            refreshTokenStatus('AI response received.', authoritativeTokensUsed, 'ollama');
                            console.log(chalk.dim(`(Used ${authoritativeTokensUsed} ${authoritativeTokensUsed === 1 ? 'token' : 'tokens'})`));
                        },
                    },
                );

                if (interruptedDuringStream) {
                    context.saveSession();
                    break;
                }

                if (!assistantMessage) {
                    throw new Error('Invariant violation: assistantMessage was expected after successful renderTurn.');
                }

                messages.push(assistantMessage);

                // Update our exact baseline now that the messages array includes the complete AI response
                if (sessionTokenStats) {
                    lastAuthoritativeTokens = sessionTokenStats.promptEvalCount + sessionTokenStats.evalCount;
                    estimatedTokensAtAuthoritative = countMessagesTokens(messages, currentModel);
                }

                if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                    // Execute each tool call sequentially then feed results back
                    for (const tc of assistantMessage.tool_calls) {
                        clearLiveStatus();
                        refreshTokenStatus(`Tool call: ${tc.function.name}`);
                        const toolResult: ToolCallResult = await handleToolCall(
                            tc.function.name,
                            tc.function.arguments,
                            (message) => {
                                refreshTokenStatus(message);
                            },
                        );
                        clearLiveStatus();
                        messages.push({
                            role: 'tool',
                            content: toolResult.content,
                            ...(toolResult.images ? { images: toolResult.images } : {}),
                        });
                        refreshTokenStatus(`Tool result: ${tc.function.name}`);

                        // If the command failed, have the LLM summarize the error for the user
                        if (tc.function.name === 'run_command' && toolResult.content.includes('(COMMAND FAILED') && !isInterruptRequested()) {
                            refreshTokenStatus('Summarizing command error...');
                            const errorSummary = await summarizeCommandError(baseUrl, currentModel, toolResult.content, numCtx);
                            clearLiveStatus();
                            console.log(chalk.red('AI Error Summary: ') + chalk.yellow(errorSummary) + '\n');
                            
                            // Include the error summary in the conversation history as a user nudge
                            // to help the model reason about the failure in the next turn.
                            messages.push({
                                role: 'user',
                                content: `Command failed. AI Error Analysis: ${errorSummary}\nPlease analyze the failure and propose a correction.`
                            });
                            refreshTokenStatus('Retry requested after command failure.');
                        }

                        // Check for interrupt after each individual tool call
                        if (isInterruptRequested()) break;
                    }
                    // Loop again so the LLM can see the tool results and respond
                } else {
                    const assistantContent = assistantMessage.content?.trim() ?? '';

                    if (assistantContent.length === 0 && emptyResponseRecoveryAttempts < MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS) {
                        emptyResponseRecoveryAttempts += 1;
                        messages.push({
                            role: 'user',
                            content:
                                'Your last response was empty. Provide a direct answer now. ' +
                                'If commands are needed, call run_command. If commands already ran, summarize their output and errors.'
                        });
                        continue;
                    }

                    // No tool calls — this is the final reply.
                    // If content was already printed during the streaming/interrupted blocks above,
                    // we don't print it again. We only print here if content was empty and we
                    // are showing the fallback message.
                    if (assistantContent.length === 0) {
                        printAIResponse('[No response content was returned by the model after tool execution.]');
                    }

                    config.lastModel = currentModel;
                    config.numCtx = numCtx;
                    await saveConfig(config);
                    context.saveSession(sessionTokenStats);
                    break;
                }
            }
        } catch (error) {
            clearLiveStatus();
            console.error(chalk.red('Error communicating with Ollama:'), await getLlmApiErrorMessage(error));
            context.saveSession();
        } finally {
            clearLiveStatus();
            removeKeyInterruptListener();
        }
    }
}

async function main(): Promise<void> {
    let config = await loadConfig();
    config = await setupOllama(config);

    const yoloActive = await selectExecutionMode(config);
    config.yolo = yoloActive;

    console.log(chalk.blue('Fetching models from ' + config.baseUrl + '...'));
    const models = await getModels(config.baseUrl);

    if (!models || models.length === 0) {
        console.log(chalk.red('No models found in Ollama. Please pull a model first (e.g., ollama pull llama3).'));
        return;
    }

    console.log(chalk.green(`Found ${models.length} models:`));
    models.forEach((m: string, i: number) => console.log(`  ${i + 1}. ${m}`));

    const { model: selectedModel, numCtx: selectedNumCtx } = await configureModelAndContext(config, models);
    const { sessionId, messages: startingMessages, model: finalModel } = await selectOrCreateSession(models, selectedModel);

    await startChat(finalModel, selectedNumCtx, sessionId, config, startingMessages);
}

process.on('SIGINT', () => {
    if (cleanupBeforeExit) {
        cleanupBeforeExit();
    }
    console.log('\nExiting Locopilot.');
    process.exit(0);
});

main().catch(handleUnexpectedError);
