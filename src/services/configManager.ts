import { input, select } from '@inquirer/prompts';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Config } from '../types/chatConfig';

import { logger } from '../app/lib/logger';
import {
  DEFAULT_NUM_CTX,
  DEFAULT_WEB_SEARCH_MAX_QUERIES,
  DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
  DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY,
  OLLAMA_CONNECT_TIMEOUT_MS,
} from '../constants';
import { configureLlmAdapter, validateLlmConnection } from './llm';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const CONFIG_TMP_PATH = `${CONFIG_PATH}.tmp`;
let configWriteQueue: Promise<void> = Promise.resolve();

export async function loadConfig(): Promise<Config | null> {
  try {
    await access(CONFIG_PATH);
    const data = await readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('Config', 'Error reading or parsing config file.');
    }
    return null;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  const task = async () => {
    await writeFile(CONFIG_TMP_PATH, JSON.stringify(config, null, 2));
    await rename(CONFIG_TMP_PATH, CONFIG_PATH);
  };
  configWriteQueue = configWriteQueue.then(task, task);
  return configWriteQueue;
}

/**
 * Handles unexpected errors during application execution.
 * @param err - The error object
 */
export function handleUnexpectedError(err: unknown): void {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    logger.info('Config', '\nExiting Locopilot.');
    // Intentional CLI termination on user interrupting an inquirer prompt.
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
  }
  logger.error('Config', 'An unexpected error occurred', { error: err instanceof Error ? err.message : String(err) });
  // Intentional fatal CLI termination; this is the top-level error handler.
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
}

export async function setupOllama(initialConfig: Config | null): Promise<Config> {
  let config = initialConfig;
  while (true) {
    if (!config) {
      logger.info('Config', 'Initial Configuration Required');
      const host = await input({
        message: 'Enter Ollama host (e.g., localhost):',
        default: 'localhost',
      });
      const port = await input({ message: 'Enter Ollama port:', default: '11434' });
      config = {
        baseUrl: `http://${host}:${port}`,
        provider: 'ollama',
      };
    }
    configureLlmAdapter(config.provider);
    try {
      await validateLlmConnection(config.baseUrl, OLLAMA_CONNECT_TIMEOUT_MS);
      await saveConfig(config);
      return config;
    } catch {
      logger.error('Config', `Could not connect to Ollama at ${config.baseUrl}`);
      logger.warn('Config', 'Please check if Ollama is running and the address is correct.');
      const action = await select({
        message: 'What would you like to do?',
        choices: [
          { name: 'Retry connection', value: 'retry' },
          { name: 'Edit configuration', value: 'edit' },
          { name: 'Exit', value: 'exit' },
        ],
      });
      if (action === 'exit' || action === null) {
        // User chose to quit the interactive setup; terminate the CLI cleanly.
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(0);
      }
      if (action === 'edit') {
        config = null;
        continue;
      }
    }
  }
}

export async function configureModelAndContext(
  config: Config,
  models: string[]
): Promise<{ model: string; numCtx: number }> {
  let selectedModel =
    config.lastModel && models.includes(config.lastModel) ? config.lastModel : null;
  const selectedNumCtx = config.numCtx ?? DEFAULT_NUM_CTX;
  const savedWebSearch = config.webSearch;
  const selectedWebSearchMaxQueries = savedWebSearch?.maxQueries ?? DEFAULT_WEB_SEARCH_MAX_QUERIES;
  const selectedWebSearchResultsPerQuery =
    savedWebSearch?.resultsPerQuery ?? DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY;
  const selectedWebSearchPerPageCharLimit =
    savedWebSearch?.perPageCharLimit ?? DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT;
  if (!selectedModel) {
    selectedModel = await select({
      message: 'Select a model to chat with:',
      choices: models.map((m: string) => ({ name: m, value: m })),
      pageSize: 10,
    });
    if (selectedModel === null) {
      // User cancelled model selection; terminate the CLI cleanly.
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(0);
    }
  }
  config.lastModel = selectedModel;
  config.numCtx = selectedNumCtx;
  config.webSearch = {
    maxQueries: selectedWebSearchMaxQueries,
    resultsPerQuery: selectedWebSearchResultsPerQuery,
    perPageCharLimit: selectedWebSearchPerPageCharLimit,
  };
  return { model: selectedModel as string, numCtx: selectedNumCtx };
}
