'use client';

import React, {
  createContext,
  type ReactNode,
  useContext,
  useReducer,
  useRef,
  useState,
} from 'react';

import type { ToolCall } from '@/services/llm';
import type { VisionSupportState } from '@/services/visionCache';
import type { ToolCallArguments } from '@/tools/tools';
import type { CompletionMode, ProviderConfig, ReasoningEffort } from '@/types/chatConfig';

import { positiveInteger } from '@/app/lib/contextWindow';
import { randomId } from '@/app/lib/randomId';
import { NEW_SESSION_KEY } from '@/app/lib/streamKey';
import { createBatchedDispatcher } from '@/app/lib/updateBatcher';
import { BACKGROUND_UPDATE_INTERVAL_MS, DEFAULT_OLLAMA_CHAT_TIMEOUT_MS } from '@/constants';
import {
  DEFAULT_MAX_PROMPT_LOOP_ITERATIONS,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_PROVIDER,
  DEFAULT_WEB_SEARCH_SETTINGS,
} from '@/services/configDefaults';
import {
  selectionFromColumns,
  selectionToColumns,
  type SessionDefaults,
  type SessionSelection,
} from '@/services/sessionSelection';

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
  /** The conversation's main model. */
  model: string;
  /** The provider that serves `model`, or `null` when it is not pinned. */
  provider_id: string | null;
  /** The conversation's compaction model, or `null` to inherit the global default. */
  compaction_model: string | null;
  /** The provider that serves `compaction_model`, or `null` when it is not pinned. */
  compaction_provider_id: string | null;
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

/**
 * A steering message that has been accepted by `/api/chat/steer` but not yet
 * confirmed applied by a `steer_applied` status event.
 */
export interface PendingSteerDraft {
  id: string;
  text: string;
  target: 'main' | 'subagent';
  agentId?: string;
  /**
   * How many user messages in the transcript already carried exactly this
   * text when the steer was sent. At the end of the turn the saved history is
   * compared against it: one more copy than this means the server saved the
   * steer itself (it does, when the turn ends before a tool step could pick
   * it up), so the text must NOT be put back in the composer.
   */
  copiesAtSend: number;
}

