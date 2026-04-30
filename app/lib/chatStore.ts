'use client';

import React, { createContext, useContext, useReducer, type ReactNode } from 'react';

export interface ChatMessage {
  /** Stable client-only identity used as React list key. Never sent to the server. */
  id?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  thinking?: string;
  tool_calls?: any[];
  name?: string;
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
}

type ChatAction =
  | { type: 'SET_MESSAGES'; messages: ChatMessage[] }
  | { type: 'ADD_MESSAGE'; message: ChatMessage }
  | { type: 'UPDATE_LAST_MESSAGE'; content?: string; thinking?: string }
  | { type: 'APPLY_ASSISTANT_DELTA'; content?: string; thinking?: string }
  | { type: 'APPEND_TOOL_PROGRESS'; content: string; name?: string }
  | { type: 'SET_SESSIONS'; sessions: Session[] }
  | { type: 'SET_CURRENT_SESSION'; id: number | null }
  | { type: 'SET_MODELS'; models: LLmModel[] }
  | { type: 'SET_MODEL'; model: string }
  | { type: 'SET_STREAMING'; isStreaming: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_CONFIG'; config: Partial<ChatState> }
  | { type: 'SHOW_APPROVAL'; command: { name: string; args: any } | null; requestId?: string }
  | { type: 'CLEAR_MESSAGES' };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SET_MESSAGES':
      return { ...state, messages: action.messages.map(withId) };
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
    case 'SET_CONFIG':
      return { ...state, ...action.config };
    case 'SHOW_APPROVAL':
      return {
        ...state,
        pendingCommand: action.command,
        showApproval: action.command !== null,
        pendingApprovalId: action.requestId ?? null,
      };
    case 'CLEAR_MESSAGES':
      return { ...state, messages: [] };
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
