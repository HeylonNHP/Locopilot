'use client';

import React, { createContext, type ReactNode, useContext, useReducer } from 'react';

import type { ToolCall } from '@/services/llm';
import type { ToolCallArguments } from '@/tools/tools';
import type { CompletionMode } from '@/types/chatConfig';

import { DEFAULT_NUM_CTX, DEFAULT_OLLAMA_CHAT_TIMEOUT_MS } from '@/constants';

export interface ChatMessage {
  /** Stable client-only identity used as React list key. Never sent to the server. */
  id?: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'subagent_log';
  content: string;
  thinking?: string;
  tool_calls?: [ToolCall, ...ToolCall[]];
  name?: string;
  /** Set on subagent_log messages to identify which sub-agent produced the output. */
  subagentId?: string;
  /** Base64-encoded image data for vision-capable models. */
  images?: string[];
  /** OpenAI-compatible: identifies which tool call this result answers. */
  tool_call_id?: string;
  /**
   * ISO-8601 wall-clock time captured at the moment the user pressed Enter.
   * Set on every user-role message; persisted to the messages.created_at
   * column. Always shown in the user bubble (independent of the
   * promptTimestamps toggle); the toggle controls LLM visibility only.
   */
  createdAt?: string;
}

/**
 * Generate a UUID v4 string that works in all browser contexts.
 * `crypto.randomUUID()` throws in non-secure contexts (plain HTTP),
 * so we fall back to a Math.random()-based v4 UUID when needed.
 */
function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback for non-secure contexts (plain HTTP) where
    // crypto.randomUUID() throws a TypeError.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replaceAll(/[xy]/g, (c) => {
      const r = Math.trunc(Math.random() * 16);
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

/** Return a copy of msg with a stable `id` field if it doesn't already have one. */
function withId(msg: ChatMessage): ChatMessage {
  return msg.id === undefined ? { ...msg, id: randomId() } : msg;
}

export interface Session {
  id: number;
  name: string;
  model: string;
  created_at: string;
  updated_at: string;
}

export interface LLmModel {
  name: string;
  modified_at?: string;
  size?: number;
  capabilities?: string[];
}

export interface WebSearchConfig {
  maxQueries: number;
  resultsPerQuery: number;
  perPageCharLimit: number;
}

export type DoneReason = 'stop' | 'length' | 'load' | 'unload' | 'unknown';

export interface SessionState {
  messages: ChatMessage[];
  error: string | null;
  tokenStats: {
    promptEvalCount: number;
    evalCount: number;
    totalTokens: number;
    tokenLimit: number;
    promptTps?: number;
    evalTps?: number;
    isEstimated?: boolean;
  } | null;
  currentTps: number | null;
  compactingPhases: string[];
  /**
   * Why the most recently completed turn's LLM stream ended. Populated from
   * the `done` SSE event's `doneReason` field (Ollama values: `stop`,
   * `length`, `load`, `unload`). `undefined` until a turn completes;
   * `unknown` is the fallback for older Ollama versions that omit the
   * field. `length` indicates the model hit `num_predict` and the response
   * was truncated; `stop` is a natural end-of-sequence. The client UI can
   * read this to surface a truncation hint (not yet implemented in v1).
   */
  lastDoneReason?: DoneReason | undefined;
  pendingApproval: {
    command: { name: string; args: ToolCallArguments } | null;
    requestId: string | null;
  } | null;
}

