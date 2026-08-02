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
 *   sessions  – one row per named conversation
 *   messages  – ordered messages belonging to a session
 */

import Database from 'better-sqlite3';

import { debugLog } from '@/app/lib/debugLogger';
import { DB_PATH } from '@/services/paths';

import { type ChatMessage, type PersistedChatMessage, type SubagentLogMessage } from './llm';
import { sanitizeChatMessage } from './textUtils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Session {
  id: number;
  name: string;
  model: string;
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

// ---------------------------------------------------------------------------
// Database bootstrapping
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH);

// Enable WAL for better concurrent read performance and reliability.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
addColumnIfMissing("ALTER TABLE messages ADD COLUMN thinking TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("ALTER TABLE messages ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("ALTER TABLE messages ADD COLUMN subagent_id TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("ALTER TABLE messages ADD COLUMN tool_call_id TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('ALTER TABLE messages ADD COLUMN created_at DATETIME');
addColumnIfMissing("ALTER TABLE messages_staging ADD COLUMN tool_call_id TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('ALTER TABLE messages_staging ADD COLUMN created_at DATETIME');

// ---------------------------------------------------------------------------
// Prepared statements (created once, reused on every call)
// ---------------------------------------------------------------------------

const stmtInsertSession = db.prepare<[string, string]>(
  'INSERT INTO sessions (name, model) VALUES (?, ?)'
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

const stmtListSessions = db.prepare<[]>('SELECT * FROM sessions ORDER BY updated_at DESC');

const stmtDeleteSession = db.prepare<[number]>('DELETE FROM sessions WHERE id = ?');

const stmtDeleteMessages = db.prepare<[number]>('DELETE FROM messages WHERE session_id = ?');

const stmtLoadMessages = db.prepare<[number]>(
  'SELECT id, role, content, thinking, tool_calls, images, subagent_id, tool_call_id, created_at FROM messages WHERE session_id = ? ORDER BY id ASC'
);

// Session search only considers user prompts and assistant replies. Tool
// results, subagent logs, and other non-conversational roles are excluded
// so long tool outputs (fetched pages, command stdout, image base64, etc.)
// don't dominate the result list. The role filter lives on the JOIN (not
// in WHERE) so a session with no user/assistant messages can still match
// by its title.
const stmtSearchSessions = db.prepare<[string, string]>(
  `SELECT DISTINCT s.* FROM sessions s\n     LEFT JOIN messages m ON m.session_id = s.id AND m.role IN ('user', 'assistant')\n     WHERE LOWER(s.name) LIKE ? OR LOWER(m.content) LIKE ?\n     ORDER BY s.updated_at DESC`
);

const stmtGetSessionName = db.prepare<[number]>('SELECT name FROM sessions WHERE id = ?');

const stmtSessionExists = db.prepare<[number]>('SELECT 1 FROM sessions WHERE id = ?');

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
 * @param name  – Human-readable title (will be updated from first user message).
 * @param model – Ollama model name used in this session.
 */
export function createSession(name: string, model: string): number {
  const result = stmtInsertSession.run(name, model);
  return result.lastInsertRowid as number;
}

/**
 * Renames an existing session (e.g. to the first user prompt).
 */
export function renameSession(sessionId: number, name: string): void {
  stmtUpdateSessionName.run(name, sessionId);
}

/**
 * Returns the name of a session, or undefined if the session does not exist.
 */
export function getSessionName(sessionId: number): string | undefined {
  const row = stmtGetSessionName.get(sessionId) as { name: string } | undefined;
  return row?.name;
}

/**
 * Returns all sessions ordered by most-recently-updated first.
 */
export function listSessions(): Session[] {
  return stmtListSessions.all() as Session[];
}

/**
 * Searches sessions by title and the content of user/assistant messages.
 * Tool results, subagent logs, and other non-conversational roles are
 * intentionally excluded from the message-content half of the match.
 */
export function searchSessions(query: string): Session[] {
  const escaped = query.toLowerCase().replaceAll(/[%_]/g, String.raw`\$&`);
  const q = `%${escaped}%`;
  return stmtSearchSessions.all(q, q) as Session[];
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
  messages: PersistedChatMessage[],
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
        "tool_call_id TEXT NOT NULL DEFAULT '', created_at DATETIME)"
    );
    const stmtDeleteStaging = db.prepare<[number]>(
      'DELETE FROM messages_staging WHERE session_id = ?'
    );
    stmtDeleteStaging.run(sessionId);

    const stmtInsertStaging = db.prepare<
      [number, string, string, string, string, string, string, string, string | null]
    >(
      'INSERT INTO messages_staging (session_id, role, content, thinking, tool_calls, images, subagent_id, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    let persistIndex = 0;
    let persistToolCount = 0;
    let persistToolWithCallIdCount = 0;
    for (const msg of persistableMessages) {
      const sanitizedMessage = sanitizeChatMessage(msg);
      const subagentId =
        sanitizedMessage.role === 'subagent_log' && sanitizedMessage.subagentId
          ? sanitizedMessage.subagentId
          : '';
      const role = sanitizedMessage.role;
      const content = sanitizedMessage.content ?? '';
      const thinking =
        sanitizedMessage.role === 'subagent_log'
          ? ''
          : ((sanitizedMessage as ChatMessage).thinking ?? '');
      const toolCalls =
        sanitizedMessage.role === 'subagent_log'
          ? '[]'
          : JSON.stringify((sanitizedMessage as ChatMessage).tool_calls ?? []);
      const images =
        sanitizedMessage.role === 'subagent_log'
          ? '[]'
          : JSON.stringify((sanitizedMessage as ChatMessage).images ?? []);
      const toolCallId =
        sanitizedMessage.role === 'tool'
          ? ((sanitizedMessage as ChatMessage).tool_call_id ?? '')
          : '';
      // Only user-role messages carry a createdAt; assistant/tool/system/subagent_log
      // rows store NULL so they don't display a misleading timestamp in the UI.
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
        subagentId,
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
      'INSERT INTO messages (session_id, role, content, thinking, tool_calls, images, subagent_id, tool_call_id, created_at) ' +
        'SELECT session_id, role, content, thinking, tool_calls, images, subagent_id, tool_call_id, created_at ' +
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

/**
 * Loads and returns the full message history for a session.
 */
export function loadSessionMessages(sessionId: number): PersistedChatMessage[] {
  const rows = stmtLoadMessages.all(sessionId) as {
    id: number;
    role: string;
    content: string;
    thinking: string;
    tool_calls: string;
    images: string;
    subagent_id: string;
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

    if (row.role === 'subagent_log') {
      const msg: SubagentLogMessage = {
        role: 'subagent_log',
        content: row.content,
        id: rowId,
      };
      if (row.subagent_id) {
        msg.subagentId = row.subagent_id;
      }
      return sanitizeChatMessage(msg);
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
 * trailing assistant, tool, subagent_log, and system messages are removed too.
 *
 * The implementation reuses `updateSessionMessages` so the write is atomic and
 * token stats / updated_at are handled consistently.
 *
 * @returns The kept messages after deletion, in their original order.
 * @throws If the target message is not found, is not a user message, or the
 *         session does not exist.
 */
export function deleteMessagesFrom(sessionId: number, messageId: number): PersistedChatMessage[] {
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

  const keptMessages =
    nextUserIndex === -1
      ? messages.slice(0, targetIndex)
      : [...messages.slice(0, targetIndex), ...messages.slice(nextUserIndex)];

  updateSessionMessages(sessionId, keptMessages);
  return keptMessages;
}
