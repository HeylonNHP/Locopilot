/**
 * history.ts
 *
 * Manages persistent conversation history using a local SQLite database.
 * All sessions and their messages are stored in locopilot.db in the working
 * directory. This module is intentionally a thin, synchronous wrapper around
 * better-sqlite3 so callers don't need to think about SQL.
 *
 * Schema
 * ──────
 *   sessions             – one row per named conversation
 *   messages             – ordered messages belonging to a session
 *   session_recent_files – the files a session last read or wrote, keyed by
 *                          absolute path; survives `updateSessionMessages`
 */

import Database from 'better-sqlite3';

import { debugLog } from '@/app/lib/debugLogger';
import { DB_PATH } from '@/services/paths';
import {
  coherentCompactionPair,
  selectionFromColumns,
  selectionToColumns,
  type SessionSelection,
  type SessionSelectionColumns,
} from '@/services/sessionSelection';

import { type ChatMessage, type SubagentTrace } from './llm';
import { emitSessionEvent } from './sessionEvents';
import { type LegacyRow, planSubagentLogMigration } from './subagentLogMigration';
import { sanitizeChatMessage } from './textUtils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Session extends SessionSelectionColumns {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  last_prompt_eval_count: number | null;
  last_eval_count: number | null;
  last_total_tokens: number | null;
}

export interface SessionTokenStats {
  promptEvalCount: number;
  evalCount: number;
}

/**
 * One row of `session_recent_files`, as handed to the compaction planner.
 *
 * The shape is camelCase on purpose: `lastSeenAt` is a JS epoch-millisecond
 * number, and the planner renders relative ages from it directly.
 */
export interface RecentFileRow {
  /** Absolute path of the file (never a relative one — the cwd drifts). */
  path: string;
  /** The tool that touched it last: `read_file`, `patch_file`, or `write_file`. */
  tool: string;
  /** How many times the session touched this path. */
  hits: number;
  /** Epoch milliseconds of the last touch. */
  lastSeenAt: number;
}

// ---------------------------------------------------------------------------
// Database bootstrapping
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH);

/**
 * Runs one bootstrap step and reports a failure instead of throwing.
 *
 * WHY this module must not throw here: `history.ts` is imported by every route,
 * so a throw at import is not "recent files are unavailable" — it is "the app
 * does not start". A READ-ONLY database (a backup opened in place, a copy on a
 * read-only mount) cannot set `journal_mode = WAL` and cannot `CREATE TABLE`; a
 * `session_recent_files` that some older version created with different columns
 * makes the index below fail. Every one of those must degrade the FEATURE, so
 * the failure goes to the debug log and the readers/writers fall back (see
 * `getRecentFileStatements`).
 */
