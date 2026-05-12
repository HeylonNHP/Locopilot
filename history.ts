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
import path from 'path';
import { type ChatMessage } from './services/llm';
import { sanitizeChatMessage } from './services/textUtils';

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

const DB_PATH = path.join(process.cwd(), 'locopilot.db');

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
addColumnIfMissing('ALTER TABLE messages ADD COLUMN thinking TEXT NOT NULL DEFAULT \'\'');
addColumnIfMissing('ALTER TABLE messages ADD COLUMN images TEXT NOT NULL DEFAULT \'[]\'');
addColumnIfMissing('ALTER TABLE messages ADD COLUMN subagent_id TEXT NOT NULL DEFAULT \'\'');

// ---------------------------------------------------------------------------
// Prepared statements (created once, reused on every call)
// ---------------------------------------------------------------------------

const stmtInsertSession = db.prepare<[string, string]>(
    'INSERT INTO sessions (name, model) VALUES (?, ?)',
);

const stmtUpdateSessionName = db.prepare<[string, number]>(
    'UPDATE sessions SET name = ?, updated_at = datetime(\'now\') WHERE id = ?',
);

const stmtUpdateSessionTimestamp = db.prepare<[number]>(
    'UPDATE sessions SET updated_at = datetime(\'now\') WHERE id = ?',
);

const stmtUpdateSessionModel = db.prepare<[string, number]>(
    'UPDATE sessions SET model = ?, updated_at = datetime(\'now\') WHERE id = ?',
);

const stmtUpdateSessionTokenStats = db.prepare<[number, number, number, number]>(
    'UPDATE sessions SET last_prompt_eval_count = ?, last_eval_count = ?, last_total_tokens = ?, updated_at = datetime(\'now\') WHERE id = ?',
);

const stmtListSessions = db.prepare<[]>(
    'SELECT * FROM sessions ORDER BY updated_at DESC',
);

const stmtDeleteSession = db.prepare<[number]>(
    'DELETE FROM sessions WHERE id = ?',
);

const stmtDeleteMessages = db.prepare<[number]>(
    'DELETE FROM messages WHERE session_id = ?',
);

const stmtInsertMessage = db.prepare<[number, string, string, string, string, string, string]>(
    'INSERT INTO messages (session_id, role, content, thinking, tool_calls, images, subagent_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
);

const stmtLoadMessages = db.prepare<[number]>(
    'SELECT role, content, thinking, tool_calls, images, subagent_id FROM messages WHERE session_id = ? ORDER BY id ASC',
);

const stmtSearchSessions = db.prepare<[string, string]>(
    `SELECT DISTINCT s.* FROM sessions s\n     LEFT JOIN messages m ON m.session_id = s.id\n     WHERE LOWER(s.name) LIKE ? OR LOWER(m.content) LIKE ?\n     ORDER BY s.updated_at DESC`,
);

const stmtGetSessionName = db.prepare<[number]>(
    'SELECT name FROM sessions WHERE id = ?',
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
 * Searches sessions by title and message content.
 */
export function searchSessions(query: string): Session[] {
    const escaped = query.toLowerCase().replace(/[%_]/g, '\\$&');
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
    messages: ChatMessage[],
    tokenStats?: SessionTokenStats | null,
): void {
    // Strip system messages before persisting — the system prompt is always
    // injected on-the-fly and should never be stored in the database.
    const persistableMessages = messages.filter((m) => m.role !== 'system');

    const run = db.transaction(() => {
        stmtDeleteMessages.run(sessionId);
        for (const msg of persistableMessages) {
            const sanitizedMessage = sanitizeChatMessage(msg);
            stmtInsertMessage.run(
                sessionId,
                sanitizedMessage.role,
                sanitizedMessage.content ?? '',
                sanitizedMessage.thinking ?? '',
                JSON.stringify(sanitizedMessage.tool_calls ?? []),
                JSON.stringify(sanitizedMessage.images ?? []),
                (msg as any).subagentId ?? '',
            );
        }
        if (tokenStats) {
            const totalTokens = tokenStats.promptEvalCount + tokenStats.evalCount;
            stmtUpdateSessionTokenStats.run(
                tokenStats.promptEvalCount,
                tokenStats.evalCount,
                totalTokens,
                sessionId,
            );
        } else {
            stmtUpdateSessionTimestamp.run(sessionId);
        }
    });
    run();
}

/**
 * Updates the persisted model for an existing session.
 */
export function updateSessionModel(sessionId: number, model: string): void {
    stmtUpdateSessionModel.run(model, sessionId);
}

/**
 * Loads and returns the full message history for a session.
 */
export function loadSessionMessages(sessionId: number): ChatMessage[] {
    const rows = stmtLoadMessages.all(sessionId) as {
        role: string;
        content: string;
        thinking: string;
        tool_calls: string;
        images: string;
        subagent_id: string;
    }[];

    return rows.map(row => {
        let toolCalls: ChatMessage['tool_calls'] | undefined = undefined;
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
        };
        if (row.subagent_id) {
            (msg as any).subagentId = row.subagent_id;
        }
        if (row.thinking) {
            msg.thinking = row.thinking;
        }
        if (toolCalls && toolCalls.length > 0) {
            msg.tool_calls = toolCalls;
        }
        if (images && images.length > 0) {
            msg.images = images;
        }
        return sanitizeChatMessage(msg);
    });
}
