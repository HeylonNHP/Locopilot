import { withExitGuard } from '../slashCommands';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';

import { listSessions, createSession, loadSessionMessages, renameSession, updateSessionMessages } from '../history';
import { setYoloMode } from '../tools/tools';
import type { Session, SessionTokenStats } from '../history';
import type { ChatMessage } from '../services/llm';
import type { Config } from '../slashCommands';

const SESSION_NAME_MAX_LENGTH = 60;

/**
 * Selects execution mode (Standard or YOLO).
 * @param config - The application configuration
 * @returns Promise resolving to boolean indicating if YOLO mode is active
 */
export async function selectExecutionMode(config: Config): Promise<boolean> {
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

/**
 * Selects or creates a chat session.
 * @param models - Array of available model names
 * @param selectedModel - The currently selected model
 * @returns Promise resolving to object with sessionId, optional messages, and model
 */
export async function selectOrCreateSession(models: string[], selectedModel: string): Promise<{ sessionId: number, messages?: ChatMessage[], model: string }> {
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