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
 * - Uses Node's built-in `fs.watch` — no new dependency.
 * - Debounces 150ms so a multi-write editor save (e.g. `vim` writing
 *   + renaming) collapses to a single reload.
 * - Idempotent: calling `startMCPConfigWatcher()` twice is a no-op.
 * - On `process.beforeExit`, we close the watcher so the process can
 *   exit cleanly during dev HMR.
 */

import { watch, type FSWatcher } from 'fs';

import { emitMCPEvent } from './events';
import { getMCPConfigPath } from './configLoader';
import { reloadMCP } from './index';

const DEBOUNCE_MS = 150;

let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/**
 * Start watching `mcp.json`. Safe to call multiple times — subsequent
 * calls are no-ops. Must only be called from server-side code.
 */
export function startMCPConfigWatcher(): void {
    if (started) return;
    started = true;

    const target = getMCPConfigPath();
    try {
        watcher = watch(target, { persistent: false }, (_eventType, _filename) => {
            // We don't care about the event type or filename — any
            // change to the target triggers a debounced reload. Using
            // just the path means the watcher survives an editor's
            // "atomic save" rename dance as long as the file is back
            // at the same path within the debounce window.
            scheduleReload();
        });

        watcher.on('error', (err) => {
            console.error(`[mcp-config-watcher] watch error on ${target}: ${err.message}`);
        });
    } catch (err) {
        // The config file might not exist yet on first run. That's
        // fine — the user can still create it and we won't notice,
        // but the manual reload button + the PUT flow cover that
        // case (PUT goes through `saveMCPServerDisabled` which also
        // emits a `config` event for the SSE channel).
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp-config-watcher] could not watch ${target}: ${message}`);
        started = false;
        return;
    }

    process.once('beforeExit', () => {
        stopMCPConfigWatcher();
    });
}

function scheduleReload(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
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
 * Stop the watcher. Used by the `beforeExit` handler and by tests.
 */
export function stopMCPConfigWatcher(): void {
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (watcher) {
        try {
            watcher.close();
        } catch {
            // Ignore — closing a closed watcher is fine.
        }
        watcher = null;
    }
    started = false;
}

/**
 * Test-only: reset the module-level state. Not exported from
 * `mcp/index.ts`.
 */
export function __resetMCPConfigWatcherForTests(): void {
    stopMCPConfigWatcher();
}
