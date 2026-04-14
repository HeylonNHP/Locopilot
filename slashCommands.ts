import chalk from 'chalk';
import { select, input } from '@inquirer/prompts';
import * as readline from 'readline';
import {
    getToolUseNudge,
    setYoloMode,
    setWebSearchConfig,
} from './tools/tools.js';
import {
    DEFAULT_NUM_CTX,
    DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
    DEFAULT_WEB_SEARCH_MAX_QUERIES,
    DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY,
} from './constants.js';
import {
    fetchLlmModels,
    getLlmApiErrorMessage,
} from './services/llm.js';
import type { ChatMessage, LlmModel } from './services/llm.js';
import { compactHistory, printCompactStats } from './services/compact.js';
import { writeConversationHistoryDump } from './services/historyDump.js';
import {
    createSession,
    listSessions,
    deleteSession,
    loadSessionMessages,
} from './history.js';
import type { Session } from './history.js';
import type { SessionTokenStats } from './history.js';
import { clearLiveStatus } from './statusLine.js';

// --- TypeScript Interfaces ---

export interface Config {
    baseUrl: string;
    lastModel?: string;
    numCtx?: number;
    chatTimeoutMs?: number;
    yolo?: boolean;
    thinkingEnabled?: boolean;
    webSearch?: {
        maxQueries: number;
        resultsPerQuery: number;
    };
}

export interface SlashCommand {
    name: string;
    value: string;
}

export interface ChatContext {
    baseUrl: string;
    currentModel: string;
    numCtx: number;
    messages: ChatMessage[];
    currentSessionId: number;
    config: Config;
    systemPrompt: string;
    thinkingSupported?: boolean;
    saveConfig: (config: Config) => Promise<void>;
    updateNumCtx: (numCtx: number) => void;
    saveSession: (tokenStats?: SessionTokenStats | null) => void;
    refreshTokenStatus: (phase: string) => void;
    updateModel: (model: string) => Promise<void>;
    updateSession: (sessionId: number, messages: ChatMessage[], sessionNamed: boolean) => void;
}

export type SlashHandler = (ctx: ChatContext) => Promise<boolean | 'break'>;

// --- Utility Functions ---

/**
 * Executes a function and catches @inquirer/prompts' ExitPromptError (Ctrl+C).
 * Returns the result or null if the user cancelled.
 */
export async function withExitGuard<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
        return await fn();
    } catch (e: unknown) {
        if (e instanceof Error && e.name === 'ExitPromptError') {
            return null;
        }
        throw e;
    }
}

/**
 * Safely replaces all elements in an array while maintaining the reference.
 */
export function replaceMessages(target: ChatMessage[], newMessages: ChatMessage[]): void {
    target.length = 0;
    target.push(...newMessages);
}

export async function getModels(baseUrl: string): Promise<string[]> {
    try {
        const models = await fetchLlmModels(baseUrl);
        return models.map((m: LlmModel) => m.name).sort();
    } catch (error) {
        console.error(chalk.red('Error fetching models:'), await getLlmApiErrorMessage(error));
        return [];
    }
}

export async function getMultilineInput(promptStr: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const commands = SLASH_COMMANDS.map((command) => command.value);
        const completer = (line: string) => {
            const hits = commands.filter((command) => command.startsWith(line));
            return [hits.length ? hits : commands, line];
        };

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: promptStr,
            terminal: true,
            historySize: 500,
            completer,
        });

        let buffer: string[] = [];
        let pasteTimeout: ReturnType<typeof setTimeout> | null = null;
        let inBlock = false;

        const cleanup = () => {
            process.stdin.removeListener('keypress', onKeypress);
        };

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
                        choices: SLASH_COMMANDS.map((command) => ({
                            name: command.name,
                            value: command.value,
                        })),
                        pageSize: 10,
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
            default: ctx.currentModel,
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
        replaceMessages(ctx.messages, result.newMessages);
        ctx.saveSession();
    } catch (err) {
        clearLiveStatus();
        console.error(chalk.red('Compaction failed:'), await getLlmApiErrorMessage(err));
    }
    return true;
};

