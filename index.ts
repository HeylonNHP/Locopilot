import fs from 'fs';
import { readFile, writeFile, access } from 'fs/promises';
import path from 'path';
import { select, input, search } from '@inquirer/prompts';
import chalk from 'chalk';
import {
    TOOLS,
    handleToolCall,
    getToolSystemPrompt,
    getToolUseNudge,
    sanitize,
    setYoloMode,
    setWebSearchConfig,
    isYolo,
    clearInterrupt,
    isInterruptRequested,
    installKeyInterruptListener,
    removeKeyInterruptListener,
    registerInterruptHandler,
    unregisterInterruptHandler,
} from './tools.js';
import {
    validateOllamaConnection,
    fetchOllamaModels,
    sendOllamaChatStream,
    getOllamaApiErrorMessage,
} from './ollamaApi.js';
import type { ChatMessage, OllamaModel } from './ollamaApi.js';
import { compactHistory, printCompactStats } from './compact.js';
import { summarizeCommandError } from './errorSummary.js';
import { renderMarkdown } from './markdownRenderer.js';
import {
    createSession,
    renameSession,
    listSessions,
    deleteSession,
    updateSessionMessages,
    loadSessionMessages,
} from './history.js';
import type { Session } from './history.js';
import { countMessagesTokens } from './tokenizer.js';
import { updateLiveStatus, clearLiveStatus } from './statusLine.js';

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

// --- TypeScript Interfaces ---

interface Config {
    baseUrl: string;
    lastModel?: string;
    numCtx?: number;
    yolo?: boolean;
    webSearch?: {
        maxQueries: number;
        resultsPerQuery: number;
    };
}

interface SlashCommand {
    name: string;
    value: string;
}

interface ChatContext {
    baseUrl: string;
    currentModel: string;
    numCtx: number;
    messages: ChatMessage[];
    currentSessionId: number;
    config: Config;
    systemPrompt: string;
    saveSession: () => void;
    refreshTokenStatus: (phase: string) => void;
    updateModel: (model: string) => Promise<void>;
    updateSession: (sessionId: number, messages: ChatMessage[], sessionNamed: boolean) => void;
}

type SlashHandler = (ctx: ChatContext) => Promise<boolean | 'break'>;

// --- Functions ---

async function loadConfig(): Promise<Config | null> {
    try {
        await access(CONFIG_PATH);
        const data = await readFile(CONFIG_PATH, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        // If file doesn't exist (ENOENT), return null silently.
        // For other errors (parsing), log it.
        if (e && (e as any).code !== 'ENOENT') {
            console.error(chalk.red('Error reading or parsing config file.'));
        }
        return null;
    }
}

async function saveConfig(config: Config): Promise<void> {
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Executes a function and catches @inquirer/prompts' ExitPromptError (Ctrl+C).
 * Returns the result or null if the user cancelled.
 */
async function withExitGuard<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
        return await fn();
    } catch (e: unknown) {
        if (e instanceof Error && e.name === 'ExitPromptError') {
            return null;
        }
        throw e;
    }
}

// --- Command Handlers ---

const HELP_HANDLER: SlashHandler = async (ctx) => {
    console.log(chalk.blue('\nAvailable Commands:'));
    SLASH_COMMANDS.forEach(cmd => console.log(`  ${cmd.name}`));
    console.log('');
    return true;
};

const MODEL_HANDLER: SlashHandler = async (ctx) => {
    console.log(chalk.blue('\nRefreshing models from Ollama...'));
    const latestModels = await getModels(ctx.baseUrl);
    if (latestModels.length === 0) {
        console.log(chalk.red('No models found. Please pull a model first.'));
        return true;
    }

    console.log(chalk.green('\nAvailable models:'));
    latestModels.forEach((m: string, i: number) => console.log(`  ${i + 1}. ${m}`));

    let selectedModel: string | null = null;
    selectedModel = await withExitGuard(async () => {
        return await select({
            message: 'Select a model to chat with:',
            choices: latestModels.map((m: string) => ({ name: m, value: m })),
            pageSize: 10
        });
    });

    if (selectedModel === null) {
        console.log(chalk.yellow('Model selection cancelled.'));
        return true;
    }

    if (selectedModel) {
        await ctx.updateModel(selectedModel);
    }
    return true;
};

