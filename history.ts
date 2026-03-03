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
import type { ChatMessage } from './ollamaApi.js';

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
        tool_calls TEXT    NOT NULL DEFAULT '[]',
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

const stmtInsertMessage = db.prepare<[number, string, string, string]>(
    'INSERT INTO messages (session_id, role, content, tool_calls) VALUES (?, ?, ?, ?)',
);

const stmtLoadMessages = db.prepare<[number]>(
    'SELECT role, content, tool_calls FROM messages WHERE session_id = ? ORDER BY id ASC',
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
 * Returns all sessions ordered by most-recently-updated first.
 */
export function listSessions(): Session[] {
    return stmtListSessions.all() as Session[];
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
    const run = db.transaction(() => {
        stmtDeleteMessages.run(sessionId);
        for (const msg of messages) {
            stmtInsertMessage.run(
                sessionId,
                msg.role,
                msg.content ?? '',
                JSON.stringify(msg.tool_calls ?? []),
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
 * Loads and returns the full message history for a session.
 */
export function loadSessionMessages(sessionId: number): ChatMessage[] {
    const rows = stmtLoadMessages.all(sessionId) as {
        role: string;
        content: string;
        tool_calls: string;
    }[];

    return rows.map(row => {
        let toolCalls = [];
        try {
            toolCalls = JSON.parse(row.tool_calls);
        } catch {
            // Fallback for corrupted JSON
            toolCalls = [];
        }
        const msg: ChatMessage = {
            role: row.role as ChatMessage['role'],
            content: row.content,
        };
        if (toolCalls && toolCalls.length > 0) {
            msg.tool_calls = toolCalls;
        }
        return msg;
    });
}