function bootstrapStep(label: string, step: () => void): void {
  try {
    step();
  } catch (err) {
    try {
      debugLog.debug('history-bootstrap-degraded', {
        step: label,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // The logger itself is best-effort.
    }
  }
}

// Enable WAL for better concurrent read performance and reliability. It is a
// WRITE, so a read-only database refuses it — which must not be fatal.
bootstrapStep('journal_mode', () => db.pragma('journal_mode = WAL'));
bootstrapStep('foreign_keys', () => db.pragma('foreign_keys = ON'));

db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        model      TEXT    NOT NULL,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        role       TEXT    NOT NULL,
        content    TEXT    NOT NULL DEFAULT '',
        thinking   TEXT    NOT NULL DEFAULT '',
        tool_calls TEXT    NOT NULL DEFAULT '[]',
        images     TEXT    NOT NULL DEFAULT '[]',
        created_at DATETIME,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

`);

// The recent-files table gets its OWN bootstrap step, because it is the only
// one whose failure is survivable: a database that cannot be written still
// serves the history it already holds, and the stub is a convenience. (The core
// schema above stays unguarded on purpose — without `sessions` and `messages`
// there is nothing here to serve, and the prepared statements below would throw
// at import anyway.)
bootstrapStep('recent-files-schema', () => {
  db.exec(`
    -- Files the session has read or written, one row per absolute path.
    -- WHY a separate table: a compaction replaces every row of 'messages'
    -- (see updateSessionMessages), so the paths that live only inside
    -- 'tool_calls' JSON are destroyed exactly when we need them most. This
    -- table is written by the tool-dispatch hook and read by the compaction
    -- planner to re-inject a stub of the recently touched files.
    --
    -- last_seen_at is epoch MILLISECONDS written from JS (Date.now()),
    -- not SQL datetime('now'): the stub renders relative ages ('4m ago')
    -- and must not depend on SQLite's date formatting.
    CREATE TABLE IF NOT EXISTS session_recent_files (
        session_id   INTEGER NOT NULL,
        path         TEXT    NOT NULL,
        tool         TEXT    NOT NULL DEFAULT '',
        hits         INTEGER NOT NULL DEFAULT 1,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, path),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_session_recent_files_recent
        ON session_recent_files (session_id, last_seen_at DESC);
  `);
});

function addColumnIfMissing(sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // Column likely already exists.
  }
}

addColumnIfMissing('ALTER TABLE sessions ADD COLUMN last_prompt_eval_count INTEGER');
addColumnIfMissing('ALTER TABLE sessions ADD COLUMN last_eval_count INTEGER');
addColumnIfMissing('ALTER TABLE sessions ADD COLUMN last_total_tokens INTEGER');
// A conversation's own model selection. `sessions.model` already existed and
// is the conversation's main model; these three pin the rest of it. They are
// nullable on purpose: NULL means "not pinned", so a row written before this
// feature keeps working without a backfill.
addColumnIfMissing('ALTER TABLE sessions ADD COLUMN provider_id TEXT');
addColumnIfMissing('ALTER TABLE sessions ADD COLUMN compaction_model TEXT');
addColumnIfMissing('ALTER TABLE sessions ADD COLUMN compaction_provider_id TEXT');
// The reasoning levels of the two models. Nullable on purpose: NULL means
// "inherit the global default", so a conversation created before this feature
// keeps following the default until the user picks a level. Creation pins the
// resolved values (`resolveCreationSelection`), so new rows are never NULL.
addColumnIfMissing('ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT');
addColumnIfMissing('ALTER TABLE sessions ADD COLUMN compaction_reasoning_effort TEXT');

// A bootstrap migration for the compaction PAIR.
//
// The pair used to be two independent nullable columns, which admitted a
// compaction MODEL with no provider — the state that sent a compaction model
// to an endpoint that did not have it. The selection is one value with three
// states now (`CompactionSelection` in `src/services/sessionSelection.ts`),
// and the only combination the columns cannot express is that half-pair.
//
// The repair is deliberately the SAFE direction: the row falls back to
// "inherit the global default", which always names a model AND a provider
// that belong together. A row whose model is `''` ("same as the main model")
// keeps that meaning and only loses the provider it cannot have.
//
// It is a no-op on the owner's databases (478 sessions, no half-pairs; 117 in
// the dev database, no half-pairs), but it makes the guarantee hold on ANY
// database.
try {
  db.exec(
    `UPDATE sessions SET compaction_provider_id = NULL
       WHERE compaction_model = ''
         AND compaction_provider_id IS NOT NULL
         AND TRIM(compaction_provider_id) <> ''`
  );
  db.exec(
    `UPDATE sessions SET compaction_model = NULL, compaction_provider_id = NULL
       WHERE compaction_model IS NOT NULL
         AND TRIM(compaction_model) <> ''
         AND (compaction_provider_id IS NULL OR TRIM(compaction_provider_id) = '')`
  );
} catch {
  // A database that cannot be migrated still works: the read path
  // (`selectionFromColumns`) normalises the same rows on the way out.
}
addColumnIfMissing("ALTER TABLE messages ADD COLUMN thinking TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("ALTER TABLE messages ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("ALTER TABLE messages ADD COLUMN subagent_id TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("ALTER TABLE messages ADD COLUMN tool_call_id TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('ALTER TABLE messages ADD COLUMN created_at DATETIME');
addColumnIfMissing("ALTER TABLE messages_staging ADD COLUMN tool_call_id TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('ALTER TABLE messages_staging ADD COLUMN created_at DATETIME');
// What the sub-agents of a `run_subagents` call printed, as JSON
// (`SubagentTrace[]`), on the `tool` row that answers that call. It must exist
// on BOTH tables: every save goes through `messages_staging`, so a column
// missing there would silently drop every trace on the next write.
addColumnIfMissing("ALTER TABLE messages ADD COLUMN subagent_traces TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing(
  "ALTER TABLE messages_staging ADD COLUMN subagent_traces TEXT NOT NULL DEFAULT '[]'"
);

// Legacy `subagent_log` rows become traces on the tool row of their call. Runs
// once per database (it deletes the rows it moves, so a second run finds none),
// in ONE transaction, and as its own bootstrap step: a database that cannot be
// written still serves its history, and an old session is only missing its
// traces' new home, never its messages.
bootstrapStep('subagent-traces-migration', () => {
  const sessionIds = (
    db.prepare("SELECT DISTINCT session_id FROM messages WHERE role = 'subagent_log'").all() as {
      session_id: number;
    }[]
  ).map((row) => row.session_id);
  if (sessionIds.length === 0) return;

  const selectRows = db.prepare<[number]>(
    'SELECT id, role, content, subagent_id, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY id ASC'
  );
  const setTraces = db.prepare<[string, number]>(
    'UPDATE messages SET subagent_traces = ? WHERE id = ?'
  );
  const deleteRow = db.prepare<[number]>('DELETE FROM messages WHERE id = ?');

  let attached = 0;
  let dropped = 0;
  db.transaction(() => {
    for (const sessionId of sessionIds) {
      const rows = (
        selectRows.all(sessionId) as {
          id: number;
          role: string;
          content: string;
          subagent_id: string;
          tool_calls: string;
          tool_call_id: string;
        }[]
      ).map(
        (row): LegacyRow => ({
          id: row.id,
          role: row.role,
          content: row.content,
          subagentId: row.subagent_id,
          toolCalls: row.tool_calls,
          toolCallId: row.tool_call_id,
        })
      );
      const plan = planSubagentLogMigration(rows);
      for (const [rowId, traces] of plan.traces) {
        setTraces.run(JSON.stringify(traces), rowId);
      }
      for (const rowId of plan.deleteIds) {
        deleteRow.run(rowId);
      }
      attached += plan.attached;
      dropped += plan.dropped;
    }
  })();
  debugLog.debug('subagent-traces-migration', {
    sessions: sessionIds.length,
    attached,
    dropped,
  });
});

// ---------------------------------------------------------------------------
// Prepared statements (created once, reused on every call)
// ---------------------------------------------------------------------------

const stmtInsertSession = db.prepare<
  [string, string, string | null, string | null, string | null, string | null, string | null]
>(
  'INSERT INTO sessions (name, model, provider_id, compaction_model, compaction_provider_id, reasoning_effort, compaction_reasoning_effort) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

/**
 * A conversation's model selection.
 *
 * Unlike the other `UPDATE sessions` statements this one does NOT bump
 * `updated_at`: a model change is a setting change, not conversation
 * activity, and bumping it would jump the conversation to the top of the
 * sidebar for something the user did not do in the conversation.
 */
const stmtUpdateSessionSelection = db.prepare<
  [string, string | null, string | null, string | null, string | null, string | null, number]
>(
  'UPDATE sessions SET model = ?, provider_id = ?, compaction_model = ?, compaction_provider_id = ?, reasoning_effort = ?, compaction_reasoning_effort = ? WHERE id = ?'
);

const stmtGetSessionSelection = db.prepare<[number]>(
  'SELECT model, provider_id, compaction_model, compaction_provider_id, reasoning_effort, compaction_reasoning_effort FROM sessions WHERE id = ?'
);

const stmtUpdateSessionName = db.prepare<[string, number]>(
  "UPDATE sessions SET name = ?, updated_at = datetime('now') WHERE id = ?"
);

const stmtUpdateSessionTimestamp = db.prepare<[number]>(
  "UPDATE sessions SET updated_at = datetime('now') WHERE id = ?"
);

const stmtUpdateSessionTokenStats = db.prepare<[number, number, number, number]>(
  "UPDATE sessions SET last_prompt_eval_count = ?, last_eval_count = ?, last_total_tokens = ?, updated_at = datetime('now') WHERE id = ?"
);

const stmtClearSessionTokenStats = db.prepare<[number]>(
  "UPDATE sessions SET last_prompt_eval_count = NULL, last_eval_count = NULL, last_total_tokens = NULL, updated_at = datetime('now') WHERE id = ?"
);

const stmtListSessions = db.prepare<[]>('SELECT * FROM sessions ORDER BY updated_at DESC');

const stmtDeleteSession = db.prepare<[number]>('DELETE FROM sessions WHERE id = ?');

const stmtDeleteMessages = db.prepare<[number]>('DELETE FROM messages WHERE session_id = ?');

const stmtDeleteMessageRange = db.prepare<[number, number, number | null, number | null]>(
  'DELETE FROM messages WHERE session_id = ? AND id >= ? AND (? IS NULL OR id < ?)'
);

const stmtLoadMessages = db.prepare<[number]>(
  'SELECT id, role, content, thinking, tool_calls, images, subagent_id, subagent_traces, tool_call_id, created_at FROM messages WHERE session_id = ? ORDER BY id ASC'
);

// Session search only considers user prompts and assistant replies. Tool
// results, subagent logs, and other non-conversational roles are excluded
// so long tool outputs (fetched pages, command stdout, image base64, etc.)
// don't dominate the result list. The role filter lives on the JOIN (not
// in WHERE) so a session with no user/assistant messages can still match
// by its title.
const stmtSearchSessions = db.prepare<[string, string]>(
  `SELECT DISTINCT s.* FROM sessions s\n     LEFT JOIN messages m ON m.session_id = s.id AND m.role IN ('user', 'assistant')\n     WHERE LOWER(s.name) LIKE ? ESCAPE '\\' OR LOWER(m.content) LIKE ? ESCAPE '\\'\n     ORDER BY s.updated_at DESC`
);

const stmtGetSessionName = db.prepare<[number]>('SELECT name FROM sessions WHERE id = ?');

const stmtSessionExists = db.prepare<[number]>('SELECT 1 FROM sessions WHERE id = ?');

// --- Recent files -----------------------------------------------------------
//
// Prepared on FIRST USE, not at import, and never fatally: on a database that
// is read-only, or that carries an older `session_recent_files` with a
// different shape, these three statements cannot compile at all. Doing the
// `db.prepare` here meant a throw during module evaluation — i.e. every route
// down because a convenience table was missing. The getter below turns that
// into `null`, which `recordTouchedFile` reads as "do nothing" and
// `loadRecentFiles` as "no rows".
//
// Upsert keyed on (session_id, path): a re-touch bumps the counter and the
// timestamp and refreshes which tool was last responsible for the file.
function prepareRecentFileStatements() {
  return {
    load: db.prepare<[number, number]>(
      'SELECT path, tool, hits, last_seen_at FROM session_recent_files WHERE session_id = ? ORDER BY last_seen_at DESC, path ASC LIMIT ?'
    ),
    // Keeps only the N most recent rows of one session. The secondary `path`
    // term makes the cut deterministic when several touches share a millisecond.
    prune: db.prepare<[number, number, number]>(
      `DELETE FROM session_recent_files
       WHERE session_id = ?
         AND path NOT IN (
           SELECT path FROM session_recent_files
           WHERE session_id = ?
           ORDER BY last_seen_at DESC, path ASC
           LIMIT ?
         )`
    ),
    upsert: db.prepare<[number, string, string, number]>(
      `INSERT INTO session_recent_files (session_id, path, tool, hits, last_seen_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(session_id, path) DO UPDATE SET
         tool = excluded.tool,
         hits = hits + 1,
         last_seen_at = excluded.last_seen_at`
    ),
  };
}

/** The recent-files statements, or `null` when this database cannot run them. */
let recentFileStatements: ReturnType<typeof prepareRecentFileStatements> | null | undefined;

/**
 * Returns the recent-files statements, preparing them once; `null` if the table
 * is missing, differently shaped, or in a database that refuses to be written.
 */
function getRecentFileStatements(): ReturnType<typeof prepareRecentFileStatements> | null {
  if (recentFileStatements !== undefined) return recentFileStatements;
  try {
    recentFileStatements = prepareRecentFileStatements();
  } catch (err) {
    recentFileStatements = null;
    try {
      debugLog.debug('recent-files-statements-unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // The logger itself is best-effort.
    }
  }
  return recentFileStatements;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if a session with the given id exists.
 */
export function sessionExists(sessionId: number): boolean {
  const row = stmtSessionExists.get(sessionId) as { 1: number } | undefined;
  return row !== undefined;
}

/**
 * Creates a new session and returns its id.
 *
 * @param name      – Human-readable title (will be updated from first user message).
 * @param selection – The model selection the conversation runs on.
 */
export function createSession(name: string, selection: SessionSelection): number {
  const columns = selectionToColumns(selection);
  const result = stmtInsertSession.run(
    name,
    columns.model,
    columns.provider_id,
    columns.compaction_model,
    columns.compaction_provider_id,
    columns.reasoning_effort,
    columns.compaction_reasoning_effort
  );
  return result.lastInsertRowid as number;
}

/**
 * Records a conversation's model selection and announces it to open tabs.
 *
 * Like `renameSession`, this is the one place that writes the change and the
 * one place that announces it, so every path that changes a conversation's
 * model is covered without any of them having to remember to push it.
 */
export function updateSessionSelection(sessionId: number, selection: SessionSelection): void {
  const columns = selectionToColumns(selection);
  stmtUpdateSessionSelection.run(
    columns.model,
    columns.provider_id,
    columns.compaction_model,
    columns.compaction_provider_id,
    columns.reasoning_effort,
    columns.compaction_reasoning_effort,
    sessionId
  );
  emitSessionEvent({
    kind: 'model-changed',
    sessionId,
    model: selection.model,
    providerId: selection.providerId,
    // The compaction selection is ONE value — the NORMALISED one, the pair
    // that was actually written: the row can never hold a compaction model
    // without the provider that serves it, so neither may the frame that
    // announces the change.
    compaction: selection.compaction,
    reasoningEffort: columns.reasoning_effort,
    compactionReasoningEffort: columns.compaction_reasoning_effort,
  });
}

/**
 * A conversation's stored selection, or `undefined` when it does not exist.
 *
 * The `PATCH` route reads this inside the per-session queue to merge a
 * field-preserving patch onto the row that is current at write time, not onto
 * the copy the request happened to carry.
 */
export function getSessionSelection(sessionId: number): SessionSelection | undefined {
  const row = stmtGetSessionSelection.get(sessionId) as SessionSelectionColumns | undefined;
  return row === undefined ? undefined : selectionFromColumns(row);
}

/**
 * Renames an existing session (e.g. to the first user prompt).
 *
 * Every rename path funnels through here — the synchronous fallback title, the
 * background LLM-generated title, and `/title` — so this is the one place that
 * announces the change to open browser tabs. Without that push the client can
 * only learn a title by re-reading `GET /api/sessions`, and the interesting
 * renames happen after the response stream has already closed, which is how
 * stale titles ended up needing an F5.
 */
export function renameSession(sessionId: number, name: string): void {
  stmtUpdateSessionName.run(name, sessionId);
  emitSessionEvent({ kind: 'renamed', sessionId, name });
}

/**
 * Returns the name of a session, or undefined if the session does not exist.
 */
export function getSessionName(sessionId: number): string | undefined {
  const row = stmtGetSessionName.get(sessionId) as { name: string } | undefined;
  return row?.name;
}

/**
 * A session row with its compaction pair NORMALISED.
 *
 * The row can only hold a coherent pair (the write path normalises it and
 * the bootstrap migration repairs what an older build left behind), but the
 * pair is normalised on the way OUT as well: this row is what the browser
 * reads, and a browser that received a compaction model without the
 * provider that serves it would send that half-pair back in its next chat
 * request, where the server refuses it — a conversation that cannot be
 * resumed because of a row the server itself wrote.
 */
function normaliseSessionRow(row: Session): Session {
  const pair = coherentCompactionPair(row.compaction_model, row.compaction_provider_id);
  if (
    pair.model === row.compaction_model &&
    pair.providerId === row.compaction_provider_id
  ) {
    return row;
  }
  return {
    ...row,
    compaction_model: pair.model,
    compaction_provider_id: pair.providerId,
  };
}

/**
 * Returns all sessions ordered by most-recently-updated first.
 */
export function listSessions(): Session[] {
  return (stmtListSessions.all() as Session[]).map(normaliseSessionRow);
}

/**
 * Searches sessions by title and the content of user/assistant messages.
 * Tool results, subagent logs, and other non-conversational roles are
 * intentionally excluded from the message-content half of the match.
 */
export function searchSessions(query: string): Session[] {
  // Escape the SQL LIKE wildcards (`%`, `_`) AND the escape character itself
  // so a query containing a literal `%` or `_` matches literally. The old code
  // produced `\%`/`\_` but the statement had no `ESCAPE '\'` clause, so SQLite
  // treated the backslash as a literal character and the `%`/`_` as wildcards
  // — sessions whose title/content contained `%` or `_` were unfindable.
  const escaped = query
    .toLowerCase()
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('%', String.raw`\%`)
    .replaceAll('_', String.raw`\_`);
  const q = `%${escaped}%`;
  return (stmtSearchSessions.all(q, q) as Session[]).map(normaliseSessionRow);
}

/**
 * Deletes a session and all its messages.
 */
export function deleteSession(sessionId: number): void {
  stmtDeleteSession.run(sessionId);
}

/**
 * Replaces all stored messages for a session with the provided array.
 * Used after compaction and when switching sessions.
 */
export function updateSessionMessages(
  sessionId: number,
  messages: ChatMessage[],
  tokenStats?: SessionTokenStats | null
): void {
  // Strip system messages before persisting — the system prompt is always
  // injected on-the-fly and should never be stored in the database.
  // Also drop display-only tool messages that have no real tool_call_id.
  // Those rows are client-side artifacts created by the 'tool_call' and
  // 'tool_progress' SSE handlers and are not part of the LLM protocol.
  const persistableMessages = messages.filter((m) => {
    if (m.role === 'system') return false;
    if (
      m.role === 'tool' &&
      (m.tool_call_id === null || m.tool_call_id === undefined || m.tool_call_id === '')
    )
      return false;
    return true;
  });

  const run = db.transaction(() => {
    // Insert new messages into a temp staging table first, so the
    // original data survives if the process crashes mid-write.
    db.exec(
      'CREATE TABLE IF NOT EXISTS messages_staging ' +
        '(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, ' +
        "role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', " +
        "thinking TEXT NOT NULL DEFAULT '', tool_calls TEXT NOT NULL DEFAULT '[]', " +
        "images TEXT NOT NULL DEFAULT '[]', subagent_id TEXT NOT NULL DEFAULT '', " +
        "subagent_traces TEXT NOT NULL DEFAULT '[]', " +
        "tool_call_id TEXT NOT NULL DEFAULT '', created_at DATETIME)"
    );
    const stmtDeleteStaging = db.prepare<[number]>(
      'DELETE FROM messages_staging WHERE session_id = ?'
    );
    stmtDeleteStaging.run(sessionId);

    const stmtInsertStaging = db.prepare<
      [number, string, string, string, string, string, string, string, string, string | null]
    >(
      'INSERT INTO messages_staging (session_id, role, content, thinking, tool_calls, images, subagent_id, subagent_traces, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    let persistIndex = 0;
    let persistToolCount = 0;
    let persistToolWithCallIdCount = 0;
    for (const msg of persistableMessages) {
      const sanitizedMessage = sanitizeChatMessage(msg);
      const role = sanitizedMessage.role;
      const content = sanitizedMessage.content ?? '';
      const thinking = sanitizedMessage.thinking ?? '';
      const toolCalls = JSON.stringify(sanitizedMessage.tool_calls ?? []);
      const images = JSON.stringify(sanitizedMessage.images ?? []);
      const toolCallId =
        sanitizedMessage.role === 'tool' ? (sanitizedMessage.tool_call_id ?? '') : '';
      // Only a `tool` row carries traces: they belong to the call it answers.
      const subagentTraces =
        sanitizedMessage.role === 'tool'
          ? JSON.stringify(sanitizedMessage.subagentTraces ?? [])
          : '[]';
      // Only user-role messages carry a createdAt; assistant/tool/system rows
      // store NULL so they don't display a misleading timestamp in the UI.
      const createdAt =
        sanitizedMessage.role === 'user' && typeof sanitizedMessage.createdAt === 'string'
          ? sanitizedMessage.createdAt
          : null;

      const hasToolCallId = sanitizedMessage.role === 'tool' && toolCallId !== '';
      debugLog.toolMessage({
        layer: 'history',
        action: 'persist',
        messageIndex: persistIndex,
        role,
        hasToolCallId,
        tool_call_id: toolCallId || null,
        contentPreview: content,
        sessionId,
        isToolMessage: role === 'tool',
        ...(role === 'tool'
          ? {
              toolCallIdWritten: toolCallId !== '',
              note:
                toolCallId === ''
                  ? 'EMPTY tool_call_id being written for tool message'
                  : 'tool_call_id present',
            }
          : {}),
      });
      if (role === 'tool') {
        persistToolCount++;
        if (toolCallId !== '') persistToolWithCallIdCount++;
      }

      stmtInsertStaging.run(
        sessionId,
        role,
        content,
        thinking,
        toolCalls,
        images,
        '',
        subagentTraces,
        toolCallId,
        createdAt
      );
      persistIndex++;
    }

    debugLog.debug('persist-summary', {
      sessionId,
      totalPersisted: persistableMessages.length,
      toolMessageCount: persistToolCount,
      toolMessagesWithToolCallId: persistToolWithCallIdCount,
      toolMessagesWithEmptyToolCallId: persistToolCount - persistToolWithCallIdCount,
    });

    // Atomic swap: delete originals only after staging is complete,
    // then move staged rows into the real table.
    stmtDeleteMessages.run(sessionId);
    const stmtCopyStaging = db.prepare<[number]>(
      'INSERT INTO messages (session_id, role, content, thinking, tool_calls, images, subagent_id, subagent_traces, tool_call_id, created_at) ' +
        'SELECT session_id, role, content, thinking, tool_calls, images, subagent_id, subagent_traces, tool_call_id, created_at ' +
        'FROM messages_staging WHERE session_id = ?'
    );
    stmtCopyStaging.run(sessionId);
    stmtDeleteStaging.run(sessionId);

    if (tokenStats) {
      const totalTokens = tokenStats.promptEvalCount + tokenStats.evalCount;
      stmtUpdateSessionTokenStats.run(
        tokenStats.promptEvalCount,
        tokenStats.evalCount,
        totalTokens,
        sessionId
      );
    } else {
      stmtUpdateSessionTimestamp.run(sessionId);
    }
  });
  run();
}

/** Parses a `subagent_traces` cell; anything malformed reads as "no traces". */
function parseSubagentTraces(raw: string | null | undefined): SubagentTrace[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SubagentTrace =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as SubagentTrace).agentId === 'string' &&
        typeof (item as SubagentTrace).content === 'string'
    );
  } catch {
    return [];
  }
}

