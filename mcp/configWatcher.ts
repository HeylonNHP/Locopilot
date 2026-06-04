/**
 * Watches `~/.locopilot/mcp.json` for external edits and triggers a
 * reload so the in-memory `MCPClientManager` stays in sync.
 *
 * Why this exists:
 * - The user can edit `mcp.json` by hand. The only previous way for
 *   the app to notice was clicking the "Reload from disk" button in
 *   the sidebar (`POST /api/mcp` with `{ action: 'reload' }`).
 * - Now we watch the file and reload automatically. The reload also
 *   emits a `config` event on the MCP event bus, so the SSE route
 *   pushes a refresh hint to the frontend and the UI stays in sync
 *   without polling.
 *
 * Implementation notes:
 * - We watch the *parent directory*, not the file itself, because
 *   `fs.watch` on a file binds to its inode. An editor's "atomic save"
 *   (write to `.tmp`, then `rename(.tmp, file)`) replaces the inode
 *   and breaks a file-level watch on the first save. Directory
 *   watches are stable across renames. We filter on the target
 *   filename and ignore everything else.
 * - The project's own `saveMCPServerDisabled` (and `configManager.ts`)
 *   use the same atomic-save pattern, so this is the only way to
 *   keep a watcher alive across PUTs.
 * - If the config file does not exist yet (first-run), we still watch
 *   the parent directory and start a file-level watch as soon as the
 *   file appears.
 * - Debounces 150ms so a multi-event save collapses to one reload.
 * - HMR-safe: `watcher`, `started`, `debounceTimer`, and the current
 *   file-watcher (if any) are pinned to `globalThis` so Next.js's
 *   dev-mode re-evaluation of `mcp/index.ts` does not leak handles.
 * - On `process.beforeExit`, `SIGINT`, and `SIGTERM` we close the
 *   watcher so the process can exit cleanly.
 */

import { existsSync, watch, type FSWatcher } from 'fs';
import { dirname } from 'path';

import { emitMCPEvent } from './events';
import { getMCPConfigPath } from './configLoader';
import { reloadMCP } from './index';

const DEBOUNCE_MS = 150;
const GLOBAL_KEY = '__mcpConfigWatcher';

interface WatcherState {
    dirWatcher: FSWatcher | null;
    fileWatcher: FSWatcher | null;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    started: boolean;
    shutdownHooked: boolean;
}

function getState(): WatcherState {
    const g = globalThis as unknown as Record<string, unknown>;
    let state = g[GLOBAL_KEY] as WatcherState | undefined;
    if (!state) {
        state = {
            dirWatcher: null,
            fileWatcher: null,
            debounceTimer: null,
            started: false,
            shutdownHooked: false,
        };
        g[GLOBAL_KEY] = state;
    }
    return state;
}

function hookShutdown(state: WatcherState): void {
    if (state.shutdownHooked) return;
    state.shutdownHooked = true;
    const close = (): void => {
        stopMCPConfigWatcher();
    };
    process.once('beforeExit', close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}

/**
 * Start watching `mcp.json`. Safe to call multiple times — subsequent
 * calls are no-ops. Must only be called from server-side code.
 */
export function startMCPConfigWatcher(): void {
    const state = getState();
    if (state.started) return;
    state.started = true;
    hookShutdown(state);

    const target = getMCPConfigPath();
    const dir = dirname(target);

    // Step 1: always start a directory watcher. This is the stable
    // handle — the parent inode does not change on atomic save.
    try {
        state.dirWatcher = watch(dir, { persistent: false }, (_eventType, filename) => {
            // Only react when the event is on our target file. Other
            // files in `~/.locopilot/` (sessions, etc.) are ignored.
            if (!filename) return;
            const name = filename.toString();
            if (name !== 'mcp.json') return;
            scheduleReload(state);
            // If the file is currently absent and just appeared, swap
            // from a directory-only watch to a file-level watch so
            // we get per-byte change events as well. (The directory
            // watcher alone would also fire on `mcp.json` writes, but
            // a file watcher gives us more reliable events when the
            // file is heavily edited.)
            if (!existsSync(target)) return;
            attachFileWatcher(state, target);
        });
    } catch (err) {
        // Fall back to file-level watch if the directory can't be
        // watched (rare; usually means $HOME is gone). The file-level
        // watch has the atomic-save limitation described in the
        // header, but a broken $HOME is already a worse problem.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp-config-watcher] could not watch ${dir}: ${message}`);
        attachFileWatcher(state, target);
    }

    // Step 2: if the file already exists, also start a file-level
    // watcher for finer-grained change events. (The directory watcher
    // is the source of truth — this is an optimization for editors
    // that fire many in-place `change` events.)
    if (existsSync(target)) {
        attachFileWatcher(state, target);
    }
}

function attachFileWatcher(state: WatcherState, target: string): void {
    if (state.fileWatcher) return;
    try {
        state.fileWatcher = watch(target, { persistent: false }, () => {
            scheduleReload(state);
        });
        state.fileWatcher.on('error', (err) => {
            // The atomic-save dance can cause the file watcher to
            // become invalid. Tear it down so the next event will
            // re-attach it.
            if (state.fileWatcher) {
                try {
                    state.fileWatcher.close();
                } catch {
                    /* ignore */
                }
                state.fileWatcher = null;
            }
            // ENOENT means the file was renamed away. The directory
            // watcher will re-attach the file watcher on the next
            // appearance, so this is recoverable.
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') {
                console.error(`[mcp-config-watcher] watch error on ${target}: ${err.message}`);
            }
        });
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const message = err instanceof Error ? err.message : String(err);
        if (code !== 'ENOENT') {
            console.warn(`[mcp-config-watcher] could not watch ${target}: ${message}`);
        }
    }
}

function scheduleReload(state: WatcherState): void {
    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        void doReload();
    }, DEBOUNCE_MS);
}

async function doReload(): Promise<void> {
    try {
        await reloadMCP();
        // Notify the SSE channel. We emit AFTER the reload resolves
        // so the next listMCPServersWithStatus call (triggered by the
        // SSE consumer) sees the new state.
        emitMCPEvent({ kind: 'config' });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mcp-config-watcher] reload failed: ${message}`);
    }
}

/**
 * Stop the watcher. Used by the shutdown handlers and by tests.
 */
export function stopMCPConfigWatcher(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    const state = g[GLOBAL_KEY] as WatcherState | undefined;
    if (!state) return;
    if (state.debounceTimer !== null) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
    }
    if (state.fileWatcher) {
        try {
            state.fileWatcher.close();
        } catch {
            // Ignore — closing a closed watcher is fine.
        }
        state.fileWatcher = null;
    }
    if (state.dirWatcher) {
        try {
            state.dirWatcher.close();
        } catch {
            // Ignore.
        }
        state.dirWatcher = null;
    }
    state.started = false;
}

/**
 * Test-only: reset the module-level state. Not exported from
 * `mcp/index.ts`.
 */
export function __resetMCPConfigWatcherForTests(): void {
    stopMCPConfigWatcher();
    const g = globalThis as unknown as Record<string, unknown>;
    delete g[GLOBAL_KEY];
}
