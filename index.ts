import { readFile, writeFile, access } from 'fs/promises';
import path from 'path';
import { select, input, search } from '@inquirer/prompts';
import chalk from 'chalk';
import {
    TOOLS,
    handleToolCall,
    getToolSystemPrompt,
    setYoloMode,
    setWebSearchConfig,
    isYolo,
    clearInterrupt,
    isInterruptRequested,
    installKeyInterruptListener,
    removeKeyInterruptListener,
} from './tools.js';
import {
    validateOllamaConnection,
    getOllamaApiErrorMessage,
    type ChatMessage,
} from './ollamaApi.js';
import { summarizeCommandError } from './errorSummary.js';
import {
    printAIResponse,
    renderTurn,
    type StreamAIResponseParams,
} from './aiResponseRenderer.js';
import {
    createSession,
    renameSession,
    listSessions,
    updateSessionMessages,
    loadSessionMessages,
    type Session,
    type SessionTokenStats,
} from './history.js';
import { countMessagesTokens } from './tokenizer.js';
import { updatePhase, clearLiveStatus } from './statusLine.js';
import {
    SLASH_COMMANDS,
    COMMAND_HANDLERS,
    withExitGuard,
    getModels,
    replaceMessages,
    type Config,
    type ChatContext,
} from './slashCommands.js';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const DEFAULT_NUM_CTX = 131072;
const DEFAULT_WEB_SEARCH_MAX_QUERIES = 3;
const DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY = 3;
const SESSION_NAME_MAX_LENGTH = 60;
const COMPACT_WARNING_THRESHOLD_PCT = 85;
const COMPACT_WARNING_TOKEN_INTERVAL = 500;
const OLLAMA_CONNECT_TIMEOUT_MS = 2000;
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
            await validateOllamaConnection(config.baseUrl, OLLAMA_CONNECT_TIMEOUT_MS);
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

    if (!yoloActive) {
        const mode = await withExitGuard(async () => {
            return await select({
                message: 'Select execution mode:',
                choices: [
                    { name: 'Standard (Confirm all terminal commands)', value: 'standard' },
                    { name: chalk.red.bold('YOLO') + '     (Automatic command execution - USE WITH CAUTION)', value: 'yolo' }
                ],
                default: config?.yolo ? 'yolo' : 'standard'
            });
        });

        if (mode === null) process.exit(0);
        yoloActive = mode === 'yolo';
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
    const savedNumCtx = config.numCtx ?? DEFAULT_NUM_CTX;

    const numCtxInput = await input({
        message: 'Enter context length (num_ctx):',
        default: String(savedNumCtx),
        validate: (value: string) => {
            const parsed = Number.parseInt(value, 10);
            return Number.isInteger(parsed) && parsed > 0
                ? true
                : 'Please enter a positive integer.';
        },
    });
    const selectedNumCtx = Number.parseInt(numCtxInput, 10);

    const savedWebSearch = config.webSearch;
    const webSearchMaxQueriesInput = await input({
        message: 'Web search setting: max queries per tool call:',
        default: String(savedWebSearch?.maxQueries ?? DEFAULT_WEB_SEARCH_MAX_QUERIES),
        validate: (value: string) => {
            const parsed = Number.parseInt(value, 10);
            return Number.isInteger(parsed) && parsed > 0
                ? true
                : 'Please enter a positive integer.';
        },
    });
    const webSearchResultsPerQueryInput = await input({
        message: 'Web search setting: results per query:',
        default: String(savedWebSearch?.resultsPerQuery ?? DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY),
        validate: (value: string) => {
            const parsed = Number.parseInt(value, 10);
            return Number.isInteger(parsed) && parsed > 0
                ? true
                : 'Please enter a positive integer.';
        },
    });
    const selectedWebSearchMaxQueries = Number.parseInt(webSearchMaxQueriesInput, 10);
    const selectedWebSearchResultsPerQuery = Number.parseInt(webSearchResultsPerQueryInput, 10);

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
        saveSession: (tokenStats?: SessionTokenStats | null) =>
            updateSessionMessages(currentSessionId, messages, tokenStats),
        refreshTokenStatus: (phase: string) => refreshTokenStatus(phase),
        updateModel: async (model: string) => {
            currentModel = model;
            config.lastModel = currentModel;
            config.numCtx = numCtx;
            await saveConfig(config);
            console.log(chalk.green(`\nSwitched to model: ${currentModel}`));
        },
        updateSession: (sessionId: number, newMessages: ChatMessage[], isNamed: boolean) => {
            replaceMessages(messages, newMessages);
            currentSessionId = sessionId;
            sessionNamed = isNamed;
        }
    };

    let lastCompactWarningTokens = 0;
    function refreshTokenStatus(
        phase: string,
        tokensUsedOverride?: number,
        tokenSource: 'estimated' | 'ollama' = 'estimated',
    ) {
        const tokensUsed = tokensUsedOverride ?? countMessagesTokens(messages, currentModel);
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
            prompt = await search<string>({
                message: chalk.cyan('You >'),
                theme: {
                    prefix: { idle: '', done: '' },
                    style: {
                        message: (text: string, status: 'idle' | 'done' | 'loading') =>
                            status === 'done' ? '' : text,
                        answer: () => '',
                        help: () => '',
                        highlight: () => '', // Completely hide the selection text
                    },
                },
                source: async (inputArg: string | undefined) => {
                    const input = (inputArg || '');

                    // Slash commands: return matches so user can navigate/select.
                    if (input.startsWith('/')) {
                        const matches = SLASH_COMMANDS.filter(c => c.value.startsWith(input));
                        if (matches.length > 0) return matches;
                    }

                    // For standard messages, return exactly one choice matching their text.
                    // By setting highlight: () => '', this choice becomes invisible.
                    return [{ name: input, value: input }];
                },
            });
        } catch (e: unknown) {
            if (e instanceof Error && e.name === 'ExitPromptError') break;
            throw e;
        }

        if (!prompt || prompt.trim() === '') continue;

        if (prompt.toLowerCase() === 'exit') break;

        // Manually print the user's prompt to the terminal.
        // This ensures the message appears exactly once and we have full control over the prefix.
        process.stdout.write(`${chalk.cyan('You >')} ${prompt}\n`);

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
                    // Roll back history to before the turn started
                    messages.length = historyLengthBeforeTurn;
                    context.saveSession();
                    break;
                }

                const streamParams: StreamAIResponseParams = {
                    model: currentModel,
                    messages,
                    tools: TOOLS,
                    numCtx,
                };

                const { assistantMessage, interrupted: interruptedDuringStream, sessionTokenStats, finalStats } = await renderTurn(
                    baseUrl,
                    streamParams,
                    {
                        onStatusUpdate: refreshTokenStatus,
                        onFinalStats: (authoritativeTokensUsed, finalStats) => {
                            refreshTokenStatus('AI response received.', authoritativeTokensUsed, 'ollama');
                            console.log(chalk.dim(`(Used ${authoritativeTokensUsed} ${authoritativeTokensUsed === 1 ? 'token' : 'tokens'})`));
                        },
                    },
                );

                if (interruptedDuringStream) {
                    // Roll back history to before the turn started and break out of the loop
                    messages.length = historyLengthBeforeTurn;
                    context.saveSession();
                    break;
                }

                if (!assistantMessage) {
                    throw new Error('Invariant violation: assistantMessage was expected after successful renderTurn.');
                }

                messages.push(assistantMessage);

                if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                    // Execute each tool call sequentially then feed results back
                    for (const tc of assistantMessage.tool_calls) {
                        clearLiveStatus();
                        refreshTokenStatus(`Tool call: ${tc.function.name}`);
                        const toolResult = await handleToolCall(
                            tc.function.name,
                            tc.function.arguments,
                            (message) => {
                                refreshTokenStatus(message);
                            },
                        );
                        clearLiveStatus();
                        messages.push({ role: 'tool', content: toolResult });
                        refreshTokenStatus(`Tool result: ${tc.function.name}`);

                        // If the command failed, have the LLM summarize the error for the user
                        if (tc.function.name === 'run_command' && toolResult.includes('(COMMAND FAILED') && !isInterruptRequested()) {
                            refreshTokenStatus('Summarizing command error...');
                            const errorSummary = await summarizeCommandError(baseUrl, currentModel, toolResult, numCtx);
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
            console.error(chalk.red('Error communicating with Ollama:'), await getOllamaApiErrorMessage(error));
            // Roll back history to before the turn started so conversation stays consistent
            messages.length = historyLengthBeforeTurn;
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
