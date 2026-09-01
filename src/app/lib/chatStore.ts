'use client';

import React, { createContext, type ReactNode, useContext, useReducer } from 'react';

import type { ToolCall } from '@/services/llm';
import type { VisionSupportState } from '@/services/visionCache';
import type { ToolCallArguments } from '@/tools/tools';
import type { CompletionMode, ProviderConfig, ReasoningEffort } from '@/types/chatConfig';

import { DEFAULT_NUM_CTX, DEFAULT_OLLAMA_CHAT_TIMEOUT_MS } from '@/constants';
import {
  DEFAULT_MAX_PROMPT_LOOP_ITERATIONS,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_PROVIDER,
  DEFAULT_WEB_SEARCH_SETTINGS,
} from '@/services/configDefaults';

export interface ChatMessage {
  /**
   * Stable identity used as React list key. For messages loaded from the
   * database this is the numeric row id; for client-side messages it is a
   * generated UUID. Never sent to the server.
   */
  id?: string | number;
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

/**
 * Return a copy of msg with a stable identity for React rendering.
 *
 * - If the message already has an id (e.g. a numeric DB row id loaded from
 *   history.ts), preserve it so features like prompt deletion can reference
 *   the persisted row.
 * - Otherwise assign a client-only UUID so the React key is stable while the
 *   message is being streamed or waiting for persistence.
 */
function withId(msg: ChatMessage): ChatMessage {
  if (msg.id !== undefined) return msg;
  return { ...msg, id: randomId() };
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
  /** Human-readable label to show in the UI (e.g. OpenRouter's friendly model name). */
  displayName?: string;
  modified_at?: string;
  size?: number;
  capabilities?: string[];
  /** The provider this model belongs to. */
  providerId: string;
  providerName: string;
  provider: 'ollama' | 'openai-compatible';
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
    modelContextLimit?: number | null;
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
  modelsLoading: boolean;
  /**
   * Configured provider endpoints. When non-empty, the UI aggregates
   * models from every provider and the user picks which provider/model
   * to use per turn. The legacy top-level `provider`/`baseUrl`/`apiKey`
   * fields are still present for backward compatibility.
   */
  providers: ProviderConfig[];
  /** The id of the currently selected provider, used to pick credentials. */
  activeProviderId: string | null;
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
   * The active LLM provider — `'ollama'` (default) or
   * `'openai-compatible'`. Loaded from `config.json` on mount via
   * `useDataLoaders.loadConfig`. The ChatInput uses this to decide
   * whether to render the "vision support unconfirmed" hint for
   * openai-compatible providers (whose `/v1/models` endpoint has
   * no standard `capabilities` field, so the optimistic default in
   * `visionCache.ts` carries more weight there).
   */
  provider: 'ollama' | 'openai-compatible';
  /**
   * The effective context-window size — the value the server actually
   * sent to the LLM. `null` until the first `status` or `done` event
   * arrives; thereafter it tracks the server's most recent reported
   * value. The clamp itself is never applied on the client.
   *
   * The `null` initial state is important: a non-null default (e.g.
   * `DEFAULT_NUM_CTX`) would be displayed in the Settings modal as
   * "capped by model limit" the moment the user opens the modal,
   * which would be a lie — the server has not yet reported a cap.
   * Components that consume this field should treat `null` as
   * "server has not yet responded" and either show nothing, show a
   * muted placeholder, or fall back to `requestedNumCtx` (the
   * user's own setting) for display purposes.
   */
  effectiveNumCtx: number | null;
  error: string | null;
  // Approval dialog
  pendingCommand: { name: string; args: ToolCallArguments; toolCallName?: string } | null;
  showApproval: boolean;
  pendingApprovalId: string | null;
  // Additional persisted config fields
  yolo: boolean;
  thinkingEnabled: boolean;
  /**
   * Reasoning effort for OpenAI-compatible providers. Maps to the
   * wire `reasoning_effort` field (`'off' → 'none'`, otherwise
   * passthrough). Distinct from `thinkingEnabled` (Ollama-only).
   * Defaults to 'off' so models with reasoning on by default don't
   * silently reject chat-completions requests that include tools.
   */
  reasoningEffort: ReasoningEffort;
  /**
   * Reasoning effort for the COMPACTION model. Same canonical value space
   * as `reasoningEffort` — the provider adapters translate it (Ollama maps
   * `xhigh` → `max`, `off/none` → `false`). Defaults to 'off' (no explicit
   * level; adapter defaults apply).
   */
  compactionReasoningEffort: ReasoningEffort;
  /**
   * When true, the server-side chat route prepends a `[Sent …]` header to
   * each user-role message before sending it to the LLM. The
   * messages.created_at column is always populated regardless of this flag.
   * Defaults to true.
   */
  promptTimestamps: boolean;
  /**
   * When true (default), instruct the model to cite web-research sources as
   * numbered links with a trailing Sources list. Toggled in Settings. See
   * `Config.citeSources` for the persisted counterpart.
   */
  citeSources: boolean;
  compactionModel: string;
  /**
   * Transient: which provider the compaction model belongs to. Captured
   * when the user picks a compaction model in the ModelSelector (so a model
   * on a different provider than the main one can be used for compaction)
   * and reset to `null` for "Same as main model". Not persisted to
   * config.json — the right provider is re-derived when the user re-picks
   * a model in the grouped selector.
   */
  compactionProviderId: string | null;
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
  /**
   * The active model's vision (image-input) support, as known to the
   * server. Mirrors the same field on the SessionState but is
   * deliberately chat-scoped (not per-session) so the model selector
   * can drive the warning UI regardless of which session is active.
   *
   * - `'unknown'` is the initial state before the first chat turn;
   *   the ChatInput renders a softer "unconfirmed" hint for
   *   openai-compatible providers in this state.
   * - `'supported'` means the cache is confident images will reach
   *   the model (openai-compatible optimistic default, ollama
   *   `/api/show` with `capabilities: ["vision"]`, or a 400-driven
   *   discovery that the model accepts images — though in practice
   *   the cache only ever records `'unsupported'` from 400s).
   * - `'unsupported'` means the model will not accept image input;
   *   the ChatInput renders an inline warning so the user knows
   *   their attached image will be dropped.
   */
  visionState: VisionSupportState;
  /**
   * True between requesting a mid-turn model switch via
   * `/api/chat/switch-model` and the server confirming it with a
   * `model_switched` status event. `model` / `compactionModel` already hold
   * the newly picked values (they govern the next turn regardless), so this
   * flag exists purely so the UI can say the running turn has not taken the
   * new model on board yet, instead of implying the swap was instant.
   */
  modelSwitchPending: boolean;
  tokenStats: {
    promptEvalCount: number;
    evalCount: number;
    totalTokens: number;
    tokenLimit: number;
    promptTps?: number;
    evalTps?: number;
    isEstimated?: boolean;
    /**
     * The model's runtime cap as reported by the server. `null`
     * until the server has responded at least once. Components
     * that decide whether to display the "capped by model limit"
     * hint should read this field directly rather than
     * comparing {@link effectiveNumCtx} to
     * {@link requestedNumCtx}.
     */
    modelContextLimit?: number | null;
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
  | {
      type: 'SET_MESSAGES';
      messages: ChatMessage[];
      targetSessionId?: number;
      allowEmptyWhileStreaming?: boolean;
    }
  | { type: 'ADD_MESSAGE'; message: ChatMessage; targetSessionId?: number }
  | { type: 'UPDATE_LAST_MESSAGE'; content?: string; thinking?: string; targetSessionId?: number }
  | { type: 'APPLY_ASSISTANT_DELTA'; content?: string; thinking?: string; targetSessionId?: number }
  | { type: 'APPEND_TOOL_PROGRESS'; content: string; name?: string; targetSessionId?: number }
  | { type: 'SUBAGENT_OUTPUT'; agentId: string; message: string; targetSessionId?: number }
  | { type: 'SUBAGENT_CHUNK'; agentId: string; text: string; targetSessionId?: number }
  | { type: 'SET_SESSIONS'; sessions: Session[] }
  | { type: 'ADD_SESSION'; session: Session }
  | { type: 'SET_CURRENT_SESSION'; id: number | null }
  | { type: 'SET_MODELS'; models: LLmModel[] }
  | { type: 'SET_MODELS_LOADING'; modelsLoading: boolean }
  | { type: 'SET_PROVIDERS'; providers: ProviderConfig[] }
  | { type: 'SET_ACTIVE_PROVIDER'; providerId: string | null }
  | { type: 'SET_MODEL'; model: string }
  | { type: 'SET_ERROR'; error: string | null; targetSessionId?: number }
  | { type: 'SET_CONFIG'; config: Partial<ChatState> }
  | {
      type: 'SHOW_APPROVAL';
      command: { name: string; args: ToolCallArguments; toolCallName?: string } | null;
      requestId?: string;
    }
  | { type: 'CLEAR_MESSAGES'; targetSessionId?: number }
  | { type: 'REMOVE_LAST_ASSISTANT'; targetSessionId?: number }
  | {
      type: 'SET_TOKEN_STATS';
      stats: Partial<NonNullable<ChatState['tokenStats']>>;
      targetSessionId?: number;
    }
  | { type: 'SET_DONE_REASON'; reason: DoneReason | undefined; targetSessionId?: number }
  | { type: 'SET_CURRENT_TPS'; tps: number | null; targetSessionId?: number }
  | { type: 'CLEAR_TOKEN_STATS'; targetSessionId?: number }
  | { type: 'COMPACT_PROGRESS'; message: string; targetSessionId?: number }
  | { type: 'DISCARD_SESSION'; sessionId: number }
  | { type: 'CLEAR_COMPACT_PROGRESS'; targetSessionId?: number }
  | { type: 'START_STREAMING'; sessionId: number }
  | { type: 'STOP_STREAMING'; sessionId: number }
  | { type: 'SAVE_INPUT_DRAFT'; draft: string }
  | { type: 'SET_HISTORY_INDEX'; index: number | null }
  | { type: 'CLEAR_HISTORY_NAVIGATION' }
  | { type: 'SET_VISION_STATE'; state: VisionSupportState };

/**
 * Create a fresh SessionState slot for a session that does not have one
 * yet. Used when an action targets a session id that exists in
 * `state.streamingSessions` (or otherwise known) but the slot has not been
 * created yet. Mirrors the initial `newSessionState` shape in
 * `initialState` below.
 */
function emptySessionState(): SessionState {
  return {
    messages: [],
    error: null,
    tokenStats: null,
    currentTps: null,
    compactingPhases: [],
    pendingApproval: null,
    lastDoneReason: undefined,
  };
}

/**
 * Apply a per-session mutation. If `targetId` matches the current
 * session, mutate the top-level state fields (which is what the
 * rendered UI reads). If `targetId` is for a different session
 * (including the placeholder -1 for a not-yet-created session), update
 * the entry in `sessionStates` (or `newSessionState` when targetId is
 * -1) and leave the top-level state alone — the user is viewing a
 * different session and the buffered event will be replayed when they
 * return.
 *
 * `mutate` is invoked with the SessionState to update and a `setField`
 * helper that patches one of the top-level SessionState fields back
 * into the parent state. When `targetId` matches the current session
 * the helper is a no-op (the parent state is already updated by the
 * reducer case directly); when it does not match, the helper updates
 * the slot in `sessionStates`.
 */
type SessionMutation = (slot: SessionState) => SessionState;
type ApplyResult = { nextState: ChatState; fieldUpdated: boolean };

function applyToSession(
  state: ChatState,
  targetId: number | undefined,
  mutate: SessionMutation
): ApplyResult {
  // No target id provided: legacy callers dispatch against whatever
  // the current session is. This is the buggy "global" path that
  // useChatStream now avoids, but we still support it for callers
  // (e.g. SET_ERROR dispatched from sendChatMessage's catch) that
  // intentionally want the current-session behaviour.
  if (targetId === undefined) {
    return { nextState: state, fieldUpdated: false };
  }

  if (targetId === state.currentSessionId) {
    return { nextState: state, fieldUpdated: false };
  }

  if (targetId === -1) {
    // Placeholder for a not-yet-created session (e.g. mid-creation
    // before the server has assigned a real id). Buffer in
    // `newSessionState` and replay when the session_created event
    // arrives.
    return {
      nextState: {
        ...state,
        newSessionState: mutate(state.newSessionState),
      },
      fieldUpdated: true,
    };
  }

  const slot = state.sessionStates.get(targetId) ?? emptySessionState();
  const newMap = new Map(state.sessionStates);
  newMap.set(targetId, mutate(slot));
  return {
    nextState: { ...state, sessionStates: newMap },
    fieldUpdated: true,
  };
}

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
        !action.allowEmptyWhileStreaming &&
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
    case 'SET_VISION_STATE': {
      // The vision state is chat-scoped, not session-scoped: the
      // active model determines whether image attachments will be
      // stripped, and that does not change when the user switches
      // sessions. The SSE `vision_unsupported` event (sent from the
      // server when a 400 indicates the model rejected an image) and
      // the optimistic default at app start both flow through here.
      return { ...state, visionState: action.state };
    }
    case 'ADD_MESSAGE': {
      // If the action targets a session other than the current one, append
      // the message to that session's slot. The current-session branch
      // preserves the original user-input side effects (inputDraft /
      // historyIndex reset).
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          messages: [...slot.messages, withId(action.message)],
        }));
        return nextState;
      }
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
      // Non-current target: append to that session's slot without
      // touching the top-level state.
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => {
          const msgs = [...slot.messages];
          const last = msgs.at(-1);
          if (!last || last.role !== 'assistant') {
            msgs.push(
              withId({
                role: 'assistant',
                content: action.content ?? '',
                ...(action.thinking === undefined ? {} : { thinking: action.thinking }),
              })
            );
            return { ...slot, messages: msgs };
          }
          msgs[msgs.length - 1] = {
            ...last,
            ...(action.content === undefined ? {} : { content: last.content + action.content }),
            ...(action.thinking === undefined
              ? {}
              : { thinking: (last.thinking || '') + action.thinking }),
          };
          return { ...slot, messages: msgs };
        });
        return nextState;
      }
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
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => {
          const msgs = [...slot.messages];
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
              content: candidate.content
                ? `${candidate.content}\n${action.content}`
                : action.content,
            };
            return { ...slot, messages: msgs };
          }
          return {
            ...slot,
            messages: [
              ...slot.messages,
              withId({
                role: 'tool',
                content: action.content,
                ...(action.name ? { name: action.name } : {}),
              }),
            ],
          };
        });
        return nextState;
      }
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
      // When the event targets a different session, route the bubble
      // to that session's slot.  The agentId keying is unchanged — two
      // sessions with the same agentId will both have a bubble each,
      // and a session's own sub-agent_id is unique within that run.
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => {
          const msgs = [...slot.messages];
          for (let i = msgs.length - 1; i >= 0; i -= 1) {
            const candidate = msgs[i];
            if (!candidate || candidate.role !== 'subagent_log') {
              continue;
            }
            if (candidate.subagentId !== action.agentId) {
              continue;
            }
            msgs[i] = { ...candidate, content: candidate.content + action.text };
            return { ...slot, messages: msgs };
          }
          return {
            ...slot,
            messages: [
              ...slot.messages,
              withId({ role: 'subagent_log', content: action.text, subagentId: action.agentId }),
            ],
          };
        });
        return nextState;
      }
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
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => {
          const msgs = [...slot.messages];
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
              content: candidate.content
                ? `${candidate.content}\n${action.message}`
                : action.message,
            };
            return { ...slot, messages: msgs };
          }
          return {
            ...slot,
            messages: [
              ...slot.messages,
              withId({
                role: 'subagent_log',
                content: action.message,
                subagentId: action.agentId,
              }),
            ],
          };
        });
        return nextState;
      }
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
      nextState = pendingApproval
        ? {
            ...nextState,
            pendingCommand: pendingApproval.command,
            showApproval: pendingApproval.command !== null,
            pendingApprovalId: pendingApproval.requestId,
          }
        : {
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
    case 'SET_MODELS_LOADING': {
      return { ...state, modelsLoading: action.modelsLoading };
    }
    case 'SET_PROVIDERS': {
      return { ...state, providers: action.providers };
    }
    case 'SET_ACTIVE_PROVIDER': {
      return { ...state, activeProviderId: action.providerId };
    }
    case 'SET_MODEL': {
      return { ...state, model: action.model };
    }
    case 'SET_ERROR': {
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          error: action.error,
        }));
        return nextState;
      }
      return { ...state, error: action.error };
    }
    case 'SET_CONFIG': {
      // The clamp is the server's responsibility. SET_CONFIG only
      // stores the user's requested value; the effective value is
      // updated by SET_TOKEN_STATS when the server reports back.
      return { ...state, ...action.config };
    }
    case 'SHOW_APPROVAL': {
      // ── Determine the session this approval request belongs to ──────
      // The SHOW_APPROVAL action has no `targetSessionId` field, but
      // the chat route only ever shows the modal for the request the
      // user is approving (and the registry keys approvals by a UUID
      // that the route captures). For the hide-modal case
      // (command === null) we resolve the target by `requestId`: the
      // session whose `pendingApproval.requestId` matches is the
      // owning session. Falls back to `currentSessionId` for callers
      // that omit `requestId` (e.g. local test code).
      const owningSessionId = (() => {
        if (action.command === null && action.requestId !== undefined) {
          for (const [id, sess] of state.sessionStates) {
            if (sess.pendingApproval?.requestId === action.requestId) return id;
          }
          if (state.newSessionState.pendingApproval?.requestId === action.requestId) {
            return -1;
          }
        }
        return state.currentSessionId;
      })();

      let nextState: ChatState = {
        ...state,
        pendingCommand: action.command,
        showApproval: action.command !== null,
        pendingApprovalId: action.requestId ?? null,
      };

      // When hiding the modal, only clear the owning session's
      // `pendingApproval` slot — NOT every session in the map. The
      // pre-fix code did a `for ... newMap` over every session and
      // wiped unrelated pending approvals, so a user who had a
      // background stream waiting on its own approval would see that
      // approval silently disappear the moment they approved or
      // rejected the foreground request.
      if (action.command === null) {
        if (owningSessionId === null) {
          // No owning session (no current session, no requestId match).
          // Old behaviour: clear both. This is the rare case where the
          // server's `command: null` dispatch lands with no other
          // context, so the safe option is to clear the
          // not-yet-claimed session slot.
          return {
            ...nextState,
            newSessionState: { ...nextState.newSessionState, pendingApproval: null },
          };
        }
        if (owningSessionId === -1) {
          return {
            ...nextState,
            newSessionState: { ...nextState.newSessionState, pendingApproval: null },
          };
        }
        const newMap = new Map(nextState.sessionStates);
        const sess = newMap.get(owningSessionId);
        if (sess && sess.pendingApproval !== null) {
          newMap.set(owningSessionId, { ...sess, pendingApproval: null });
        }
        return { ...nextState, sessionStates: newMap };
      }

      // Also persist into the owning session's state so it survives switching.
      // Prefer the resolved owning session id (which may be a background
      // session whose approval we just showed the user) over the current
      // session id — this is what fixes the "second stream's modal
      // stomps the first stream's modal" bug for the modal-display case.
      if (owningSessionId !== null && owningSessionId !== -1) {
        let session = nextState.sessionStates.get(owningSessionId);
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
          newMap.set(owningSessionId, session);
          nextState = { ...nextState, sessionStates: newMap };
        }
        const newMap = new Map(nextState.sessionStates);
        newMap.set(owningSessionId, {
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

      // No owning session id resolved (e.g. very early in a new-session
      // creation, before any real session id is known). Fall back to
      // the not-yet-claimed slot.
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
    case 'CLEAR_MESSAGES': {
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          messages: [],
        }));
        return nextState;
      }
      return { ...state, messages: [] };
    }
    case 'REMOVE_LAST_ASSISTANT': {
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => {
          const msgs = slot.messages;
          if (msgs.length > 0) {
            const last = msgs.at(-1);
            if (last && last.role === 'assistant') {
              return { ...slot, messages: msgs.slice(0, -1) };
            }
          }
          return slot;
        });
        return nextState;
      }
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
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => {
          // Merge with existing stats so durable fields like evalTps /
          // promptTps (sent once on the `done` event) survive transient
          // `status` updates that only carry tokensUsed / tokenLimit.
          const base = slot.tokenStats ?? {
            promptEvalCount: 0,
            evalCount: 0,
            totalTokens: 0,
            tokenLimit: 0,
          };
          return { ...slot, tokenStats: { ...base, ...action.stats } };
        });
        return nextState;
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
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          lastDoneReason: action.reason,
        }));
        return nextState;
      }
      return { ...state, lastDoneReason: action.reason };
    }
    case 'SET_CURRENT_TPS': {
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          currentTps: action.tps,
        }));
        return nextState;
      }
      return { ...state, currentTps: action.tps };
    }
    case 'CLEAR_TOKEN_STATS': {
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          tokenStats: null,
        }));
        return nextState;
      }
      return { ...state, tokenStats: null };
    }
    case 'COMPACT_PROGRESS': {
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          compactingPhases: [...slot.compactingPhases, action.message],
        }));
        return nextState;
      }
      return { ...state, compactingPhases: [...state.compactingPhases, action.message] };
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
        // A switch that never got applied dies with the turn — the newly
        // picked model is already what the next turn will send.
        ...(nextSet.size === 0 ? { modelSwitchPending: false } : {}),
        ...(isVisibleSession ? { compactingPhases: [] } : {}),
      };
    }
    case 'CLEAR_COMPACT_PROGRESS': {
      if (
        action.targetSessionId !== undefined &&
        action.targetSessionId !== state.currentSessionId
      ) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          compactingPhases: [],
        }));
        return nextState;
      }
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
  modelsLoading: true,
  providers: [],
  activeProviderId: null,
  baseUrl: DEFAULT_OLLAMA_BASE_URL,
  provider: DEFAULT_PROVIDER,
  requestedNumCtx: DEFAULT_NUM_CTX,
  effectiveNumCtx: null,
  error: null,
  pendingCommand: null,
  showApproval: false,
  pendingApprovalId: null,
  yolo: false,
  thinkingEnabled: true,
  reasoningEffort: 'off',
  compactionReasoningEffort: 'off',
  promptTimestamps: true,
  citeSources: true,
  compactionModel: '',
  compactionProviderId: null,
  chatTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
  webSearch: { ...DEFAULT_WEB_SEARCH_SETTINGS },
  completionMode: 'normal',
  maxPromptLoopIterations: DEFAULT_MAX_PROMPT_LOOP_ITERATIONS,
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
  // Initial value is 'unknown' so the ChatInput renders the
  // "unconfirmed" hint for openai-compatible providers before the
  // first chat turn reports the resolved state. See the field's
  // JSDoc above for the full state machine.
  visionState: 'unknown',
  modelSwitchPending: false,
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