interface ChatState {
  messages: ChatMessage[];
  sessions: Session[];
  currentSessionId: number | null;
  model: string;
  models: LLmModel[];
  baseUrl: string;
  /**
   * The user's requested context-window size, persisted to config.json.
   * This is what the user typed in Settings; it is *not* the value
   * sent to the LLM. The server clamps it against the model's runtime
   * cap and reports the effective value back via the `status` SSE
   * event's `tokenLimit` field; that value populates
   * {@link effectiveNumCtx} below.
   */
  requestedNumCtx: number;
  /**
   * The effective context-window size — the value the server actually
   * sent to the LLM. Defaults to {@link requestedNumCtx} until the
   * first `status` or `done` event arrives; thereafter it tracks the
   * server's most recent reported value. The clamp itself is never
   * applied on the client.
   */
  effectiveNumCtx: number;
  error: string | null;
  // Approval dialog
  pendingCommand: { name: string; args: ToolCallArguments; toolCallName?: string } | null;
  showApproval: boolean;
  pendingApprovalId: string | null;
  // Additional persisted config fields
  yolo: boolean;
  thinkingEnabled: boolean;
  /**
   * When true, the server-side chat route prepends a `[Sent …]` header to
   * each user-role message before sending it to the LLM. The
   * messages.created_at column is always populated regardless of this flag.
   * Defaults to true.
   */
  promptTimestamps: boolean;
  compactionModel: string;
  chatTimeoutMs: number;
  webSearch: WebSearchConfig;
  /** Completion mode: 'normal' (default) or 'prompt-loop' (auto-continue). */
  completionMode: CompletionMode;
  /** Max prompt-loop iterations; 0 = unlimited. */
  maxPromptLoopIterations: number;
  /**
   * Why the most recently completed turn's LLM stream ended. Mirrors
   * `SessionState.lastDoneReason` for the active session. See that field
   * for the full description of the value space.
   */
  lastDoneReason?: DoneReason | undefined;
  tokenStats: {
    promptEvalCount: number;
    evalCount: number;
    totalTokens: number;
    tokenLimit: number;
    promptTps?: number;
    evalTps?: number;
    isEstimated?: boolean;
  } | null;
  currentTps: number | null;
  compactingPhases: string[];
  sessionStates: Map<number, SessionState>;
  newSessionState: SessionState;
  streamingSessions: Set<number>;
  /** Unsent text the user had typed before starting history navigation. */
  inputDraft: string;
  /** Index into user message history when browsing; null means not browsing. */
  historyIndex: number | null;
}

