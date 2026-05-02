'use client';

import React, { createContext, useContext, useReducer, type ReactNode } from 'react';

export interface ChatMessage {
  /** Stable client-only identity used as React list key. Never sent to the server. */
  id?: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'subagent_log';
  content: string;
  thinking?: string;
  tool_calls?: any[];
  name?: string;
  /** Set on subagent_log messages to identify which sub-agent produced the output. */
  subagentId?: string;
}

// Monotonic counter — module-level so it survives re-renders but resets on
// full page reload, which is fine since IDs only need to be stable within a
// single client session.
let msgCounter = 0;

/** Return a copy of msg with a stable `id` field if it doesn't already have one. */
function withId(msg: ChatMessage): ChatMessage {
  return msg.id !== undefined ? msg : { ...msg, id: String(++msgCounter) };
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
}

export interface WebSearchConfig {
  maxQueries: number;
  resultsPerQuery: number;
  perPageCharLimit: number;
}

interface ChatState {
  messages: ChatMessage[];
  sessions: Session[];
  currentSessionId: number | null;
  model: string;
  models: LLmModel[];
  isStreaming: boolean;
  baseUrl: string;
  numCtx: number;
  requestedNumCtx: number;
  modelContextLimit: number | null;
  error: string | null;
  // Approval dialog
  pendingCommand: { name: string; args: any } | null;
  showApproval: boolean;
  pendingApprovalId: string | null;
  // Additional config fields from CLI
  yolo: boolean;
  thinkingEnabled: boolean;
  compactionModel: string;
  chatTimeoutMs: number;
  webSearch: WebSearchConfig;
  tokenStats: {
    promptEvalCount: number;
    evalCount: number;
    totalTokens: number;
    tokenLimit: number;
  } | null;
}

type ChatAction =
  | { type: 'SET_MESSAGES'; messages: ChatMessage[] }
  | { type: 'ADD_MESSAGE'; message: ChatMessage }
  | { type: 'UPDATE_LAST_MESSAGE'; content?: string; thinking?: string }
  | { type: 'APPLY_ASSISTANT_DELTA'; content?: string; thinking?: string }
  | { type: 'APPEND_TOOL_PROGRESS'; content: string; name?: string }
  | { type: 'SUBAGENT_OUTPUT'; agentId: string; message: string }
  | { type: 'SUBAGENT_CHUNK'; agentId: string; text: string }
  | { type: 'SET_SESSIONS'; sessions: Session[] }
  | { type: 'SET_CURRENT_SESSION'; id: number | null }
  | { type: 'SET_MODELS'; models: LLmModel[] }
  | { type: 'SET_MODEL'; model: string }
  | { type: 'SET_STREAMING'; isStreaming: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_CONFIG'; config: Partial<ChatState> }
  | { type: 'SET_MODEL_CONTEXT_LIMIT'; limit: number | null }
  | { type: 'SHOW_APPROVAL'; command: { name: string; args: any } | null; requestId?: string }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'SET_TOKEN_STATS'; stats: ChatState['tokenStats'] }
  | { type: 'CLEAR_TOKEN_STATS' };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SET_MESSAGES':
      return { 
        ...state, 
        messages: action.messages
            .filter((m: ChatMessage) => m.role !== 'system')
            .map(withId) 
      };
    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, withId(action.message)] };
    case 'UPDATE_LAST_MESSAGE': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = {
          ...last,
          ...(action.content !== undefined ? { content: last.content + action.content } : {}),
          ...(action.thinking !== undefined ? { thinking: (last.thinking || '') + action.thinking } : {}),
        };
      }
      return { ...state, messages: msgs };
    }
    case 'APPLY_ASSISTANT_DELTA': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];

      if (!last || last.role !== 'assistant') {
        msgs.push(withId({
          role: 'assistant',
          content: action.content ?? '',
          ...(action.thinking !== undefined ? { thinking: action.thinking } : {}),
        }));
        return { ...state, messages: msgs };
      }

      msgs[msgs.length - 1] = {
        ...last,
        ...(action.content !== undefined ? { content: last.content + action.content } : {}),
        ...(action.thinking !== undefined ? { thinking: (last.thinking || '') + action.thinking } : {}),
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
          content: candidate.content
            ? `${candidate.content}\n${action.content}`
            : action.content,
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
          content: candidate.content
            ? `${candidate.content}\n${action.message}`
            : action.message,
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
    case 'SET_SESSIONS':
      return { ...state, sessions: action.sessions };
    case 'SET_CURRENT_SESSION':
      return { ...state, currentSessionId: action.id };
    case 'SET_MODELS':
      return { ...state, models: action.models };
    case 'SET_MODEL':
      return { ...state, model: action.model };
    case 'SET_STREAMING':
      return { ...state, isStreaming: action.isStreaming };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    case 'SET_CONFIG': {
      const requestedNumCtx = action.config.numCtx ?? state.requestedNumCtx;
      const modelContextLimit = state.modelContextLimit;
      const effectiveNumCtx = modelContextLimit && modelContextLimit > 0
        ? Math.min(requestedNumCtx, modelContextLimit)
        : requestedNumCtx;
      const { numCtx: _, ...restConfig } = action.config;
      return { ...state, requestedNumCtx, numCtx: effectiveNumCtx, ...restConfig };
    }
    case 'SHOW_APPROVAL':
      return {
        ...state,
        pendingCommand: action.command,
        showApproval: action.command !== null,
        pendingApprovalId: action.requestId ?? null,
      };
    case 'SET_MODEL_CONTEXT_LIMIT': {
      const effectiveNumCtx = action.limit && action.limit > 0
        ? Math.min(state.requestedNumCtx, action.limit)
        : state.requestedNumCtx;
      return { ...state, modelContextLimit: action.limit, numCtx: effectiveNumCtx };
    }
    case 'CLEAR_MESSAGES':
      return { ...state, messages: [] };
    case 'SET_TOKEN_STATS':
      return { ...state, tokenStats: action.stats };
    case 'CLEAR_TOKEN_STATS':
      return { ...state, tokenStats: null };
    default:
      return state;
  }
}

const initialState: ChatState = {
  messages: [],
  sessions: [],
  currentSessionId: null,
  model: '',
  models: [],
  isStreaming: false,
  baseUrl: 'http://localhost:11434',
  numCtx: 131072,
  requestedNumCtx: 131072,
  modelContextLimit: null,
  error: null,
  pendingCommand: null,
  showApproval: false,
  pendingApprovalId: null,
  yolo: false,
  thinkingEnabled: true,
  compactionModel: '',
  chatTimeoutMs: 720_000,
  webSearch: {
    maxQueries: 3,
    resultsPerQuery: 3,
    perPageCharLimit: 5000,
  },
  tokenStats: null,
};

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