const DUMP_HANDLER: SlashHandler = async (ctx) => {
    const currentSession = listSessions().find((session: Session) => session.id === ctx.currentSessionId);

    try {
        const result = await writeConversationHistoryDump({
            sessionId: ctx.currentSessionId,
            sessionName: currentSession?.name,
            currentModel: ctx.currentModel,
            baseUrl: ctx.baseUrl,
            runtimeNumCtx: ctx.numCtx,
            savedNumCtx: ctx.config.numCtx,
            systemPrompt: ctx.systemPrompt,
            messages: ctx.messages,
            config: ctx.config,
        });

        console.log(chalk.green(`\nConversation history dumped to ${result.filePath}\n`));
    } catch (error) {
        console.error(
            chalk.red('History dump failed:'),
            error instanceof Error ? error.message : String(error),
        );
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

const NEW_HANDLER: SlashHandler = async (ctx) => {
    // Save current session before switching
    ctx.saveSession();

    const newId = createSession('New Session', ctx.currentModel);
    const freshMessages: ChatMessage[] = [{ role: 'system', content: ctx.systemPrompt }];
    
    // Switch to the new session record and message array
    ctx.updateSession(newId, freshMessages, false);
    
    console.log(chalk.green('\nStarted a new conversation.\n'));
    return true; // Continue chat loop
};

const SETTINGS_HANDLER: SlashHandler = async (ctx) => {
    const action = await withExitGuard(async () => {
        return await select({
            message: 'Menu: Settings',
            choices: [
                { name: `Execution Mode (${ctx.config.yolo ? 'YOLO' : 'Standard'})`, value: 'mode' },
                { name: `Thinking (${ctx.config.thinkingEnabled !== false ? chalk.green('Enabled') : chalk.red('Disabled')})`, value: 'thinking' },
                { name: `Context Length (${ctx.config.numCtx ?? DEFAULT_NUM_CTX})`, value: 'num_ctx' },
                { name: `Chat Timeout (${(ctx.config.chatTimeoutMs ?? DEFAULT_OLLAMA_CHAT_TIMEOUT_MS) / 1000}s)`, value: 'chat_timeout' },
                { name: `Web Search: Max Queries (${ctx.config.webSearch?.maxQueries ?? DEFAULT_WEB_SEARCH_MAX_QUERIES})`, value: 'web_max_queries' },
                { name: `Web Search: Results Per Query (${ctx.config.webSearch?.resultsPerQuery ?? DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY})`, value: 'web_results_per_query' },
                { name: 'Back to Chat', value: 'back' }
            ]
        });
    });

    if (action === null || action === 'back') return true;

    if (action === 'mode') {
        const mode = await withExitGuard(async () => {
            return await select({
                message: 'Select execution mode:',
                choices: [
                    { name: 'Standard (Confirm all terminal commands)', value: 'standard' },
                    { name: chalk.red.bold('YOLO') + '     (Automatic command execution - USE WITH CAUTION)', value: 'yolo' }
                ],
                default: ctx.config.yolo ? 'yolo' : 'standard'
            });
        });
        if (mode !== null) {
            const isYolo = mode === 'yolo';
            await ctx.saveConfig({ ...ctx.config, yolo: isYolo });
            setYoloMode(isYolo);
            console.log(chalk.green(`\nExecution mode set to ${isYolo ? chalk.red.bold('YOLO') : 'Standard'}\n`));
        }
    } else if (action === 'thinking') {
        const thinking = await withExitGuard(async () => {
            return await select({
                message: 'Should models use "Thinking" when supported?',
                choices: [
                    { name: 'Enabled (Produce reasoning trace for complex tasks)', value: 'on' },
                    { name: 'Disabled (Direct answers only)', value: 'off' }
                ],
                default: ctx.config.thinkingEnabled !== false ? 'on' : 'off'
            });
        });
        if (thinking !== null) {
            const isEnabled = thinking === 'on';
            await ctx.saveConfig({ ...ctx.config, thinkingEnabled: isEnabled });
            console.log(chalk.green(`\nThinking mode: ${isEnabled ? chalk.green('Enabled') : chalk.red('Disabled')}\n`));
        }
    } else if (action === 'num_ctx') {
        const numCtxInput = await withExitGuard(async () => {
            return await input({
                message: 'Enter context length (num_ctx):',
                default: String(ctx.config.numCtx ?? DEFAULT_NUM_CTX),
                validate: (value: string) => {
                    const parsed = Number.parseInt(value, 10);
                    return Number.isInteger(parsed) && parsed > 0
                        ? true
                        : 'Please enter a positive integer.';
                },
            });
        });
        if (numCtxInput !== null) {
            const parsed = Number.parseInt(numCtxInput, 10);
            await ctx.saveConfig({ ...ctx.config, numCtx: parsed });
            ctx.updateNumCtx(parsed);
            if (ctx.numCtx < parsed) {
                console.log(
                    chalk.yellow(
                        `\nContext length preference saved as ${parsed}, but ${ctx.currentModel} is capped at ${ctx.numCtx} for now.\n`,
                    ),
                );
            } else {
                console.log(chalk.green(`\nContext length updated to ${parsed}\n`));
            }
        }
    } else if (action === 'chat_timeout') {
        const timeoutInput = await withExitGuard(async () => {
            return await input({
                message: 'Enter chat timeout in seconds:',
                default: String((ctx.config.chatTimeoutMs ?? DEFAULT_OLLAMA_CHAT_TIMEOUT_MS) / 1000),
                validate: (value: string) => {
                    const parsed = Number.parseFloat(value);
                    return Number.isFinite(parsed) && parsed > 0
                        ? true
                        : 'Please enter a positive number.';
                },
            });
        });
        if (timeoutInput !== null) {
            const parsedMs = Math.floor(Number.parseFloat(timeoutInput) * 1000);
            await ctx.saveConfig({ ...ctx.config, chatTimeoutMs: parsedMs });
            console.log(chalk.green(`\nChat timeout updated to ${parsedMs / 1000}s\n`));
        }
    } else if (action === 'web_max_queries') {
        const inputVal = await withExitGuard(async () => {
            return await input({
                message: 'Web search setting: max queries per tool call:',
                default: String(ctx.config.webSearch?.maxQueries ?? DEFAULT_WEB_SEARCH_MAX_QUERIES),
                validate: (value: string) => {
                    const parsed = Number.parseInt(value, 10);
                    return Number.isInteger(parsed) && parsed > 0
                        ? true
                        : 'Please enter a positive integer.';
                },
            });
        });
        if (inputVal !== null) {
            const parsed = Number.parseInt(inputVal, 10);
            const newWebSearch = {
                maxQueries: parsed,
                resultsPerQuery: ctx.config.webSearch?.resultsPerQuery ?? DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY,
            };
            await ctx.saveConfig({ ...ctx.config, webSearch: newWebSearch });
            setWebSearchConfig(newWebSearch);
            console.log(chalk.green(`\nMax queries updated to ${parsed}\n`));
        }
    } else if (action === 'web_results_per_query') {
        const inputVal = await withExitGuard(async () => {
            return await input({
                message: 'Web search setting: results per query:',
                default: String(ctx.config.webSearch?.resultsPerQuery ?? DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY),
                validate: (value: string) => {
                    const parsed = Number.parseInt(value, 10);
                    return Number.isInteger(parsed) && parsed > 0
                        ? true
                        : 'Please enter a positive integer.';
                },
            });
        });
        if (inputVal !== null) {
            const parsed = Number.parseInt(inputVal, 10);
            const newWebSearch = {
                maxQueries: ctx.config.webSearch?.maxQueries ?? DEFAULT_WEB_SEARCH_MAX_QUERIES,
                resultsPerQuery: parsed,
            };
            await ctx.saveConfig({ ...ctx.config, webSearch: newWebSearch });
            setWebSearchConfig(newWebSearch);
            console.log(chalk.green(`\nResults per query updated to ${parsed}\n`));
        }
    }

    return true; // Continue chat loop
};

export const SLASH_COMMANDS: SlashCommand[] = [
    { name: chalk.blue('/new') + '      - Start a fresh conversation', value: '/new' },
    { name: chalk.blue('/model') + '    - Switch LLM model', value: '/model' },
    { name: chalk.blue('/settings') + ' - Change session and app settings', value: '/settings' },
    { name: chalk.blue('/compact') + '  - Summarise conversation history to save context', value: '/compact' },
    { name: chalk.blue('/dump') + '     - Export the current conversation as a markdown debug file', value: '/dump' },
    { name: chalk.blue('/sessions') + ' - List and switch to a previous conversation', value: '/sessions' },
    { name: chalk.blue('/delete') + '   - Delete a saved conversation', value: '/delete' },
    { name: chalk.blue('/nudge') + '    - Manually remind the AI to use tools', value: '/nudge' },
    { name: chalk.blue('/exit') + '     - Exit chat', value: '/exit' },
    { name: chalk.blue('/help') + '     - Show help', value: '/help' }
];

export const COMMAND_HANDLERS: Record<string, SlashHandler> = {
    '/new': NEW_HANDLER,
    '/model': MODEL_HANDLER,
    '/settings': SETTINGS_HANDLER,
    '/compact': COMPACT_HANDLER,
    '/dump': DUMP_HANDLER,
    '/sessions': SESSIONS_HANDLER,
    '/delete': DELETE_HANDLER,
    '/nudge': NUDGE_HANDLER,
    '/exit': EXIT_HANDLER,
    '/help': HELP_HANDLER
};
