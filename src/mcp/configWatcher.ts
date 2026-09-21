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
 * - F8: on a cold start we synchronously create `~/.locopilot/` before
 *   calling `fs.watch` (which throws ENOENT on a missing path), and if
 *   the dir watcher fails to attach we schedule a BOUNDED retry instead
 *   of latching a dead state. We register ONLY a `beforeExit` handler —
 *   installing SIGINT/SIGTERM handlers removed Node's default
 *   terminate-on-signal behaviour, so the first Ctrl+C no longer quit.
 */

import { existsSync, type FSWatcher, watch } from 'node:fs';
import path from 'node:path';

import { ensureMCPConfigDirSync, ensureMCPConfigFile, getMCPConfigPath } from './configLoader';
import { emitMCPEvent } from './events';
import { reloadMCP } from './index';

const DEBOUNCE_MS = 150;
// F8: bounded retry parameters for a failed directory-watch attach. Each
// retry re-runs `startMCPConfigWatcher`; the counter resets on success.
const WATCH_RETRY_MS = 2000;
const MAX_WATCH_RETRIES = 5;
const GLOBAL_KEY = '__mcpConfigWatcher';

interface WatcherState {
  dirWatcher: FSWatcher | null;
  fileWatcher: FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  // F8: bounded retry bookkeeping for a failed dir-watch attach. The
  // timer is `unref()`ed so it never keeps the process alive.
  retryTimer: ReturnType<typeof setTimeout> | null;
  watchRetries: number;
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
      retryTimer: null,
      watchRetries: 0,
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
  // F8: register ONLY `beforeExit`. We deliberately do NOT install
  // SIGINT/SIGTERM handlers: doing so removes Node's default
  // terminate-on-signal behaviour, and our handler only closed the
  // watchers without exiting — which is exactly why the first Ctrl+C
  // stopped quitting the process. Both watchers use `persistent: false`,
  // so they never hold the event loop open and `beforeExit` fires
  // naturally once the process is otherwise idle. We do NOT call
  // `process.exit()` here — that would preempt other async teardown.
  process.once('beforeExit', stopMCPConfigWatcher);
}

/**
 * Start watching `mcp.json`. Safe to call multiple times — subsequent
 * calls are no-ops. Must only be called from server-side code.
 *
 * SYNCHRONOUS: `mcp/index.ts` calls this at module-evaluation time, so
 * it must never become an async function.
 */
export function startMCPConfigWatcher(): void {
  const state = getState();
  if (state.started) return;

  // F8: create `~/.locopilot/` synchronously BEFORE watching. `fs.watch`
  // throws ENOENT synchronously when its path is missing, and
  // `ensureMCPConfigFile()` is async — so on a cold first run the watcher
  // used to lose a race against it and latch a dead state forever.
  ensureMCPConfigDirSync();

  const target = getMCPConfigPath();

  // Step 1: attach the directory watcher. Only mark the watcher as
  // `started` once it is actually live; on failure leave `started` false
  // and schedule a bounded retry so hot-reload is not dead for the whole
  // process lifetime (F8).
  if (!attachDirWatcher(state)) {
    state.started = false;
    scheduleWatchRetry(state);
    return;
  }

  state.started = true;
  state.watchRetries = 0;
  hookShutdown(state);

  // Convenience: ensure the config file exists. Fire-and-forget — the
  // directory watcher is already live and will pick the file up when it
  // appears.
  ensureMCPConfigFile().catch(() => {
    /* ignore */
  });

  // Step 2: if the file already exists, also start a file-level
  // watcher for finer-grained change events. (The directory watcher
  // is the source of truth — this is an optimization for editors
  // that fire many in-place `change` events.)
  if (existsSync(target)) {
    attachFileWatcher(state, target);
  }
}

/**
 * Attach the directory watcher for `~/.locopilot/`. Returns `false` when
 * the watch could not be created (e.g. the path vanished between the
 * synchronous `mkdir` and the `watch` call). F8: the returned flag lets
 * the caller schedule a bounded retry instead of latching a dead state.
 *
 * Also wires an `'error'` listener: an unhandled EventEmitter `'error'`
 * event would crash the process, so on error we close the watcher and
 * schedule a retry too.
 */
function attachDirWatcher(state: WatcherState): boolean {
  const target = getMCPConfigPath();
  const dir = path.dirname(target);

  // Step 1: always start a directory watcher. This is the stable
  // handle — the parent inode does not change on atomic save.
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
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
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[mcp-config-watcher] could not watch ${dir}: ${message}`);
    state.dirWatcher = null;
    return false;
  }

  state.dirWatcher = watcher;
  // F8: an unhandled `'error'` event on an EventEmitter throws and would
  // crash the process. Close the dead watcher and schedule a bounded
  // retry so hot-reload recovers.
  watcher.on('error', (err) => {
    if (state.dirWatcher) {
      try {
        state.dirWatcher.close();
      } catch {
        /* ignore */
      }
      state.dirWatcher = null;
    }
    console.error(`[mcp-config-watcher] directory watch error on ${dir}: ${err.message}`);
    state.started = false;
    scheduleWatchRetry(state);
  });
  return true;
}

/**
 * F8: schedule a bounded re-attempt of `startMCPConfigWatcher` after a
 * failed attach. The timer is `unref()`ed so it never holds the event
 * loop open. Guarded so overlapping failures don't stack timers, and
 * capped at `MAX_WATCH_RETRIES` consecutive failures.
 */
function scheduleWatchRetry(state: WatcherState): void {
  if (state.retryTimer !== null) return;
  if (state.watchRetries >= MAX_WATCH_RETRIES) {
    console.error(
      `[mcp-config-watcher] giving up after ${MAX_WATCH_RETRIES} attempts to watch the config directory; hot-reload is disabled until restart`
    );
    return;
  }
  state.watchRetries += 1;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    startMCPConfigWatcher();
  }, WATCH_RETRY_MS);
  state.retryTimer.unref();
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
  // F8: cancel any pending bounded-retry timer so a stopped watcher
  // cannot resurrect itself.
  if (state.retryTimer !== null) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
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
  state.watchRetries = 0;
}