const COMPACT_HANDLER: SlashHandler = async (ctx) => {
    if (ctx.messages.length <= 1) {
        console.log(chalk.yellow('Nothing to compact yet — the conversation history is empty.\n'));
        return true;
    }
    try {
        ctx.refreshTokenStatus('AI request queued for compaction...');
        const result = await compactHistory(
            ctx.baseUrl,
            ctx.currentModel,
            ctx.messages,
            ctx.numCtx,
            (status) => ctx.refreshTokenStatus(status),
        );
        clearLiveStatus();
        printCompactStats(result.stats);
        
        // Re-initialize message array while keeping reference
        ctx.messages.length = 0;
        ctx.messages.push(...result.newMessages);
        ctx.saveSession();
    } catch (err) {
        clearLiveStatus();
        console.error(chalk.red('Compaction failed:'), await getOllamaApiErrorMessage(err));
    }
    return true;
};

const SESSIONS_HANDLER: SlashHandler = async (ctx) => {
    const sessions = listSessions();
    if (sessions.length === 0) {
        console.log(chalk.yellow('No saved sessions yet.\n'));
        return true;
    }
    // Save current state before switching.
    ctx.saveSession();
    const picked = await withExitGuard(async () => {
        return await select<number>({
            message: 'Select a session to switch to:',
            choices: sessions.map((s: Session) => ({
                name: `[${s.id}] ${s.name}  ${chalk.dim('(' + s.model + ' · ' + s.updated_at + ')')}`,
                value: s.id,
            })),
            pageSize: 15,
        });
    });

    if (picked === null) {
        console.log(chalk.yellow('Session switch cancelled.'));
        return true;
    }

    if (picked !== null) {
        const loaded = loadSessionMessages(picked);
        const pickedSession = sessions.find((s: Session) => s.id === picked);
        if (pickedSession) {
            await ctx.updateModel(pickedSession.model);
        }
        ctx.updateSession(picked, loaded, true);
        console.log(chalk.green(`\nSwitched to session: ${pickedSession?.name ?? picked} (Model: ${ctx.currentModel})\n`));
    }
    return true;
};

const DELETE_HANDLER: SlashHandler = async (ctx) => {
    const sessions = listSessions();
    if (sessions.length === 0) {
        console.log(chalk.yellow('No saved sessions to delete.\n'));
        return true;
    }
    const toDelete = await withExitGuard(async () => {
        return await select<number>({
            message: 'Select a session to delete:',
            choices: sessions.map((s: Session) => ({
                name: `[${s.id}] ${s.name}  ${chalk.dim('(' + s.model + ' · ' + s.updated_at + ')')}`,
                value: s.id,
            })),
            pageSize: 15,
        });
    });

    if (toDelete === null) {
        console.log(chalk.yellow('Deletion cancelled.'));
        return true;
    }

    if (toDelete !== null) {
        const target = sessions.find((s: Session) => s.id === toDelete);
        deleteSession(toDelete);
        console.log(chalk.green(`\nDeleted session: ${target?.name ?? toDelete}\n`));
        // If the deleted session was active, start a fresh one.
        if (toDelete === ctx.currentSessionId) {
            const newId = createSession('New Session', ctx.currentModel);
            const freshMessages: ChatMessage[] = [{ role: 'system', content: ctx.systemPrompt }];
            ctx.updateSession(newId, freshMessages, false);
            console.log(chalk.dim('Started a new session.\n'));
        }
    }
    return true;
};

const NUDGE_HANDLER: SlashHandler = async (ctx) => {
    ctx.messages.push({ role: 'user', content: getToolUseNudge() });
    console.log(chalk.dim('\n[Manual nudge sent to AI...]\n'));
    return false; // Continue with AI generation loop
};

const EXIT_HANDLER: SlashHandler = async () => 'break';

const SLASH_COMMANDS: SlashCommand[] = [
    { name: chalk.blue('/model') + '    - Switch LLM model', value: '/model' },
    { name: chalk.blue('/compact') + '  - Summarise conversation history to save context', value: '/compact' },
    { name: chalk.blue('/sessions') + ' - List and switch to a previous conversation', value: '/sessions' },
    { name: chalk.blue('/delete') + '   - Delete a saved conversation', value: '/delete' },
    { name: chalk.blue('/nudge') + '    - Manually remind the AI to use tools', value: '/nudge' },
    { name: chalk.blue('/exit') + '     - Exit chat', value: '/exit' },
    { name: chalk.blue('/help') + '     - Show help', value: '/help' }
];

const COMMAND_HANDLERS: Record<string, SlashHandler> = {
    '/model': MODEL_HANDLER,
    '/compact': COMPACT_HANDLER,
    '/sessions': SESSIONS_HANDLER,
    '/delete': DELETE_HANDLER,
    '/nudge': NUDGE_HANDLER,
    '/exit': EXIT_HANDLER,
    '/help': HELP_HANDLER
};

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
            // Validate connection
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
            if (action === 'edit') config = null;
            // if retry, loop will continue with existing config
        }
    }
}