export interface SessionState {
  messages: ChatMessage[];
  error: string | null;
  tokenStats: {
    promptEvalCount: number;
    evalCount: number;
    totalTokens: number;
    tokenLimit: number;
    promptTps?: number | null;
    evalTps?: number | null;
    evalTpsEstimated?: boolean;
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
  /**
   * The sub-agent this session's `run_subagents` batch is running, or null.
   * Per session, because two conversations can each be running a batch —
   * and one conversation's sub-agent must never appear as the steer target
   * of another. Mirrored into `ChatState.activeSubagentId` for the session
   * on screen.
   */
  activeSubagentId: string | null;
}

export interface ChatState {
  messages: ChatMessage[];
  sessions: Session[];
  currentSessionId: number | null;
  /**
   * The main model of the conversation on screen. It is a projection of that
   * conversation's own selection (`sessions.model`), NOT a global setting:
   * switching conversations changes it, and a conversation keeps its model
   * when the user comes back to it.
   */
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
  /**
   * The provider that serves {@link model} — the conversation on screen's own
   * provider, or `null` when it has not pinned one. The provider is part of
   * the selection: a model name alone does not say which endpoint serves it.
   */
  activeProviderId: string | null;
  /**
   * The model a NEW conversation starts with, and the one the new-chat view
   * runs on. This one IS a global setting (it lives in `config.json`), and it
   * is what picking a model updates: the user expects the next "New chat" to
   * start on the model they just chose.
   */
  defaultModel: string;
  /** The provider that serves {@link defaultModel}, or `null` when it has none. */
  defaultProviderId: string | null;
  /**
   * The compaction model a NEW conversation starts with, and the one a
   * conversation that has not pinned a compaction model of its own inherits.
   * `''` means "the conversation's own main model".
   */
  defaultCompactionModel: string;
  baseUrl: string;
  /**
   * The GLOBAL context-window setting as saved in config.json: what the
   * user types in Settings. It is shown in the Settings field and is what
   * `/ctx` writes. It is NOT the window in use and is never sent with a
   * request: the server resolves the window itself (this setting, or the
   * active provider's own, capped by the model's maximum) and reports it
   * back; that value is {@link effectiveNumCtx} below.
   *
   * `null` until `loadConfig` has delivered the persisted setting — there
   * is deliberately NO stand-in default. A stand-in leaked into the status
   * bar ("276922/131072 tokens (211%)") and into Settings, which saved it
   * into config.json (see `src/app/lib/contextWindow.ts`).
   */
  requestedNumCtx: number | null;
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
   * The context window the SERVER resolved for the selected model: the
   * setting capped by the model's maximum when that is known. It arrives
   * from `GET /api/numctx` (`useDataLoaders.loadNumCtx`) and from every
   * chat turn's `status` event. The page never computes it.
   *
   * `null` until the server has answered for the current selection, and
   * again after the model or provider changes (`staleModelCapReset`).
   * Consumers show "—" for `null`; the status bar does not substitute the
   * user's setting, which can differ (a provider has its own window).
   */
  effectiveNumCtx: number | null;
  /**
   * The selected model's maximum context window as the server last reported
   * it: `null` when the server reported none (it does not know) or has not
   * answered yet — {@link effectiveNumCtx} tells those two apart (`null` there
   * means "not answered"). It lives here, not only in `tokenStats`, because
   * `tokenStats` is per conversation and is cleared or swapped when the user
   * switches conversation, while the maximum belongs to the selected MODEL.
   * Like `effectiveNumCtx` it is cleared only when the model or provider
   * changes (`staleModelCapReset`), and set only by a server answer that
   * carries the field (an event without it leaves it alone).
   */
  modelMaxNumCtx: number | null;
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
  /** `Config.citeSources` for the persisted counterpart. */
  citeSources: boolean;
  /** `Config.redactSecrets` for the persisted counterpart. */
  redactSecrets: boolean;
  /**
   * The conversation on screen's own compaction model. `null` means the
   * conversation inherits the global default ({@link defaultCompactionModel});
   * `''` means it compacts with its own main model. The request body OMITS
   * the field when it is `null`, which is how the server is told to fall
   * back to the global setting.
   */
  compactionModel: string | null;
  /**
   * Which provider the conversation on screen's compaction model belongs to,
   * so a compaction model on a different provider than the main one can be
   * used for compaction. `null` for "the main model's provider".
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
   * The sessions with a mid-turn model switch that has been requested via
   * `/api/chat/switch-model` and not yet confirmed by the server's
   * `model_switched` status event. `model` / `compactionModel` already hold
   * the newly picked values (they govern the next turn regardless), so this
   * exists purely so the UI can say the running turn has not taken the new
   * model on board yet, instead of implying the swap was instant. It is kept
   * per session: a switch requested in one conversation must not show as
   * pending in another.
   */
  modelSwitchPendingSessions: Set<number>;
  /**
   * The agent id of the sub-agent the VISIBLE session's `run_subagents`
   * batch is currently running, or null when no batch is in flight (or it's
   * between agents). Sub-agents execute sequentially, so at most one id is
   * ever active per session. Derived purely from SSE events the client
   * already receives (`subagent_output`/`subagent_chunk` set it, the
   * matching `tool_result` for `run_subagents` clears it) through
   * `SET_ACTIVE_SUBAGENT`, which routes per session like every other
   * per-session field — so a batch in a background conversation never shows
   * up as the steer target here. Drives the steer-input's main/sub-agent
   * target toggle.
   */
  activeSubagentId: string | null;
  /**
   * Steering messages that have been sent to `/api/chat/steer` and accepted
   * (the server returned an id) but not yet confirmed applied by a matching
   * `steer_applied` status event, by session. Held here — rather than
   * clearing the composer immediately — so the text can be restored to the
   * input if the turn ends, aborts, or errors before the ack arrives (see the
   * `STOP_STREAMING` case below). Per session: one conversation's pending
   * steer must not lock another conversation's steer box.
   */
  steerDrafts: Map<number, PendingSteerDraft>;
  /**
   * Text of a steering message that never got an acknowledgement AND is not
   * in the saved history, kept for the user to see again, by the session it
   * came from. `ChatInput` puts a session's entry in that session's composer
   * and clears it — never in another conversation's. Separate from
   * `inputDraft`, which has its own lifecycle for history navigation.
   */
  steerRestoreTexts: Map<number, string>;
  tokenStats: {
    promptEvalCount: number;
    evalCount: number;
    totalTokens: number;
    tokenLimit: number;
    promptTps?: number | null;
    evalTps?: number | null;
    evalTpsEstimated?: boolean;
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
  | {
      type: 'CLEAR_SUBAGENT_CONTENT';
      agentId: string;
      /**
       * The text that must REMAIN for that agent — what the server kept
       * after dropping the failed turn's output. The bubble is REPLACED
       * with it (not emptied), so the agent's earlier turns survive and the
       * live bubble matches the text the server persists.
       */
      content: string;
      targetSessionId?: number;
    }
  | { type: 'SET_SESSIONS'; sessions: Session[] }
  | { type: 'ADD_SESSION'; session: Session }
  | {
      type: 'RENAME_SESSION';
      sessionId: number;
      /**
       * The title the server just committed, pushed over
       * `/api/sessions/events`. Patched in place rather than re-fetching the
       * list: the rename can land long after the turn finished, and a whole
       * list refresh would also have to win a race against any list fetch
       * already in flight.
       */
      name: string;
    }
  | {
      type: 'SET_CURRENT_SESSION';
      id: number | null;
      /**
       * The server has just saved the new chat on screen under `id`, so the
       * new-chat view's transcript becomes that session's. Only the
       * `session_created` frame sets it: without the flag, ANY switch from
       * the new-chat view to a session not opened yet carried the new
       * chat's transcript, error and approval into that session.
       */
      adoptNewChat?: boolean;
    }
  | { type: 'SET_MODELS'; models: LLmModel[] }
  | { type: 'SET_MODELS_LOADING'; modelsLoading: boolean }
  | { type: 'SET_PROVIDERS'; providers: ProviderConfig[] }
  | {
      type: 'SET_ACTIVE_PROVIDER';
      providerId: string | null;
    }
  | {
      type: 'SET_SESSION_SELECTION';
      /**
       * The model selection the user picked for the conversation on screen.
       * It pins that conversation AND updates the global defaults, because
       * picking a model is also what a new conversation starts with.
       *
       * The defaults are stated rather than derived: a pick of the MAIN
       * model changes the main defaults and leaves the compaction default
       * alone, and a pick of the COMPACTION model changes the compaction
       * default and leaves the main ones alone. The two pickers are separate
       * controls, so each says which it is.
       */
      selection: SessionSelection;
      defaults: SessionDefaults;
    }
  | {
      type: 'APPLY_SESSION_SELECTION';
      /**
       * A conversation's selection as the server knows it — the row of a
       * conversation that was just loaded, or a change another tab made. The
       * row is patched; the mirror follows only when that conversation is
       * the one on screen, so another tab's change never moves the model
       * under the user.
       */
      sessionId: number;
      selection: SessionSelection;
    }
  | {
      type: 'SET_DEFAULT_SELECTION';
      /**
       * The model a new conversation starts with. The new-chat view runs on
       * it; a conversation on screen keeps its own selection.
       */
      model: string;
      providerId: string | null;
      /** The compaction model a new conversation starts with. */
      compactionModel?: string | undefined;
    }
  | { type: 'SET_ERROR'; error: string | null; targetSessionId?: number }
  | {
      type: 'SET_CONFIG';
      /**
       * The global settings. The model selection is deliberately NOT among
       * them: a conversation's model belongs to the conversation
       * (`SET_SESSION_SELECTION`), and the model a new conversation starts
       * with belongs to the defaults (`SET_DEFAULT_SELECTION`).
       */
      config: Omit<
        Partial<ChatState>,
        'model' | 'activeProviderId' | 'compactionModel' | 'compactionProviderId'
      >;
    }
  | { type: 'SET_ACTIVE_SUBAGENT'; agentId: string | null; targetSessionId?: number }
  | { type: 'SET_STEER_DRAFT'; sessionId: number; draft: PendingSteerDraft | null }
  | { type: 'CLEAR_STEER_RESTORE'; sessionId: number }
  | { type: 'SET_MODEL_SWITCH_PENDING'; sessionId: number; pending: boolean }
  | {
      type: 'SHOW_APPROVAL';
      command: { name: string; args: ToolCallArguments; toolCallName?: string } | null;
      requestId?: string;
      targetSessionId?: number;
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
  | { type: 'RENAME_STREAMING'; fromSessionId: number; toSessionId: number }
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
    activeSubagentId: null,
  };
}

/**
 * Whether an action aimed at `targetId` belongs to a session the user is NOT
 * looking at, so it must land in that session's slot instead of the
 * top-level fields the UI renders.
 *
 * The placeholder key (-1, a brand-new chat the server has not saved yet) is
 * the visible session while the new-chat view is on screen. Treating it as a
 * background session there sent everything a new chat received before its
 * `session_created` frame — an early error, for one — into the hidden
 * `newSessionState` mirror, where the user never saw it.
 *
 * `undefined` is the legacy "whatever is on screen" path.
 */
function targetsBackgroundSession(state: ChatState, targetId: number | undefined): boolean {
  if (targetId === undefined || targetId === state.currentSessionId) {
    return false;
  }
  return !(targetId === NEW_SESSION_KEY && state.currentSessionId === null);
}

/**
 * Whether the client's own copy of a session is the live, authoritative one.
 *
 * Every event of a streaming turn is applied to its session as it arrives —
 * to the top-level fields while the session is on screen, to its slot while
 * it is not — so a streaming session the client has been tracking already
 * holds exactly what the user would see had they never left. Reloading it
 * from the database would be WORSE than that copy: the database only has
 * the steps the server has flushed so far, never the reply being typed or
 * the tool call that is still running, and anything that streams in while
 * the reload is in flight would be overwritten by it.
 *
 * Once the turn ends its session is reloaded from the database anyway
 * (`finishTurn`), which is what reconciles the client's ids with the
 * persisted rows.
 */
export function hasLiveTranscript(state: ChatState, sessionId: number): boolean {
  if (!state.streamingSessions.has(sessionId)) {
    return false;
  }
  return state.currentSessionId === sessionId || state.sessionStates.has(sessionId);
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

/**
 * Hold an approval request in a background session's slot, leaving the
 * modal on screen alone.
 */
function holdApprovalInSlot(
  state: ChatState,
  sessionId: number,
  command: { name: string; args: ToolCallArguments; toolCallName?: string },
  requestId: string | undefined
): ChatState {
  const { nextState } = applyToSession(state, sessionId, (slot) => ({
    ...slot,
    pendingApproval: { command, requestId: requestId ?? null },
  }));
  return nextState;
}

/** The transcript the client holds for a session, wherever it lives. */
function messagesOfSession(state: ChatState, sessionId: number): ChatMessage[] {
  return sessionId === state.currentSessionId
    ? state.messages
    : (state.sessionStates.get(sessionId)?.messages ?? []);
}

function countUserCopies(messages: ChatMessage[], text: string): number {
  return messages.filter((m) => m.role === 'user' && m.content === text).length;
}

/** A copy of `set` without `value` — the same set when it never had it. */
function withoutValue(set: Set<number>, value: number): Set<number> {
  if (!set.has(value)) {
    return set;
  }
  const next = new Set(set);
  next.delete(value);
  return next;
}

/**
 * Settle a session's steering draft when its turn ends.
 *
 * A draft that was never acknowledged is put back for the user — unless the
 * saved history already holds it. The server saves a steer itself when the
 * turn ends before a tool step could pick it up (and when the acknowledgement
 * raced the draft), and putting the same text back in the composer made the
 * user send it twice. The turn's end reloads the transcript from the
 * database before this runs, so the history compared here is the saved one.
 */
function settleSteerDraft(
  state: ChatState,
  sessionId: number
): Partial<Pick<ChatState, 'steerDrafts' | 'steerRestoreTexts'>> {
  const draft = state.steerDrafts.get(sessionId);
  if (!draft) {
    return {};
  }
  const steerDrafts = new Map(state.steerDrafts);
  steerDrafts.delete(sessionId);
  const alreadySaved =
    countUserCopies(messagesOfSession(state, sessionId), draft.text) > draft.copiesAtSend;
  if (alreadySaved) {
    return { steerDrafts };
  }
  const steerRestoreTexts = new Map(state.steerRestoreTexts);
  steerRestoreTexts.set(sessionId, draft.text);
  return { steerDrafts, steerRestoreTexts };
}

/**
 * What the server told the client about the PREVIOUS model's window, dropped
 * when the selected model or provider really changes.
 *
 * The model maximum (`tokenStats.modelContextLimit`) and the server's resolved
 * window (`effectiveNumCtx`) describe the model that was selected when the
 * server reported them. Left in place after a switch they would show the old
 * model's window under the new model's name (a 131k model replaced by a 1M one
 * would still read 131k). Cleared, the display shows "—", which is honest; the
 * page then asks the server again (`useNumCtxSync`) and shows its answer.
 *
 * Only a real change clears: the reducers below compare with the current
 * selection, so re-dispatching the same model is a no-op for these fields.
 */
function staleModelCapReset(
  state: ChatState
): Pick<ChatState, 'effectiveNumCtx' | 'modelMaxNumCtx'> & Partial<Pick<ChatState, 'tokenStats'>> {
  return {
    effectiveNumCtx: null,
    modelMaxNumCtx: null,
    ...(state.tokenStats === null
      ? {}
      : { tokenStats: { ...state.tokenStats, modelContextLimit: null } }),
  };
}

/**
 * The mirror of a conversation's selection: what the status bar shows and
 * what the next turn sends.
 */
function selectionMirror(
  selection: SessionSelection
): Pick<ChatState, 'model' | 'activeProviderId' | 'compactionModel' | 'compactionProviderId'> {
  return {
    model: selection.model,
    activeProviderId: selection.providerId,
    compactionModel: selection.compactionModel,
    compactionProviderId: selection.compactionProviderId,
  };
}

/**
 * Write a conversation's selection into the row that carries it.
 *
 * The row in `state.sessions` is the conversation's own record, so a change
 * to a conversation's model has to land there: that row is what the sidebar
 * list holds, what switching to that conversation restores, and what the
 * next turn's selection is read from.
 */
function patchSessionSelection(
  sessions: Session[],
  sessionId: number | null,
  selection: SessionSelection
): Session[] {
  if (sessionId === null) return sessions;
  const index = sessions.findIndex((s) => s.id === sessionId);
  if (index === -1) return sessions;
  const current = sessions[index];
  if (!current) return sessions;
  const columns = selectionToColumns(selection);
  if (
    current.model === columns.model &&
    current.provider_id === columns.provider_id &&
    current.compaction_model === columns.compaction_model &&
    current.compaction_provider_id === columns.compaction_provider_id
  ) {
    return sessions;
  }
  const next = [...sessions];
  next[index] = { ...current, ...columns };
  return next;
}

/**
 * The selection the conversation on screen runs on, as it stands in the
 * store.
 */
function mirrorSelection(state: ChatState): SessionSelection {
  return {
    model: state.model,
    providerId: state.activeProviderId,
    compactionModel: state.compactionModel,
    compactionProviderId: state.compactionProviderId,
  };
}

/**
 * The selection a conversation runs on.
 *
 * A conversation that is not in the list yet — the list has not loaded, or
 * the conversation was opened before it did — falls back to the global
 * default, so the UI is never left without a model. The row that arrives
 * (or the conversation's own detail fetch) replaces it.
 */
function selectionForSession(state: ChatState, sessionId: number | null): SessionSelection {
  if (sessionId !== null) {
    const row = state.sessions.find((s) => s.id === sessionId);
    if (row) {
      return selectionFromColumns({
        model: row.model,
        provider_id: row.provider_id,
        compaction_model: row.compaction_model,
        compaction_provider_id: row.compaction_provider_id,
      });
    }
  }
  return {
    model: state.defaultModel,
    providerId: state.defaultProviderId,
    compactionModel: null,
    compactionProviderId: null,
  };
}

/**
 * Put a conversation's selection on screen.
 *
 * The cached context-window answers describe the model that was selected
 * when the server reported them, so they are dropped whenever the selection
 * really changes — a conversation on another model must not keep showing the
 * previous one's window.
 */
function applySelection(state: ChatState, selection: SessionSelection): ChatState {
  const mirror = selectionMirror(selection);
  const changed =
    state.model !== mirror.model || state.activeProviderId !== mirror.activeProviderId;
  return {
    ...state,
    ...mirror,
    ...(changed ? staleModelCapReset(state) : {}),
  };
}

/**
 * The one reducer for the chat store. Exported so the per-session
 * routing rules (which session a targeted action lands in) can be tested
 * directly, without a browser.
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SET_MESSAGES': {
      const messages = action.messages.filter((m: ChatMessage) => m.role !== 'system').map(withId);
      if (
        !action.allowEmptyWhileStreaming &&
        messages.length === 0 &&
        action.targetSessionId !== undefined &&
        state.streamingSessions.has(action.targetSessionId)
      ) {
        return state;
      }
      if (targetsBackgroundSession(state, action.targetSessionId)) {
        if (action.targetSessionId === NEW_SESSION_KEY) {
          // The placeholder transcript is the visible one only while no
          // session is selected (that case never reaches this branch).
          // `newSessionState` is a mirror that the next session switch
          // overwrites, so writing a database copy into it would leak this
          // copy into whatever chat is started later.
          return state;
        }
        // The session this belongs to is not the one on screen: write the
        // copy into that session's slot instead of dropping it. The visible
        // session is left untouched, which is what the old guard protected
        // against — but the copy itself was lost, so a turn that finished in
        // the background never reconciled its transcript.
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          messages,
        }));
        return nextState;
      }
      return {
        ...state,
        messages,
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
      if (targetsBackgroundSession(state, action.targetSessionId)) {
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
      if (targetsBackgroundSession(state, action.targetSessionId)) {
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
      if (targetsBackgroundSession(state, action.targetSessionId)) {
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
      if (targetsBackgroundSession(state, action.targetSessionId)) {
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
    case 'CLEAR_SUBAGENT_CONTENT': {
      // A sub-agent's turn failed with a transient provider error and is
      // re-issued, so the text the failed attempt streamed is dropped —
      // while the text of the agent's EARLIER turns stays.
      //
      // The server already worked out what remains and sends it in the
      // event, so the bubble is REPLACED with that text (not emptied): the
      // bubble is not removed either, because the re-issued turn keeps
      // streaming into the same bubble.
      //
      // The lookup mirrors SUBAGENT_CHUNK — the LAST bubble belonging to
      // this agent, in the session the action targets.
      if (targetsBackgroundSession(state, action.targetSessionId)) {
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
            msgs[i] = { ...candidate, content: action.content };
            return { ...slot, messages: msgs };
          }
          // No bubble for this agent in that session — but the server says
          // there IS text that has to remain, so it is created rather than
          // dropped (mirrors SUBAGENT_CHUNK's create-if-missing branch).
          if (!action.content) {
            return slot;
          }
          return {
            ...slot,
            messages: [
              ...slot.messages,
              withId({ role: 'subagent_log', content: action.content, subagentId: action.agentId }),
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
        msgs[i] = { ...candidate, content: action.content };
        return { ...state, messages: msgs };
      }
      // No bubble for this agent — but the server says there IS text that
      // has to remain, so it is created rather than dropped (mirrors
      // SUBAGENT_CHUNK's create-if-missing branch).
      if (!action.content) {
        return state;
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          withId({ role: 'subagent_log', content: action.content, subagentId: action.agentId }),
        ],
      };
    }
    case 'SUBAGENT_OUTPUT': {
      if (targetsBackgroundSession(state, action.targetSessionId)) {
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
      // The list is the server's snapshot, but the conversation on screen
      // keeps the selection it has: a model the user has just picked may
      // not be in the list yet, because the write that carries it is still
      // in flight, and a list that is a moment older must not roll the pick
      // back. The push from the server (the session event) is what changes
      // it.
      const active = state.currentSessionId;
      const sessions =
        active === null
          ? action.sessions
          : action.sessions.map((row) =>
              row.id === active ? { ...row, ...selectionToColumns(mirrorSelection(state)) } : row
            );
      return { ...state, sessions };
    }
    case 'ADD_SESSION': {
      // Prepend the new session so it appears at the top of the sidebar
      const exists = state.sessions.some((s) => s.id === action.session.id);
      if (exists) return state;
      return { ...state, sessions: [action.session, ...state.sessions] };
    }
    case 'RENAME_SESSION': {
      // The server pushed a new title for one conversation. Ignore it if the
      // session isn't in the list yet (it will arrive with the next full
      // load) or if the title is already current — returning the same state
      // keeps `document.title` and the sidebar from re-rendering for nothing.
      const index = state.sessions.findIndex((s) => s.id === action.sessionId);
      const current = state.sessions[index];
      if (!current) return state;
      if (current.name === action.name) return state;
      const sessions = [...state.sessions];
      sessions[index] = { ...current, name: action.name };
      return { ...state, sessions };
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
        activeSubagentId: state.activeSubagentId,
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
      let restored: SessionState;
      if (action.id === null) {
        restored = nextState.newSessionState;
      } else {
        let session = nextState.sessionStates.get(action.id);
        // If we were on the new-session view and the server just assigned a
        // real ID, promote the newSessionState into sessionStates so the
        // locally-added first message (and any streaming chunks) survive.
        if (!session && action.adoptNewChat === true && state.currentSessionId === null) {
          const newMap = new Map(nextState.sessionStates);
          const promoted = nextState.newSessionState;
          newMap.set(action.id, promoted);
          nextState = {
            ...nextState,
            sessionStates: newMap,
            newSessionState: emptySessionState(),
          };
          session = promoted;
        }
        // Session not yet initialised — start fresh (don't auto-create slot).
        // Every field is reset, so nothing of the session being left (a stale
        // completion reason, a sub-agent toggle) leaks into this one.
        restored = session ?? emptySessionState();
      }

      nextState = {
        ...nextState,
        messages: restored.messages,
        error: restored.error,
        tokenStats: restored.tokenStats,
        currentTps: restored.currentTps,
        compactingPhases: restored.compactingPhases,
        lastDoneReason: restored.lastDoneReason,
        activeSubagentId: restored.activeSubagentId ?? null,
      };

      // Restore the session's OWN pending approval. It used to fall back to
      // the new-chat mirror's approval whenever the target had none, which
      // could pop one conversation's approval up inside another.
      const pendingApproval = restored.pendingApproval;
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

      // The conversation on screen runs on ITS OWN model selection. This is
      // the point of the whole feature: switching conversations switches the
      // model with them, and the model of the conversation left behind is
      // still there when the user comes back to it.
      return applySelection(
        { ...nextState, inputDraft: '', historyIndex: null },
        selectionForSession(nextState, action.id)
      );
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
      // The provider of the conversation on screen. The reconciler uses this
      // to repair a provider that does not serve the selected model; it does
      // not re-pin the conversation, whose own record keeps the provider the
      // user chose.
      return {
        ...state,
        activeProviderId: action.providerId,
        ...(action.providerId === state.activeProviderId ? {} : staleModelCapReset(state)),
      };
    }
    case 'SET_SESSION_SELECTION': {
      const { selection, defaults } = action;
      const sessions = patchSessionSelection(state.sessions, state.currentSessionId, selection);
      // Picking a model is also what a new conversation starts with: the
      // user expects the next "New chat" to start on the model they just
      // chose. The defaults say WHICH part of the selection the pick
      // changed, so picking the compaction model does not move the default
      // main model.
      const nextState: ChatState = {
        ...state,
        sessions,
        defaultModel: defaults.model,
        defaultProviderId: defaults.providerId,
        defaultCompactionModel: defaults.compactionModel,
      };
      return applySelection(nextState, selection);
    }
    case 'APPLY_SESSION_SELECTION': {
      const sessions = patchSessionSelection(state.sessions, action.sessionId, action.selection);
      const nextState = { ...state, sessions };
      // Another tab's change must not move the model under the user: only
      // the conversation on screen follows its own selection.
      if (action.sessionId !== state.currentSessionId) return nextState;
      return applySelection(nextState, action.selection);
    }
    case 'SET_DEFAULT_SELECTION': {
      const nextState: ChatState = {
        ...state,
        defaultModel: action.model,
        defaultProviderId: action.providerId,
        ...(action.compactionModel === undefined
          ? {}
          : { defaultCompactionModel: action.compactionModel }),
      };
      // A conversation on screen keeps the selection of its own. Only the
      // new-chat view follows the default: a conversation whose row has not
      // loaded yet must not be moved to the default behind the user's back.
      if (state.currentSessionId !== null) return nextState;
      return applySelection(nextState, selectionForSession(nextState, null));
    }
    case 'SET_ERROR': {
      if (targetsBackgroundSession(state, action.targetSessionId)) {
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
      const { defaultModel, defaultProviderId, defaultCompactionModel, ...rest } = action.config;
      const nextState: ChatState = {
        ...state,
        ...rest,
        ...(defaultModel === undefined ? {} : { defaultModel }),
        ...(defaultProviderId === undefined ? {} : { defaultProviderId }),
        ...(defaultCompactionModel === undefined ? {} : { defaultCompactionModel }),
      };
      // A conversation on screen keeps the selection of its own. Only the
      // new-chat view follows the default: a conversation whose row has not
      // loaded yet must not be moved to the default behind the user's back.
      if (state.currentSessionId !== null) return nextState;
      return applySelection(nextState, selectionForSession(nextState, null));
    }
    case 'SET_ACTIVE_SUBAGENT': {
      if (targetsBackgroundSession(state, action.targetSessionId)) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          activeSubagentId: action.agentId,
        }));
        return nextState;
      }
      return { ...state, activeSubagentId: action.agentId };
    }
    case 'SET_STEER_DRAFT': {
      if (action.draft === null && !state.steerDrafts.has(action.sessionId)) {
        return state;
      }
      const steerDrafts = new Map(state.steerDrafts);
      if (action.draft === null) {
        steerDrafts.delete(action.sessionId);
      } else {
        steerDrafts.set(action.sessionId, action.draft);
      }
      return { ...state, steerDrafts };
    }
    case 'CLEAR_STEER_RESTORE': {
      if (!state.steerRestoreTexts.has(action.sessionId)) {
        return state;
      }
      const steerRestoreTexts = new Map(state.steerRestoreTexts);
      steerRestoreTexts.delete(action.sessionId);
      return { ...state, steerRestoreTexts };
    }
    case 'SET_MODEL_SWITCH_PENDING': {
      if (state.modelSwitchPendingSessions.has(action.sessionId) === action.pending) {
        return state;
      }
      const modelSwitchPendingSessions = new Set(state.modelSwitchPendingSessions);
      if (action.pending) {
        modelSwitchPendingSessions.add(action.sessionId);
      } else {
        modelSwitchPendingSessions.delete(action.sessionId);
      }
      return { ...state, modelSwitchPendingSessions };
    }
    case 'SHOW_APPROVAL': {
      // ── A request for a session that is not on screen ────────────────
      // It is held in that session's slot and the modal is left alone:
      // popping it up here would ask the user to approve another
      // conversation's command while they are reading this one. The
      // session switch restores it from the slot when they go back.
      const approvalTarget = action.targetSessionId;
      if (
        action.command !== null &&
        approvalTarget !== undefined &&
        targetsBackgroundSession(state, approvalTarget)
      ) {
        return holdApprovalInSlot(state, approvalTarget, action.command, action.requestId);
      }
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
        // A explicitly targeted session (e.g. a foreground approval request
        // dispatched for a background stream that was tagged on dispatch)
        // wins over inference.
        if (action.targetSessionId !== undefined) return action.targetSessionId;
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
        // A hide must only close the modal if it resolves the request that is
        // currently on screen. Two streams can await approval at once; before
        // this guard, answering A cleared B's freshly-shown modal (and its
        // session slot) instead of just A's.
        const closesVisibleModal =
          action.requestId === undefined ||
          state.pendingApprovalId === null ||
          state.pendingApprovalId === action.requestId;

        const base: ChatState = closesVisibleModal ? nextState : state;

        if (owningSessionId === null || owningSessionId === -1) {
          // No owning session (no current session, no requestId match).
          // Old behaviour: clear both. This is the rare case where the
          // server's `command: null` dispatch lands with no other
          // context, so the safe option is to clear the
          // not-yet-claimed session slot.
          return {
            ...base,
            newSessionState: { ...base.newSessionState, pendingApproval: null },
          };
        }
        const newMap = new Map(base.sessionStates);
        const sess = newMap.get(owningSessionId);
        if (sess && sess.pendingApproval !== null) {
          newMap.set(owningSessionId, { ...sess, pendingApproval: null });
        }
        return { ...base, sessionStates: newMap };
      }

      // Also persist into the owning session's state so it survives switching.
      // Prefer the resolved owning session id (which may be a background
      // session whose approval we just showed the user) over the current
      // session id — this is what fixes the "second stream's modal
      // stomps the first stream's modal" bug for the modal-display case.
      if (owningSessionId !== null && owningSessionId !== -1) {
        const session = nextState.sessionStates.get(owningSessionId) ?? emptySessionState();
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
      if (targetsBackgroundSession(state, action.targetSessionId)) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          messages: [],
        }));
        return nextState;
      }
      return { ...state, messages: [] };
    }
    case 'REMOVE_LAST_ASSISTANT': {
      if (targetsBackgroundSession(state, action.targetSessionId)) {
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
      if (targetsBackgroundSession(state, action.targetSessionId)) {
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
      // The model's maximum, when this update carries it: an explicit `null` is
      // the server saying it knows none, an absent key says nothing.
      const maxFromStats =
        action.stats.modelContextLimit === undefined
          ? undefined
          : positiveInteger(action.stats.modelContextLimit);
      return {
        ...state,
        tokenStats: merged,
        ...(effectiveFromStats === null ? {} : { effectiveNumCtx: effectiveFromStats }),
        ...(maxFromStats === undefined ? {} : { modelMaxNumCtx: maxFromStats }),
      };
    }
    case 'SET_DONE_REASON': {
      if (targetsBackgroundSession(state, action.targetSessionId)) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          lastDoneReason: action.reason,
        }));
        return nextState;
      }
      return { ...state, lastDoneReason: action.reason };
    }
    case 'SET_CURRENT_TPS': {
      if (targetsBackgroundSession(state, action.targetSessionId)) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          currentTps: action.tps,
        }));
        return nextState;
      }
      return { ...state, currentTps: action.tps };
    }
    case 'CLEAR_TOKEN_STATS': {
      if (targetsBackgroundSession(state, action.targetSessionId)) {
        const { nextState } = applyToSession(state, action.targetSessionId, (slot) => ({
          ...slot,
          tokenStats: null,
        }));
        return nextState;
      }
      return { ...state, tokenStats: null };
    }
    case 'COMPACT_PROGRESS': {
      if (targetsBackgroundSession(state, action.targetSessionId)) {
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
      const steerDrafts = new Map(state.steerDrafts);
      steerDrafts.delete(action.sessionId);
      const steerRestoreTexts = new Map(state.steerRestoreTexts);
      steerRestoreTexts.delete(action.sessionId);
      return {
        ...state,
        sessionStates: newMap,
        streamingSessions: newStreaming,
        steerDrafts,
        steerRestoreTexts,
        modelSwitchPendingSessions: withoutValue(
          state.modelSwitchPendingSessions,
          action.sessionId
        ),
      };
    }
    case 'START_STREAMING': {
      return {
        ...state,
        streamingSessions: new Set(state.streamingSessions).add(action.sessionId),
      };
    }
    case 'RENAME_STREAMING': {
      // Move a streaming session from one id to another in one step. The
      // placeholder (-1) becomes the real id when the server creates the
      // session; doing that with a STOP followed by a START leaves the set
      // momentarily empty, and an empty set clears the steer-target toggle,
      // the pending model switch and the held steer draft.
      const nextSet = new Set(state.streamingSessions);
      nextSet.delete(action.fromSessionId);
      nextSet.add(action.toSessionId);
      // The compaction phases of the session being renamed away are cleared,
      // exactly as stopping that session would have cleared them: the
      // "Compacting conversation…" notice must not outlive the turn it
      // belonged to.
      const isVisibleSession = !targetsBackgroundSession(state, action.fromSessionId);
      if (isVisibleSession) {
        return { ...state, streamingSessions: nextSet, compactingPhases: [] };
      }
      // A brand-new chat the user navigated away from before the server saved
      // it: everything it received so far went into the new-chat mirror
      // (`newSessionState`). It now has a real id, so that copy becomes its
      // session's slot — otherwise the turn's opening message and live reply
      // would be stranded in a mirror no session points at, and the next
      // "New chat" would open with them in it.
      if (action.fromSessionId === NEW_SESSION_KEY) {
        const newMap = new Map(state.sessionStates);
        newMap.set(action.toSessionId, { ...state.newSessionState, compactingPhases: [] });
        return {
          ...state,
          streamingSessions: nextSet,
          sessionStates: newMap,
          newSessionState: emptySessionState(),
        };
      }
      return { ...state, streamingSessions: nextSet };
    }
    case 'STOP_STREAMING': {
      const nextSet = new Set(state.streamingSessions);
      nextSet.delete(action.sessionId);
      const base: ChatState = {
        ...state,
        streamingSessions: nextSet,
        // A switch that never got applied dies with the turn — the newly
        // picked model is already what the next turn will send.
        modelSwitchPendingSessions: withoutValue(
          state.modelSwitchPendingSessions,
          action.sessionId
        ),
        // A steering message that never got a `steer_applied` ack is put back
        // for the user, in the session it came from, unless the saved
        // history already holds it (see `settleSteerDraft`).
        ...settleSteerDraft(state, action.sessionId),
      };
      // The turn's per-session leftovers die with it, in the session that
      // ran it: the compaction phases (so old progress text doesn't linger
      // into the next turn) and the running sub-agent (so the steer toggle
      // doesn't offer an agent that is gone). Only THAT session is touched —
      // another conversation may still be running its own batch.
      if (!targetsBackgroundSession(state, action.sessionId)) {
        return { ...base, compactingPhases: [], activeSubagentId: null };
      }
      const hasSlot =
        action.sessionId === NEW_SESSION_KEY || state.sessionStates.has(action.sessionId);
      if (!hasSlot) {
        return base;
      }
      const { nextState } = applyToSession(base, action.sessionId, (slot) => ({
        ...slot,
        compactingPhases: [],
        activeSubagentId: null,
      }));
      return nextState;
    }
    case 'CLEAR_COMPACT_PROGRESS': {
      if (targetsBackgroundSession(state, action.targetSessionId)) {
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

/** The store's starting state. Exported for the reducer tests. */
export const initialState: ChatState = {
  messages: [],
  sessions: [],
  currentSessionId: null,
  model: '',
  defaultModel: '',
  defaultProviderId: null,
  defaultCompactionModel: '',
  models: [],
  modelsLoading: true,
  providers: [],
  activeProviderId: null,
  baseUrl: DEFAULT_OLLAMA_BASE_URL,
  provider: DEFAULT_PROVIDER,
  requestedNumCtx: null,
  effectiveNumCtx: null,
  modelMaxNumCtx: null,
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
  redactSecrets: true,
  compactionModel: null,
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
    activeSubagentId: null,
  },
  streamingSessions: new Set<number>(),
  inputDraft: '',
  historyIndex: null,
  // Initial value is 'unknown' so the ChatInput renders the
  // "unconfirmed" hint for openai-compatible providers before the
  // first chat turn reports the resolved state. See the field's
  // JSDoc above for the full state machine.
  visionState: 'unknown',
  modelSwitchPendingSessions: new Set<number>(),
  activeSubagentId: null,
  steerDrafts: new Map<number, PendingSteerDraft>(),
  steerRestoreTexts: new Map<number, string>(),
};

export function selectUserMessages(state: ChatState): ChatMessage[] {
  return state.messages.filter((m) => m.role === 'user');
}

const ChatContext = createContext<{
  state: ChatState;
  /**
   * Applies an action now, AFTER any background updates that are still
   * queued (see `dispatchBackground`). Stable identity.
   */
  dispatch: React.Dispatch<ChatAction>;
  /**
   * Queues an action for a conversation that is not on screen. Queued
   * actions are applied together at most once per
   * `BACKGROUND_UPDATE_INTERVAL_MS`, and every `dispatch` applies them first,
   * so ordering is preserved and a session switch, a reload or a turn's end
   * always sees everything that arrived. Only the stream hook uses it.
   */
  dispatchBackground: React.Dispatch<ChatAction>;
  /**
   * Per-session map of AbortControllers — the SAME instance `page.tsx`
   * passes into `useChatStream` / `useActionHandlers` / `useSlashCommands`.
   * `useChatStream` sets `map.set(sessionId, controller)` when a turn starts,
   * re-keys `-1` → real session id on the `session_created` event, and
   * deletes the entry in the turn's `finally`; `handleStop` aborts
   * `map.get(visibleSessionId)`.
   *
   * Exposed on the chat-store context so callers that live outside
   * `page.tsx` (e.g. `ModelSelector`, `SettingsModal`) can attach their
   * in-flight mid-turn model-switch fetch to the same abort signal the Stop
   * button will fire: read `.current.get(streamingSessionId)?.signal` at the
   * moment the fetch is issued. The lookup is per session (not a single
   * "current" controller) so it stays correct when several sessions stream
   * concurrently — the fetch is always tied to the turn it is switching,
   * never to whichever turn started last. The holder is a plain ref (not
   * React state), so reading it never triggers a re-render.
   */
  abortControllersRef: { current: Map<number, AbortController> };
}>({
  state: initialState,
  dispatch: () => {},
  dispatchBackground: () => {},
  abortControllersRef: { current: new Map() },
});

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(chatReducer, initialState);
  // The ordering rule for background updates lives in one place: every
  // `dispatch` applies the queued ones first. Created once (the initialiser
  // starts no timer, so a StrictMode double run is harmless).
  const [batched] = useState(() =>
    createBatchedDispatcher<ChatAction>(rawDispatch, {
      intervalMs: BACKGROUND_UPDATE_INTERVAL_MS,
    })
  );
  // The per-session abort map's single source of truth. `page.tsx` (HomeInner)
  // takes it from this context and passes it down to `useChatStream`,
  // `useActionHandlers` and `useSlashCommands`, so the controller a mid-turn
  // model-switch fetch reads is the SAME controller the Stop button aborts.
  // Stable across renders so consumers can read `.current` without
  // registering a re-render dependency on it.
  const abortControllersRef = useRef<Map<number, AbortController>>(new Map());
  return React.createElement(
    ChatContext.Provider,
    {
      value: {
        state,
        dispatch: batched.dispatch,
        dispatchBackground: batched.dispatchBackground,
        abortControllersRef,
      },
    },
    children
  );
}

export function useChat() {
  return useContext(ChatContext);
}