/**
 * Loads and returns the full message history for a session.
 */
export function loadSessionMessages(sessionId: number): ChatMessage[] {
  const rows = stmtLoadMessages.all(sessionId) as {
    id: number;
    role: string;
    content: string;
    thinking: string;
    tool_calls: string;
    images: string;
    subagent_id: string;
    subagent_traces: string;
    tool_call_id: string;
    created_at: string | null;
  }[];

  let loadToolCount = 0;
  let loadToolEmptyCallIdCount = 0;

  const loaded = rows.map((row, index) => {
    const rowId = row.id as number;
    const role = row.role;
    const dbToolCallId = row.tool_call_id;
    const isToolMessage = role === 'tool';
    const hasToolCallId = isToolMessage && dbToolCallId !== '';

    debugLog.toolMessage({
      layer: 'history',
      action: 'load',
      messageIndex: index,
      rowId,
      role,
      hasToolCallId,
      tool_call_id: dbToolCallId || null,
      contentPreview: row.content,
      sessionId,
      isToolMessage,
      ...(isToolMessage
        ? {
            dbToolCallIdValue: dbToolCallId,
            note:
              dbToolCallId === ''
                ? 'tool message loaded with EMPTY/missing tool_call_id'
                : 'tool message loaded with tool_call_id present',
          }
        : {}),
    });
    if (isToolMessage) {
      loadToolCount++;
      if (dbToolCallId === '') loadToolEmptyCallIdCount++;
    }

    let toolCalls: ChatMessage['tool_calls'] | undefined;
    try {
      const parsed = JSON.parse(row.tool_calls);
      if (Array.isArray(parsed) && parsed.length > 0) {
        toolCalls = parsed as ChatMessage['tool_calls'];
      }
    } catch {
      toolCalls = undefined;
    }
    let images: string[] = [];
    try {
      images = JSON.parse(row.images ?? '[]');
    } catch {
      images = [];
    }
    const msg: ChatMessage = {
      role: row.role as ChatMessage['role'],
      content: row.content,
      id: rowId,
    };
    if (row.thinking) {
      msg.thinking = row.thinking;
    }
    if (toolCalls && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    if (images && images.length > 0) {
      msg.images = images;
    }
    if (row.role === 'tool') {
      const traces = parseSubagentTraces(row.subagent_traces);
      if (traces.length > 0) {
        msg.subagentTraces = traces;
      }
    }
    if (row.created_at && row.role === 'user') {
      msg.createdAt = row.created_at;
    }
    if (msg.role === 'tool') {
      // role: 'tool' requires tool_call_id, even when it is an empty string
      msg.tool_call_id = row.tool_call_id;
    } else if (row.tool_call_id) {
      msg.tool_call_id = row.tool_call_id;
    }
    return sanitizeChatMessage(msg);
  });

  // Drop display-only tool messages that were incorrectly persisted by
  // earlier versions. Real tool results always carry a non-empty
  // tool_call_id; empty/missing ids are client-side UI artifacts created by
  // the 'tool_call' / 'tool_progress' / 'tool_result' SSE handlers.
  const cleaned = loaded.filter((m) => {
    if (m.role !== 'tool') return true;
    return m.tool_call_id !== null && m.tool_call_id !== undefined && m.tool_call_id !== '';
  });
  const droppedCount = loaded.length - cleaned.length;

  debugLog.debug('load-summary', {
    sessionId,
    totalLoaded: loaded.length,
    totalReturned: cleaned.length,
    droppedDisplayOnlyToolCount: droppedCount,
    toolMessageCount: loadToolCount,
    toolMessagesWithEmptyToolCallId: loadToolEmptyCallIdCount,
    toolMessagesWithToolCallId: loadToolCount - loadToolEmptyCallIdCount,
  });

  return cleaned;
}

/**
 * Deletes a user prompt and every message derived from it up to (but not
 * including) the next user prompt. If there is no next user prompt, all
 * trailing assistant, tool, and system messages are removed too (a tool message
 * takes its sub-agent traces with it).
 *
 * The deletion preserves the row IDs of all retained messages so clients can
 * continue to reference them for subsequent operations.
 *
 * @returns The current kept messages after deletion, in their original order.
 * @throws If the target message is not found, is not a user message, or the
 *         session does not exist.
 */
export function deleteMessagesFrom(sessionId: number, messageId: number): ChatMessage[] {
  if (!sessionExists(sessionId)) {
    throw new Error(`Session ${sessionId} not found.`);
  }

  const messages = loadSessionMessages(sessionId);
  const targetIndex = messages.findIndex((m) => m.id === messageId);
  if (targetIndex === -1) {
    throw new Error(`Message ${messageId} not found in session ${sessionId}.`);
  }

  const targetMessage = messages[targetIndex]!;
  if (targetMessage.role !== 'user') {
    throw new Error(`Message ${messageId} is not a user prompt; only user prompts can be deleted.`);
  }

  // Find the next user message after the target. Everything from the target
  // up to (but not including) that next user message is removed.
  let nextUserIndex = -1;
  for (let i = targetIndex + 1; i < messages.length; i += 1) {
    const candidate = messages[i];
    if (candidate && candidate.role === 'user') {
      nextUserIndex = i;
      break;
    }
  }

  const nextUserId = nextUserIndex === -1 ? null : (messages[nextUserIndex]!.id ?? null);

  const run = db.transaction(() => {
    stmtDeleteMessageRange.run(sessionId, messageId, nextUserId, nextUserId);
    stmtClearSessionTokenStats.run(sessionId);
  });
  run();

  return loadSessionMessages(sessionId);
}

// ---------------------------------------------------------------------------
// Recent files
// ---------------------------------------------------------------------------

/**
 * How many rows one session keeps in `session_recent_files`.
 *
 * WHY a cap at all: a long session can read hundreds of files, and the stub
 * re-injected after compaction is a handful of lines. Twenty-four rows is
 * enough to cover a working set while staying a rounding error in tokens.
 */
const RECENT_FILES_KEEP_PER_SESSION = 24;

/** The columns the recent-files load statement selects, in snake_case as stored. */
interface RecentFileDbRow {
  path: string;
  tool: string;
  hits: number;
  last_seen_at: number;
}

/**
 * Records that a session touched `filePath` with `tool`, bumping the hit
 * counter and the timestamp, and prunes the session back to
 * {@link RECENT_FILES_KEEP_PER_SESSION} rows — all in one transaction.
 *
 * Never throws. Recording is a diagnostic nicety: a failure here must never
 * fail the tool call that produced it, so bad ids, empty paths, and a session
 * that no longer exists (the foreign key rejects the insert) are all silent
 * no-ops.
 *
 * @param sessionId – Owning chat session. Sub-agents have none and never call this.
 * @param filePath  – The ABSOLUTE path of the file.
 * @param tool      – Tool name that touched it (`read_file`, `patch_file`, `write_file`).
 * @param now       – Epoch milliseconds to store; defaults to `Date.now()`.
 *                    Injectable so tests can order touches deterministically.
 */
export function recordTouchedFile(
  sessionId: number,
  filePath: string,
  tool: string,
  now?: number
): void {
  try {
    if (!Number.isInteger(sessionId)) return;
    if (typeof filePath !== 'string') return;
    const trimmedPath = filePath.trim();
    if (trimmedPath === '') return;
    const stamp = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const toolName = typeof tool === 'string' ? tool : '';

    // No statements means no table (or no permission to use it): the touch is
    // simply not remembered, which is exactly the pre-feature behaviour.
    const statements = getRecentFileStatements();
    if (statements === null) return;

    const run = db.transaction(() => {
      statements.upsert.run(sessionId, trimmedPath, toolName, stamp);
      statements.prune.run(sessionId, sessionId, RECENT_FILES_KEEP_PER_SESSION);
    });
    run();
  } catch (err) {
    // A recording failure is never worth failing a tool call over, and the
    // caller already wraps this — belt and braces, because a throw here would
    // abort the whole turn.
    try {
      debugLog.debug('recent-files-record-failed', {
        sessionId: Number.isInteger(sessionId) ? sessionId : null,
        tool: typeof tool === 'string' ? tool : null,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // The logger itself is best-effort.
    }
  }
}

/**
 * Returns the most recently touched files of a session, newest first,
 * capped at `limit` rows.
 *
 * Rows are never written for a session id that was never created (the
 * foreign key rejects them), so an unknown session simply returns `[]` —
 * as does an unreadable database, since this is a read on a best-effort
 * reporting path.
 */
export function loadRecentFiles(sessionId: number, limit: number): RecentFileRow[] {
  try {
    if (!Number.isInteger(sessionId)) return [];
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return [];
    const capped = Math.floor(limit);
    if (capped <= 0) return [];

    // No statements means no table (or a read-only database): an empty list is
    // the answer that costs the caller nothing — the compaction just gets no
    // stub.
    const statements = getRecentFileStatements();
    if (statements === null) return [];

    const rows = statements.load.all(sessionId, capped) as RecentFileDbRow[];
    return rows.map((row) => ({
      path: row.path,
      tool: row.tool,
      hits: row.hits,
      lastSeenAt: row.last_seen_at,
    }));
  } catch (err) {
    try {
      debugLog.debug('recent-files-load-failed', {
        sessionId: Number.isInteger(sessionId) ? sessionId : null,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // The logger itself is best-effort.
    }
    return [];
  }
}