async function getModels(baseUrl: string): Promise<string[]> {
    try {
        const models = await fetchOllamaModels(baseUrl);
        return models.map((m: OllamaModel) => m.name).sort();
    } catch (error) {
        console.error(chalk.red('Error fetching models:'), await getOllamaApiErrorMessage(error));
        return [];
    }
}

async function startChat(
    model: string,
    numCtx: number,
    sessionId: number,
    config: Config,
    preloadedMessages?: import('./ollamaApi.js').ChatMessage[],
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

    // Persists the current in-memory message list to the database.
    const saveSession = () => updateSessionMessages(currentSessionId, messages);

    // Register cleanup for SIGINT (Ctrl+C)
    cleanupBeforeExit = saveSession;

    const context: ChatContext = {
        get baseUrl() { return baseUrl; },
        get currentModel() { return currentModel; },
        get numCtx() { return numCtx; },
        get messages() { return messages; },
        get currentSessionId() { return currentSessionId; },
        get config() { return config; },
        get systemPrompt() { return systemPrompt; },
        saveSession,
        refreshTokenStatus: (phase: string) => refreshTokenStatus(phase),
        updateModel: async (model: string) => {
            currentModel = model;
            config.lastModel = currentModel;
            config.numCtx = numCtx;
            await saveConfig(config);
            console.log(chalk.green(`\nSwitched to model: ${currentModel}`));
        },
        updateSession: (sessionId: number, newMessages: ChatMessage[], isNamed: boolean) => {
            messages.length = 0;
            messages.push(...newMessages);
            currentSessionId = sessionId;
            sessionNamed = isNamed;
        }
    };

    let lastCompactWarningTokens = 0;
    function refreshTokenStatus(phase: string) {
        const tokensUsed = countMessagesTokens(messages, currentModel);
        updateLiveStatus({
            phase,
            tokensUsed,
            tokenLimit: numCtx,
            model: currentModel,
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

    while (true) {
        let prompt: string;
        try {
            prompt = await search({
                message: chalk.cyan('You >'),
                theme: {
                    prefix: { idle: '', done: '' },
                    style: {
                        message: (text: string, status: 'idle' | 'done' | 'loading') =>
                            status === 'done' ? '' : text,
                        answer: () => '',
                    },
                },
                source: async (inputArg: string | undefined) => {
                    if (!inputArg) {
                        return [{ name: chalk.dim('Type a message or / for commands...'), value: '' }];
                    }

                    if (inputArg.startsWith('/')) {
                        const matches = SLASH_COMMANDS.filter(c => c.value.startsWith(inputArg));
                        if (matches.length > 0) return matches;
                    }

                    return [{ name: inputArg, value: inputArg }];
                },
            });
        } catch (e: unknown) {
            if (e instanceof Error && e.name === 'ExitPromptError') break;
            throw e;
        }

        if (!prompt || prompt.trim() === '') continue;
        if (prompt.toLowerCase() === 'exit') break;

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
                    saveSession();
                    break;
                }

                refreshTokenStatus('AI is responding...');

                const streamAbortController = new AbortController();
                const streamedToolCalls: NonNullable<ChatMessage['tool_calls']> = [];
                let streamedAssistantContent = '';
                let interruptedDuringStream = false;

                registerInterruptHandler(() => {
                    streamAbortController.abort();
                });

                try {
                    for await (const chunk of sendOllamaChatStream(baseUrl, {
                        model: currentModel,
                        messages,
                        tools: TOOLS,
                        numCtx,
                        signal: streamAbortController.signal,
                    })) {
                        if (isInterruptRequested()) {
                            interruptedDuringStream = true;
                            streamAbortController.abort();
                            break;
                        }

                        const chunkContent = chunk.message.content ?? '';
                        if (chunkContent.length > 0) {
                            streamedAssistantContent += chunkContent;
                            refreshTokenStatus(`AI is responding... (${streamedAssistantContent.length} chars)`);
                        }

                        if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
                            streamedToolCalls.push(...chunk.message.tool_calls);
                        }
                    }
                } catch (error) {
                    if (isInterruptRequested()) {
                        interruptedDuringStream = true;
                    } else {
                        throw error;
                    }
                } finally {
                    unregisterInterruptHandler();
                }

                if (interruptedDuringStream) {
                    if (streamedAssistantContent.trim().length > 0) {
                        clearLiveStatus();
                        process.stdout.write(chalk.yellow('\nAI (interrupted) > '));
                        process.stdout.write(renderMarkdown(sanitize(streamedAssistantContent)));
                        process.stdout.write('\n');
                    }
                    // Roll back history to before the turn started and break out of the loop
                    messages.length = historyLengthBeforeTurn;
                    saveSession();
                    break;
                }

                if (streamedAssistantContent.trim().length > 0) {
                    clearLiveStatus();
                    process.stdout.write(chalk.yellow('\nAI > '));
                    process.stdout.write(renderMarkdown(sanitize(streamedAssistantContent)));
                    process.stdout.write('\n');
                }

                const assistantMessage: ChatMessage = {
                    role: 'assistant',
                    content: streamedAssistantContent,
                    ...(streamedToolCalls.length > 0 ? { tool_calls: streamedToolCalls } : {}),
                };

                messages.push(assistantMessage);
                refreshTokenStatus('AI response received.');

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
                        const fallbackContent = '[No response content was returned by the model after tool execution.]';
                        clearLiveStatus();
                        process.stdout.write(chalk.yellow('\nAI > '));
                        process.stdout.write(renderMarkdown(sanitize(fallbackContent)));
                        process.stdout.write('\n');
                    }

                    config.lastModel = currentModel;
                    config.numCtx = numCtx;
                    await saveConfig(config);
                    saveSession();
                    break;
                }
            }
        } catch (error) {
            clearLiveStatus();
            console.error(chalk.red('Error communicating with Ollama:'), await getOllamaApiErrorMessage(error));
            // Roll back history to before the turn started so conversation stays consistent
            messages.length = historyLengthBeforeTurn;
            saveSession();
        } finally {
            clearLiveStatus();
            removeKeyInterruptListener();
        }
    }
}