export type ChatAction =
  | { type: 'SET_MESSAGES'; messages: ChatMessage[]; targetSessionId?: number }
  | { type: 'ADD_MESSAGE'; message: ChatMessage }
  | { type: 'UPDATE_LAST_MESSAGE'; content?: string; thinking?: string }
  | { type: 'APPLY_ASSISTANT_DELTA'; content?: string; thinking?: string }
  | { type: 'APPEND_TOOL_PROGRESS'; content: string; name?: string }
  | { type: 'SUBAGENT_OUTPUT'; agentId: string; message: string }
  | { type: 'SUBAGENT_CHUNK'; agentId: string; text: string }
  | { type: 'SET_SESSIONS'; sessions: Session[] }
  | { type: 'ADD_SESSION'; session: Session }
  | { type: 'SET_CURRENT_SESSION'; id: number | null }
  | { type: 'SET_MODELS'; models: LLmModel[] }
  | { type: 'SET_MODEL'; model: string }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_CONFIG'; config: Partial<ChatState> }
  | {
      type: 'SET_EFFECTIVE_NUM_CTX';
      /** The effective numCtx reported by the server, or null to keep the previous value. */
      effective: number | null;
      /** The model's runtime cap, or null when the server has not resolved one. */
      cap: number | null;
    }
  | {
      type: 'SHOW_APPROVAL';
      command: { name: string; args: ToolCallArguments; toolCallName?: string } | null;
      requestId?: string;
    }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'REMOVE_LAST_ASSISTANT' }
  | { type: 'SET_TOKEN_STATS'; stats: ChatState['tokenStats']; targetSessionId?: number }
  | { type: 'SET_DONE_REASON'; reason: DoneReason | undefined; targetSessionId?: number }
  | { type: 'SET_CURRENT_TPS'; tps: number | null }
  | { type: 'CLEAR_TOKEN_STATS' }
  | { type: 'COMPACT_PROGRESS'; message: string }
  | { type: 'INIT_SESSION'; sessionId: number }
  | { type: 'SAVE_ACTIVE_SESSION' }
  | { type: 'RESTORE_SESSION'; sessionId: number | null }
  | { type: 'DISCARD_SESSION'; sessionId: number }
  | { type: 'CLEAR_COMPACT_PROGRESS' }
  | { type: 'START_STREAMING'; sessionId: number }
  | { type: 'STOP_STREAMING'; sessionId: number }
  | { type: 'SAVE_INPUT_DRAFT'; draft: string }
  | { type: 'SET_HISTORY_INDEX'; index: number | null }
  | { type: 'CLEAR_HISTORY_NAVIGATION' };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SET_MESSAGES': {
      // Ignore the dispatch if it was meant for a different session.
      // This prevents stale async responses from loadSessionMessages
      // from overwriting the currently-viewed session's messages.
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        return state;
      }
      if (
        action.messages.length === 0 &&
        action.targetSessionId !== undefined &&
        state.streamingSessions.has(action.targetSessionId)
      ) {
        return state;
      }
      return {
        ...state,
        messages: action.messages.filter((m: ChatMessage) => m.role !== 'system').map(withId),
      };
    }
    case 'SAVE_INPUT_DRAFT': {
      return { ...state, inputDraft: action.draft };
    }
    case 'SET_HISTORY_INDEX': {
      return { ...state, historyIndex: action.index };
    }
    case 'CLEAR_HISTORY_NAVIGATION': {
      return { ...state, inputDraft: '', historyIndex: null };
    }
    case 'ADD_MESSAGE': {
      if (action.message.role === 'user') {
        return {
          ...state,
          messages: [...state.messages, withId(action.message)],
          inputDraft: '',
          historyIndex: null,
        };
      }
      return { ...state, messages: [...state.messages, withId(action.message)] };
    }
    case 'UPDATE_LAST_MESSAGE': {
      const msgs = [...state.messages];
      const last = msgs.at(-1);
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = {
          ...last,
          ...(action.content === undefined ? {} : { content: last.content + action.content }),
          ...(action.thinking === undefined
            ? {}
            : { thinking: (last.thinking || '') + action.thinking }),
        };
      }
      return { ...state, messages: msgs };
    }
    case 'APPLY_ASSISTANT_DELTA': {
      const msgs = [...state.messages];
      const last = msgs.at(-1);

      if (!last || last.role !== 'assistant') {
        msgs.push(
          withId({
            role: 'assistant',
            content: action.content ?? '',
            ...(action.thinking === undefined ? {} : { thinking: action.thinking }),
          })
        );
        return { ...state, messages: msgs };
      }

      msgs[msgs.length - 1] = {
        ...last,
        ...(action.content === undefined ? {} : { content: last.content + action.content }),
        ...(action.thinking === undefined
          ? {}
          : { thinking: (last.thinking || '') + action.thinking }),
      };
      return { ...state, messages: msgs };
    }
    case 'APPEND_TOOL_PROGRESS': {
      const msgs = [...state.messages];
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const candidate = msgs[i];
        if (!candidate || candidate.role !== 'tool') {
          continue;
        }
        if (action.name && candidate.name && candidate.name !== action.name) {
          continue;
        }

        msgs[i] = {
          ...candidate,
          content: candidate.content ? `${candidate.content}\n${action.content}` : action.content,
        };
        return { ...state, messages: msgs };
      }

      return {
        ...state,
        messages: [
          ...state.messages,
          withId({
            role: 'tool',
            content: action.content,
            ...(action.name ? { name: action.name } : {}),
          }),
        ],
      };
    }
    case 'SUBAGENT_CHUNK': {
      // Append raw token text (thinking or content) inline to the same content
      // field so it reads in order alongside tool call output.
      const msgs = [...state.messages];
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const candidate = msgs[i];
        if (!candidate || candidate.role !== 'subagent_log') {
          continue;
        }
        if (candidate.subagentId !== action.agentId) {
          continue;
        }
        msgs[i] = { ...candidate, content: candidate.content + action.text };
        return { ...state, messages: msgs };
      }
      // No bubble yet — create one.
      return {
        ...state,
        messages: [
          ...state.messages,
          withId({ role: 'subagent_log', content: action.text, subagentId: action.agentId }),
        ],
      };
    }
    case 'SUBAGENT_OUTPUT': {
      const msgs = [...state.messages];
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const candidate = msgs[i];
        if (!candidate || candidate.role !== 'subagent_log') {
          continue;
        }
        if (candidate.subagentId !== action.agentId) {
          continue;
        }
        msgs[i] = {
          ...candidate,
          content: candidate.content ? `${candidate.content}\n${action.message}` : action.message,
        };
        return { ...state, messages: msgs };
      }
      // No existing bubble for this agent — create one.
      return {
        ...state,
        messages: [
          ...state.messages,
          withId({
            role: 'subagent_log',
            content: action.message,
            subagentId: action.agentId,
          }),
        ],
      };
    }
    case 'SET_SESSIONS': {
      return { ...state, sessions: action.sessions };
    }
    case 'ADD_SESSION': {
      // Prepend the new session so it appears at the top of the sidebar
      const exists = state.sessions.some((s) => s.id === action.session.id);
      if (exists) return state;
      return { ...state, sessions: [action.session, ...state.sessions] };
    }
    case 'SET_CURRENT_SESSION': {
      // 1. Save current active session into its slot
      const snapshot: SessionState = {
        messages: state.messages,
        error: state.error,
        tokenStats: state.tokenStats,
        currentTps: state.currentTps,
        compactingPhases: state.compactingPhases,
        lastDoneReason: state.lastDoneReason,
        pendingApproval: state.pendingCommand
          ? {
              command: state.pendingCommand,
              requestId: state.pendingApprovalId,
            }
          : null,
      };

      let nextState = { ...state };

      if (state.currentSessionId === null) {
        nextState = { ...nextState, newSessionState: snapshot };
      } else {
        const newMap = new Map(state.sessionStates);
        newMap.set(state.currentSessionId, snapshot);
        nextState = { ...nextState, sessionStates: newMap };
      }

      // 2. Switch to the new session
      nextState = { ...nextState, currentSessionId: action.id };

      // 3. Restore the new session's state into active fields
      if (action.id === null) {
        nextState = {
          ...nextState,
          messages: nextState.newSessionState.messages,
          error: nextState.newSessionState.error,
          tokenStats: nextState.newSessionState.tokenStats,
          currentTps: nextState.newSessionState.currentTps,
          compactingPhases: nextState.newSessionState.compactingPhases,
          lastDoneReason: nextState.newSessionState.lastDoneReason,
        };
      } else {
        let session = nextState.sessionStates.get(action.id);
        // If we were on the new-session view and the server just assigned a
        // real ID, promote the newSessionState into sessionStates so the
        // locally-added first message (and any streaming chunks) survive.
        if (!session && state.currentSessionId === null) {
          const newMap = new Map(nextState.sessionStates);
          const promoted = nextState.newSessionState;
          newMap.set(action.id, promoted);
          nextState = {
            ...nextState,
            sessionStates: newMap,
            newSessionState: {
              messages: [],
              error: null,
              tokenStats: null,
              currentTps: null,
              compactingPhases: [],
              pendingApproval: null,
              lastDoneReason: undefined,
            },
          };
          session = promoted;
        }
        nextState = session
          ? {
              ...nextState,
              messages: session.messages,
              error: session.error,
              tokenStats: session.tokenStats,
              currentTps: session.currentTps,
              compactingPhases: session.compactingPhases,
              lastDoneReason: session.lastDoneReason,
            }
          : // Session not yet initialised — start fresh (don't auto-create slot)
            {
              ...nextState,
              messages: [],
              error: null,
              tokenStats: null,
              currentTps: null,
              compactingPhases: [],
            };
      }

      // Restore pending approval state
      const targetSession = action.id === null ? null : nextState.sessionStates.get(action.id);
      const pendingApproval =
        targetSession?.pendingApproval ?? nextState.newSessionState.pendingApproval;
      nextState = pendingApproval ? {
          ...nextState,
          pendingCommand: pendingApproval.command,
          showApproval: pendingApproval.command !== null,
          pendingApprovalId: pendingApproval.requestId,
        } : {
          ...nextState,
          pendingCommand: null,
          showApproval: false,
          pendingApprovalId: null,
        };

      return { ...nextState, inputDraft: '', historyIndex: null };
    }
    case 'SET_MODELS': {
      return { ...state, models: action.models };
    }
    case 'SET_MODEL': {
      return { ...state, model: action.model };
    }
    case 'SET_ERROR': {
      return { ...state, error: action.error };
    }
    case 'SET_CONFIG': {
      // The clamp is the server's responsibility. SET_CONFIG only
      // stores the user's requested value; the effective value is
      // updated by SET_TOKEN_STATS and SET_EFFECTIVE_NUM_CTX when
      // the server reports back.
      return { ...state, ...action.config };
    }
    case 'SHOW_APPROVAL': {
      let nextState: ChatState = {
        ...state,
        pendingCommand: action.command,
        showApproval: action.command !== null,
        pendingApprovalId: action.requestId ?? null,
      };

      // Bug 5 fix: when hiding the modal, clear pendingApproval from ALL sessions
      // so stale approvals don't reappear when switching back to a session.
      if (action.command === null) {
        const newMap = new Map(nextState.sessionStates);
        for (const [id, sess] of newMap) {
          if (sess.pendingApproval !== null) {
            newMap.set(id, { ...sess, pendingApproval: null });
          }
        }
        nextState = { ...nextState, sessionStates: newMap };
        nextState = {
          ...nextState,
          newSessionState: { ...nextState.newSessionState, pendingApproval: null },
        };
        return nextState;
      }

      // Also persist into the active session's state so it survives switching
      if (state.currentSessionId !== null) {
        let session = nextState.sessionStates.get(state.currentSessionId);
        // Bug 4 fix: auto-initialize the session slot if it doesn't exist yet
        if (!session) {
          const newMap = new Map(nextState.sessionStates);
          session = {
            messages: [],
            error: null,
            tokenStats: null,
            currentTps: null,
            compactingPhases: [],
            pendingApproval: null,
            lastDoneReason: undefined,
          };
          newMap.set(state.currentSessionId, session);
          nextState = { ...nextState, sessionStates: newMap };
        }
        const newMap = new Map(nextState.sessionStates);
        newMap.set(state.currentSessionId, {
          ...session,
          pendingApproval: action.command
            ? {
                command: action.command,
                requestId: action.requestId ?? null,
              }
            : null,
        });
        return { ...nextState, sessionStates: newMap };
      }

      // New session (currentSessionId is null)
      nextState = {
        ...nextState,
        newSessionState: {
          ...nextState.newSessionState,
          pendingApproval: action.command
            ? {
                command: action.command,
                requestId: action.requestId ?? null,
              }
            : null,
        },
      };
      return nextState;
    }
    case 'SET_EFFECTIVE_NUM_CTX': {
      // The server reports the effective numCtx and the model cap
      // together. The cap flows through SET_TOKEN_STATS (which the
      // client reads for the Settings display) so we only update it
      // here when the server explicitly sends it; the effective
      // value is always replaced when present.
      const next: ChatState = { ...state };
      if (action.effective !== null && Number.isFinite(action.effective) && action.effective > 0) {
        next.effectiveNumCtx = action.effective;
      }
      return next;
    }
    case 'CLEAR_MESSAGES': {
      return { ...state, messages: [] };
    }
    case 'REMOVE_LAST_ASSISTANT': {
      const msgs = state.messages;
      if (msgs.length > 0) {
        const last = msgs.at(-1);
        if (last && last.role === 'assistant') {
          return { ...state, messages: msgs.slice(0, -1) };
        }
      }
      return state;
    }
    case 'SET_TOKEN_STATS': {
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        return state;
      }
      // Merge with existing stats so that durable fields like evalTps /
      // promptTps (sent once on the `done` event) survive transient
      // `status` updates that only carry tokensUsed / tokenLimit.
      const base = state.tokenStats ?? {
        promptEvalCount: 0,
        evalCount: 0,
        totalTokens: 0,
        tokenLimit: 0,
      };
      const merged = { ...base, ...action.stats };
      // The server's per-turn tokenLimit is the authoritative effective
      // numCtx. Sync state.effectiveNumCtx from it whenever a positive
      // value arrives; ignore 0 (used as a clear-sentinel elsewhere
      // and would clobber a real cap with the fallback default).
      const effectiveFromStats =
        typeof merged.tokenLimit === 'number' &&
        Number.isFinite(merged.tokenLimit) &&
        merged.tokenLimit > 0
          ? merged.tokenLimit
          : null;
      return {
        ...state,
        tokenStats: merged,
        ...(effectiveFromStats === null ? {} : { effectiveNumCtx: effectiveFromStats }),
      };
    }
    case 'SET_DONE_REASON': {
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        return state;
      }
      return { ...state, lastDoneReason: action.reason };
    }
    case 'SET_CURRENT_TPS': {
      return { ...state, currentTps: action.tps };
    }
    case 'CLEAR_TOKEN_STATS': {
      return { ...state, tokenStats: null };
    }
    case 'COMPACT_PROGRESS': {
      return { ...state, compactingPhases: [...state.compactingPhases, action.message] };
    }
    case 'INIT_SESSION': {
      if (state.sessionStates.has(action.sessionId)) return state;
      const newMap = new Map(state.sessionStates);
      newMap.set(action.sessionId, {
        messages: [],
        error: null,
        tokenStats: null,
        currentTps: null,
        compactingPhases: [],
        pendingApproval: null,
        lastDoneReason: undefined,
      });
      return { ...state, sessionStates: newMap };
    }
    case 'SAVE_ACTIVE_SESSION': {
      const snapshot: SessionState = {
        messages: state.messages,
        error: state.error,
        tokenStats: state.tokenStats,
        currentTps: state.currentTps,
        compactingPhases: state.compactingPhases,
        lastDoneReason: state.lastDoneReason,
        pendingApproval: state.pendingCommand
          ? {
              command: state.pendingCommand,
              requestId: state.pendingApprovalId,
            }
          : null,
      };
      if (state.currentSessionId !== null) {
        const newMap = new Map(state.sessionStates);
        newMap.set(state.currentSessionId, snapshot);
        return { ...state, sessionStates: newMap };
      }
      return { ...state, newSessionState: snapshot };
    }
    case 'RESTORE_SESSION': {
      if (action.sessionId !== null) {
        const session = state.sessionStates.get(action.sessionId);
        if (session) {
          return {
            ...state,
            messages: session.messages,
            error: session.error,
            tokenStats: session.tokenStats,
            currentTps: session.currentTps,
            compactingPhases: session.compactingPhases,
            lastDoneReason: session.lastDoneReason,
            pendingCommand: session.pendingApproval?.command ?? null,
            showApproval: session.pendingApproval
              ? session.pendingApproval.command !== null
              : false,
            pendingApprovalId: session.pendingApproval?.requestId ?? null,
          };
        }
        return {
          ...state,
          messages: [],
          error: null,
          tokenStats: null,
          currentTps: null,
          compactingPhases: [],
          pendingCommand: null,
          showApproval: false,
          pendingApprovalId: null,
        };
      }
      return {
        ...state,
        messages: state.newSessionState.messages,
        error: state.newSessionState.error,
        tokenStats: state.newSessionState.tokenStats,
        currentTps: state.newSessionState.currentTps,
        compactingPhases: state.newSessionState.compactingPhases,
        lastDoneReason: state.newSessionState.lastDoneReason,
        pendingCommand: state.newSessionState.pendingApproval?.command ?? null,
        showApproval: state.newSessionState.pendingApproval
          ? state.newSessionState.pendingApproval.command !== null
          : false,
        pendingApprovalId: state.newSessionState.pendingApproval?.requestId ?? null,
      };
    }
    case 'DISCARD_SESSION': {
      const newMap = new Map(state.sessionStates);
      newMap.delete(action.sessionId);
      const newStreaming = new Set(state.streamingSessions);
      newStreaming.delete(action.sessionId);
      return { ...state, sessionStates: newMap, streamingSessions: newStreaming };
    }
    case 'START_STREAMING': {
      return {
        ...state,
        streamingSessions: new Set(state.streamingSessions).add(action.sessionId),
      };
    }
    case 'STOP_STREAMING': {
      const nextSet = new Set(state.streamingSessions);
      nextSet.delete(action.sessionId);
      // Clear stale compaction phases when the visible session's stream
      // ends, so old progress text doesn't linger into the next interaction
      // or leak across session switches.  Skip the session_created
      // placeholder migration (-1 → realId) where streaming continues
      // under a new id — the currentSessionId has already been updated
      // to the real id by that point, so the guard below naturally
      // excludes it.
      const isVisibleSession =
        (state.currentSessionId === null && action.sessionId === -1) ||
        state.currentSessionId === action.sessionId;
      return {
        ...state,
        streamingSessions: nextSet,
        ...(isVisibleSession ? { compactingPhases: [] } : {}),
      };
    }
    case 'CLEAR_COMPACT_PROGRESS': {
      return { ...state, compactingPhases: [] };
    }
    default: {
      return state;
    }
  }
}

