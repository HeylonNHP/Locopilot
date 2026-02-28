import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import {
    getToolUseNudge,
} from './tools.js';
import {
    fetchOllamaModels,
    getOllamaApiErrorMessage,
} from './ollamaApi.js';
import type { ChatMessage, OllamaModel } from './ollamaApi.js';
import { compactHistory, printCompactStats } from './compact.js';
import {
    createSession,
    listSessions,
    deleteSession,
    loadSessionMessages,
} from './history.js';
import type { Session } from './history.js';
import { clearLiveStatus } from './statusLine.js';

// --- TypeScript Interfaces ---

export interface Config {
    baseUrl: string;
    lastModel?: string;
    numCtx?: number;
    yolo?: boolean;
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
    saveSession: () => void;
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
        const models = await fetchOllamaModels(baseUrl);
        return models.map((m: OllamaModel) => m.name).sort();
    } catch (error) {
        console.error(chalk.red('Error fetching models:'), await getOllamaApiErrorMessage(error));
        return [];
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
        replaceMessages(ctx.messages, result.newMessages);
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

export const SLASH_COMMANDS: SlashCommand[] = [
    { name: chalk.blue('/model') + '    - Switch LLM model', value: '/model' },
    { name: chalk.blue('/compact') + '  - Summarise conversation history to save context', value: '/compact' },
    { name: chalk.blue('/sessions') + ' - List and switch to a previous conversation', value: '/sessions' },
    { name: chalk.blue('/delete') + '   - Delete a saved conversation', value: '/delete' },
    { name: chalk.blue('/nudge') + '    - Manually remind the AI to use tools', value: '/nudge' },
    { name: chalk.blue('/exit') + '     - Exit chat', value: '/exit' },
    { name: chalk.blue('/help') + '     - Show help', value: '/help' }
];

export const COMMAND_HANDLERS: Record<string, SlashHandler> = {
    '/model': MODEL_HANDLER,
    '/compact': COMPACT_HANDLER,
    '/sessions': SESSIONS_HANDLER,
    '/delete': DELETE_HANDLER,
    '/nudge': NUDGE_HANDLER,
    '/exit': EXIT_HANDLER,
    '/help': HELP_HANDLER
};
