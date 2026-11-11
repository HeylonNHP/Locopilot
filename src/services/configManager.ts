import { readFile, rename, writeFile } from 'node:fs/promises';

import type { Config } from '@/types/chatConfig';

import { logger } from '@/app/lib/logger';
import { DEFAULT_OLLAMA_CHAT_TIMEOUT_MS } from '@/constants';
import {
  DEFAULT_ADAPTER_RETRY,
  DEFAULT_MAX_PROMPT_LOOP_ITERATIONS,
  DEFAULT_WEB_SEARCH_SETTINGS,
  FRESH_CONFIG_NUM_CTX,
} from '@/services/configDefaults';
import { CONFIG_PATH, CONFIG_TMP_PATH } from '@/services/paths';

let configWriteQueue: Promise<void> = Promise.resolve();

/**
 * The result of reading `config.json`.
 *
 * - `ok: true` with a config: the file was read, or it was MISSING and a fresh
 *   one was just created with defaults (`created: true`).
 * - `ok: false`: the file exists but cannot be read or parsed, or it is missing
 *   and could not be created. The file is never overwritten in that case: a
 *   broken file is the owner's to repair, and replacing it would destroy their
 *   providers, keys and settings.
 */
export type ConfigReadResult =
  | { ok: true; config: Config; created: boolean }
  | { ok: false; message: string };

/**
 * The defaults a FRESH `config.json` is created with: everything a user would
 * otherwise have to type, except the provider and the model, which only the user
 * can choose. Until a model is chosen in Settings, chat is refused.
 */
export function buildFreshConfig(): Config {
  return {
    providers: [],
    model: '',
    compactionModel: '',
    numCtx: FRESH_CONFIG_NUM_CTX,
    chatTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
    yolo: false,
    thinkingEnabled: true,
    promptTimestamps: true,
    citeSources: true,
    redactSecrets: true,
    webSearch: { ...DEFAULT_WEB_SEARCH_SETTINGS },
    completionMode: 'normal',
    maxPromptLoopIterations: DEFAULT_MAX_PROMPT_LOOP_ITERATIONS,
    retry: { ...DEFAULT_ADAPTER_RETRY },
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}

function unreadable(detail: string): ConfigReadResult {
  return {
    ok: false,
    message: `config.json exists but could not be read (${detail}). Locopilot will not overwrite it: fix or restore the file by hand, then reload.`,
  };
}

/** Parse the text of an existing file. Anything that is not a JSON object is unreadable. */
function parseConfigText(text: string): ConfigReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return unreadable(`it is not valid JSON: ${describeError(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return unreadable('its top level is not a JSON object');
  }
  return { ok: true, config: parsed as Config, created: false };
}

/** Read an existing file; `null` when there is no file at all. */
async function readExisting(path: string): Promise<ConfigReadResult | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) {
      return null;
    }
    return unreadable(describeError(err));
  }
  return parseConfigText(text);
}

/**
 * Create the fresh file, only if nothing is there. The `wx` flag makes the
 * creation fail if another request created the file a moment earlier, and that
 * file is then read instead of replaced.
 */
async function createFreshConfig(path: string): Promise<ConfigReadResult> {
  const config = buildFreshConfig();
  try {
    await writeFile(path, JSON.stringify(config, null, 2), { flag: 'wx' });
  } catch (err) {
    if (isErrno(err, 'EEXIST')) {
      return (await readExisting(path)) ?? unreadable('it was removed while it was being created');
    }
    return {
      ok: false,
      message: `config.json is missing and could not be created (${describeError(err)}).`,
    };
  }
  logger.info('Config', 'Created config.json with default settings. Choose a model in Settings.');
  return { ok: true, config, created: true };
}

/**
 * Read `config.json`, creating it with defaults when it is missing. See
 * {@link ConfigReadResult} for what each outcome means.
 */
export async function readConfig(path: string = CONFIG_PATH): Promise<ConfigReadResult> {
  const existing = await readExisting(path);
  if (existing !== null) {
    return existing;
  }
  return createFreshConfig(path);
}

/**
 * The config, or `null` when it cannot be read. A missing file is not `null`:
 * it is created with defaults first. Callers that must tell the owner WHY the
 * config is unavailable use {@link readConfig} and its message instead.
 */
export async function loadConfig(): Promise<Config | null> {
  const result = await readConfig();
  if (!result.ok) {
    logger.error('Config', result.message);
    return null;
  }
  return result.config;
}

export async function saveConfig(config: Config): Promise<void> {
  const task = async () => {
    await writeFile(CONFIG_TMP_PATH, JSON.stringify(config, null, 2));
    await rename(CONFIG_TMP_PATH, CONFIG_PATH);
  };
  configWriteQueue = configWriteQueue.then(task, task);
  return configWriteQueue;
}
