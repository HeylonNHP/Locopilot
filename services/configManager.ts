import { access, readFile, writeFile } from 'fs/promises';
import path from 'path';

import chalk from 'chalk';
import { input, select } from '@inquirer/prompts';

import { validateLlmConnection, getLlmApiErrorMessage } from './llm';
import { setYoloMode, setWebSearchConfig } from '../tools/tools';
import { resolveCompactionModel } from './modelManager';
import { DEFAULT_NUM_CTX, DEFAULT_OLLAMA_CHAT_TIMEOUT_MS, DEFAULT_WEB_SEARCH_MAX_QUERIES, DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT, DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY, OLLAMA_CONNECT_TIMEOUT_MS } from '../constants';
import type { Config } from '../slashCommands';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

/**
 * Loads configuration from config.json if it exists.
 * @returns Promise resolving to Config object or null if file doesn't exist
 */
export async function loadConfig(): Promise<Config | null> {
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

/**
 * Saves configuration to config.json.
 * @param config - The configuration object to save
 */
export async function saveConfig(config: Config): Promise<void> {
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Handles unexpected errors during application execution.
 * @param err - The error object
 */
export function handleUnexpectedError(err: any): void {
    if (err && err.name === 'ExitPromptError') {
        console.log('\nExiting Locopilot.');
        process.exit(0);
    }
    console.error(chalk.red('An unexpected error occurred:'), err);
    process.exit(1);
}

/**
 * Sets up Ollama connection configuration.
 * Prompts for host and port if needed, validates connection, and saves config.
 * @param initialConfig - Optional initial configuration
 * @returns Promise resolving to the final configuration
 */
export async function setupOllama(initialConfig: Config | null): Promise<Config> {
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

            const action = await select({
                message: 'What would you like to do?',
                choices: [
                    { name: 'Retry connection', value: 'retry' },
                    { name: 'Edit configuration', value: 'edit' },
                    { name: 'Exit', value: 'exit' }
                ]
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

/**
 * Configures model and context settings.
 * @param config - The application configuration
 * @param models - Array of available model names
 * @returns Promise resolving to object with model and numCtx
 */
export async function configureModelAndContext(config: Config, models: string[]): Promise<{ model: string, numCtx: number }> {
    let selectedModel = config.lastModel && models.includes(config.lastModel)
        ? config.lastModel
        : null;
    const selectedNumCtx = config.numCtx ?? DEFAULT_NUM_CTX;

    const savedWebSearch = config.webSearch;
    const selectedWebSearchMaxQueries = savedWebSearch?.maxQueries ?? DEFAULT_WEB_SEARCH_MAX_QUERIES;
    const selectedWebSearchResultsPerQuery = savedWebSearch?.resultsPerQuery ?? DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY;
    const selectedWebSearchPerPageCharLimit = savedWebSearch?.perPageCharLimit ?? DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT;

    if (!selectedModel) {
        selectedModel = await select({
            message: 'Select a model to chat with:',
            choices: models.map((m: string) => ({ name: m, value: m })),
            pageSize: 10
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

    return { model: selectedModel as string, numCtx: selectedNumCtx };
}