async function main(): Promise<void> {
    const yoloEnv = process.env.YOLO?.toLowerCase();
    let yoloActive = process.argv.some(arg => arg === '--yolo' || arg === '-y') ||
                     yoloEnv === 'true' ||
                     yoloEnv === '1';

    let config = await loadConfig();
    config = await setupOllama(config);

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

        if (mode === null) {
            process.exit(0);
        }
        yoloActive = mode === 'yolo';
    }

    if (yoloActive) {
        setYoloMode(true);
        console.log(chalk.red.bold('\n⚠️  YOLO MODE ACTIVATED: Commands will execute automatically without confirmation. ⚠️\n'));
    } else {
        setYoloMode(false);
    }

    console.log(chalk.blue('Fetching models from ' + config.baseUrl + '...'));
    const models = await getModels(config.baseUrl);

    if (!models || models.length === 0) {
        console.log(chalk.red('No models found in Ollama. Please pull a model first (e.g., ollama pull llama3).'));
        return;
    }

    console.log(chalk.green(`Found ${models.length} models:`));
    models.forEach((m: string, i: number) => console.log(`  ${i + 1}. ${m}`));

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

        if (selectedModel === null) {
            process.exit(0);
        }
    }

    // Persist selected model and context length
    config.lastModel = selectedModel;
    config.numCtx = selectedNumCtx;
    config.yolo = yoloActive;
    config.webSearch = {
        maxQueries: selectedWebSearchMaxQueries,
        resultsPerQuery: selectedWebSearchResultsPerQuery,
    };
    await saveConfig(config);

    setWebSearchConfig({
        maxQueries: config.webSearch.maxQueries,
        resultsPerQuery: config.webSearch.resultsPerQuery,
    });

    // ── Session management ──────────────────────────────────────────────
    const savedSessions = listSessions();
    let startingSessionId: number;
    let startingMessages: ChatMessage[] | undefined;

    if (savedSessions.length > 0) {
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

        if (sessionChoice === 'new') {
            startingSessionId = createSession('New Session', selectedModel as string);
        } else {
            startingSessionId = sessionChoice;
            const resumedSession = savedSessions.find(s => s.id === startingSessionId);
            if (resumedSession) {
                if (models.includes(resumedSession.model)) {
                    selectedModel = resumedSession.model;
                } else {
                    console.log(chalk.yellow(`\n⚠️ Resumed session used model '${resumedSession.model}', which is not currently available.`));
                    console.log(chalk.yellow(`Continuing with '${selectedModel}' instead.\n`));
                }
            }
            startingMessages = loadSessionMessages(startingSessionId);
            console.log(chalk.dim(`Resuming session [${startingSessionId}] with ${startingMessages.length} messages.`));
        }
    } else {
        startingSessionId = createSession('New Session', selectedModel as string);
    }
    // ────────────────────────────────────────────────────────────────────

    await startChat(selectedModel as string, selectedNumCtx, startingSessionId, config, startingMessages);
}

process.on('SIGINT', () => {
    if (cleanupBeforeExit) {
        cleanupBeforeExit();
    }
    console.log('\nExiting Locopilot.');
    process.exit(0);
});

main().catch(err => {
    if (err && err.name === 'ExitPromptError') {
        // Graceful exit for Ctrl+C
        console.log('\nExiting Locopilot.');
        process.exit(0);
    }
    console.error(chalk.red('An unexpected error occurred:'), err);
});