const initialState: ChatState = {
  messages: [],
  sessions: [],
  currentSessionId: null,
  model: '',
  models: [],
  baseUrl: 'http://localhost:11434',
  requestedNumCtx: DEFAULT_NUM_CTX,
  effectiveNumCtx: DEFAULT_NUM_CTX,
  error: null,
  pendingCommand: null,
  showApproval: false,
  pendingApprovalId: null,
  yolo: false,
  thinkingEnabled: true,
  promptTimestamps: true,
  compactionModel: '',
  chatTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
  webSearch: {
    maxQueries: 3,
    resultsPerQuery: 3,
    perPageCharLimit: 5000,
  },
  completionMode: 'normal',
  maxPromptLoopIterations: 4,
  tokenStats: null,
  currentTps: null,
  compactingPhases: [],
  sessionStates: new Map<number, SessionState>(),
  newSessionState: {
    messages: [],
    error: null,
    tokenStats: null,
    currentTps: null,
    compactingPhases: [],
    pendingApproval: null,
    lastDoneReason: undefined,
  },
  streamingSessions: new Set<number>(),
  inputDraft: '',
  historyIndex: null,
};

export function selectUserMessages(state: ChatState): ChatMessage[] {
  return state.messages.filter((m) => m.role === 'user');
}

const ChatContext = createContext<{
  state: ChatState;
  dispatch: React.Dispatch<ChatAction>;
}>({ state: initialState, dispatch: () => {} });

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  return React.createElement(ChatContext.Provider, { value: { state, dispatch } }, children);
}

export function useChat() {
  return useContext(ChatContext);
}

