/**
 * Shared filesystem path constants used across Locopilot.
 *
 * Keeping the construction site for `config.json`, `locopilot.db`, and the
 * `.locopilot` directory in one module prevents drift between modules that
 * previously each rebuilt the same `path.join(process.cwd(), 'config.json')`
 * line — every consumer now imports the canonical constant.
 */

import path from 'node:path';

/** Directory name of the user-facing project configuration folder. */
export const LOCOPILOT_DIRNAME = '.locopilot';

/** Default location of the on-disk config file, relative to `process.cwd()`. */
export const CONFIG_FILENAME = 'config.json';

/** Atomic-write temp path for `config.json`. Sibling of `CONFIG_PATH`. */
export const CONFIG_TMP_FILENAME = `${CONFIG_FILENAME}.tmp`;

/** SQLite database file for persistent chat history. */
export const DB_FILENAME = 'locopilot.db';

/** Absolute path to the on-disk config file. */
export const CONFIG_PATH = path.join(process.cwd(), CONFIG_FILENAME);

/** Absolute atomic-write temp path for `CONFIG_PATH`. */
export const CONFIG_TMP_PATH = path.join(process.cwd(), CONFIG_TMP_FILENAME);

/** Absolute path to the SQLite database. */
export const DB_PATH = path.join(process.cwd(), DB_FILENAME);
