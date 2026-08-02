import { access, readFile, rename, writeFile } from 'node:fs/promises';

import type { Config } from '@/types/chatConfig';

import { logger } from '@/app/lib/logger';
import { CONFIG_PATH, CONFIG_TMP_PATH } from '@/services/paths';

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
