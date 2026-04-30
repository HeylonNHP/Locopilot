'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useChat, type ChatMessage } from './lib/chatStore';
import ChatMessageBubble from '@/components/ChatMessageBubble';
import ChatInput from '@/components/ChatInput';
import SessionSidebar from '@/components/SessionSidebar';
import ApprovalModal from '@/components/ApprovalModal';
import StatusBar from '@/components/StatusBar';
import SettingsModal from '@/components/SettingsModal';

export default function Home() {
  const { state, dispatch } = useChat();
  const [showSettings, setShowSettings] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isCompactingRef = useRef(false);
  const isGeneratingTitleRef = useRef(false);

  // ── Refs to avoid stale closures in the SSE streaming callback ──
  const messagesRef = useRef(state.messages);
  const modelRef = useRef(state.model);
  const numCtxRef = useRef(state.numCtx);
  const baseUrlRef = useRef(state.baseUrl);
  const sessionIdRef = useRef(state.currentSessionId);
  const modelsRef = useRef(state.models);
  const yoloRef = useRef(state.yolo);
  const thinkingEnabledRef = useRef(state.thinkingEnabled);
  const compactionModelRef = useRef(state.compactionModel);
  const chatTimeoutMsRef = useRef(state.chatTimeoutMs);
  const webSearchRef = useRef(state.webSearch);
  const needsNewAssistantRef = useRef(false);

  useEffect(() => { messagesRef.current = state.messages; }, [state.messages]);
  useEffect(() => { modelRef.current = state.model; }, [state.model]);
  useEffect(() => { numCtxRef.current = state.numCtx; }, [state.numCtx]);
  useEffect(() => { baseUrlRef.current = state.baseUrl; }, [state.baseUrl]);
  useEffect(() => { sessionIdRef.current = state.currentSessionId; }, [state.currentSessionId]);
  useEffect(() => { modelsRef.current = state.models; }, [state.models]);
  useEffect(() => { yoloRef.current = state.yolo; }, [state.yolo]);
  useEffect(() => { thinkingEnabledRef.current = state.thinkingEnabled; }, [state.thinkingEnabled]);
  useEffect(() => { compactionModelRef.current = state.compactionModel; }, [state.compactionModel]);
  useEffect(() => { chatTimeoutMsRef.current = state.chatTimeoutMs; }, [state.chatTimeoutMs]);
  useEffect(() => { webSearchRef.current = state.webSearch; }, [state.webSearch]);
  useEffect(() => { isCompactingRef.current = isCompacting; }, [isCompacting]);
  useEffect(() => { isGeneratingTitleRef.current = isGeneratingTitle; }, [isGeneratingTitle]);

  // ── Auto-scroll when messages change ────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages]);

  // ── Load initial data on mount ──────────────────────────────────
  useEffect(() => {
    loadSessions();
    loadModels();
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── API helpers ─────────────────────────────────────────────────
  const loadSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        const sessions = data.sessions ?? [];
        dispatch({ type: 'SET_SESSIONS', sessions });
      }
    } catch {
      // Silently ignore – sessions will be empty
    }
  };

  const loadModels = async () => {
    try {
      const res = await fetch('/api/models');
      if (res.ok) {
        const data = await res.json();
        const models = data.models ?? data ?? [];
        const modelList = Array.isArray(models) ? models : [];
        dispatch({
          type: 'SET_MODELS',
          models: modelList,
        });
        // Auto-select first model if none selected
        if (!modelRef.current && modelList.length > 0) {
          const firstModel = typeof modelList[0] === 'string' ? modelList[0] : (modelList[0].name ?? '');
          if (firstModel) {
            dispatch({ type: 'SET_MODEL', model: firstModel });
          }
        }
      }
    } catch {
      // Silently ignore – models will be empty
    }
  };

  const loadConfig = async () => {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        const config = data.config ?? data;
        dispatch({
          type: 'SET_CONFIG',
          config: {
            baseUrl: config.baseUrl ?? state.baseUrl,
            numCtx: config.numCtx ?? state.numCtx,
            model: config.model || config.lastModel || modelRef.current,
            yolo: config.yolo ?? state.yolo,
            thinkingEnabled: config.thinkingEnabled ?? state.thinkingEnabled,
            compactionModel: config.compactionModel ?? state.compactionModel,
            chatTimeoutMs: config.chatTimeoutMs ?? state.chatTimeoutMs,
            webSearch: config.webSearch ?? state.webSearch,
          },
        });
      }
    } catch {
      // Silently ignore
    }
  };

  const loadSessionMessages = async (sessionId: number) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.messages) {
          dispatch({ type: 'SET_MESSAGES', messages: data.messages });
        }
        dispatch({ type: 'SET_CURRENT_SESSION', id: sessionId });
      }
    } catch {
      // Silently ignore
    }
  };

  // ── SSE event handler (dispatches to store) ─────────────────────
  const handleEvent = useCallback(
    (event: string, data: any) => {
      switch (event) {
        case 'thinking':
          if (needsNewAssistantRef.current) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'assistant',
                content: '',
                thinking: data.content ?? data,
              },
            });
            needsNewAssistantRef.current = false;
          } else {
            dispatch({
              type: 'UPDATE_LAST_MESSAGE',
              thinking: data.content ?? data,
            });
          }
          break;

        case 'chunk':
          if (needsNewAssistantRef.current) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'assistant',
                content: data.content ?? data,
              },
            });
            needsNewAssistantRef.current = false;
          } else {
            dispatch({
              type: 'UPDATE_LAST_MESSAGE',
              content: data.content ?? data,
            });
          }
          break;

        case 'tool_call':
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'tool',
              content: `🔧 **${data.name}**\n\`\`\`json\n${JSON.stringify(data.arguments, null, 2)}\n\`\`\``,
              name: data.name,
            },
          });
          break;

        case 'tool_result':
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'tool',
              content: `✅ **${data.name}** (${data.duration ?? 0}ms)\n\n\`\`\`\n${(data.result ?? '')}\n\`\`\``,
              name: data.name,
            },
          });
          needsNewAssistantRef.current = true;
          break;

        case 'tool_progress':
          dispatch({
            type: 'APPEND_TOOL_PROGRESS',
            name: data.name,
            content: data.message ?? data.content ?? String(data),
          });
          break;

        case 'compact':
          // The server has compacted the conversation history. Replace the
          // client's message list so the next request sends the shorter history,
          // then surface an informational notice to the user.
          if (Array.isArray(data.messages)) {
            dispatch({ type: 'SET_MESSAGES', messages: data.messages });
          }
          // Ensure the next streamed chunk opens a fresh assistant bubble.
          needsNewAssistantRef.current = true;
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'system',
              content: `⚡ Conversation auto-compacted (${data.stats?.oldTokenCount ?? '?'} → ${data.stats?.newTokenCount ?? '?'} tokens)`,
            },
          });
          break;

        case 'done':
          if (data.sessionId) {
            dispatch({ type: 'SET_CURRENT_SESSION', id: data.sessionId });
          }
          break;

        case 'error':
          dispatch({
            type: 'SET_ERROR',
            error: data.message ?? 'Unknown error',
          });
          break;

        default:
          break;
      }
    },
    [dispatch],
  );

  // ── Slash command handler ───────────────────────────────────────
  const handleSlashCommand = useCallback(
    async (message: string) => {
      const parts = message.slice(1).split(' ');
      if (parts.length === 0) return;
      const command = (parts[0] ?? '').toLowerCase();
      const args = parts.slice(1).join(' ').trim();

      switch (command) {
        case 'help': {
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'system',
              content:
                'Available commands:\n' +
                '/help      - Show all available commands\n' +
                '/clear     - Clear messages\n' +
                '/model [name] - Switch LLM model\n' +
                '/compact   - Summarise conversation history\n' +
                '/title     - Generate a title for current session\n' +
                '/dump      - Export conversation to markdown file\n' +
                '/sessions  - List and switch sessions\n' +
                '/delete    - Delete a session\n' +
                '/settings  - Open settings modal\n' +
                '/new       - Start a fresh conversation\n' +
                '/nudge     - Manually remind AI to use tools\n' +
                '/exit      - Exit (reloads page)',
            },
          });
          return;
        }
        case 'clear': {
          dispatch({ type: 'CLEAR_MESSAGES' });
          return;
        }
        case 'new': {
          dispatch({ type: 'CLEAR_MESSAGES' });
          dispatch({ type: 'SET_CURRENT_SESSION', id: null });
          await loadSessions();
          dispatch({
            type: 'ADD_MESSAGE',
            message: { role: 'system', content: 'Started a new conversation.' },
          });
          return;
        }
        case 'exit': {
          dispatch({
            type: 'ADD_MESSAGE',
            message: { role: 'system', content: 'Reloading page...' },
          });
          window.location.reload();
          return;
        }
        case 'settings': {
          setShowSettings(true);
          dispatch({
            type: 'ADD_MESSAGE',
            message: { role: 'system', content: 'Settings opened.' },
          });
          return;
        }
        case 'sessions': {
          const sessions = state.sessions;
          if (sessions.length === 0) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: { role: 'system', content: 'No saved sessions yet.' },
            });
          } else {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content:
                  'Saved sessions:\n' +
                  sessions.map((s) => `[${s.id}] ${s.name} (${s.model})`).join('\n') +
                  '\n\nClick a session in the sidebar to switch.',
              },
            });
          }
          return;
        }
        case 'delete': {
          const sessions = state.sessions;
          if (sessions.length === 0) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: { role: 'system', content: 'No saved sessions to delete.' },
            });
            return;
          }
          if (args) {
            const id = parseInt(args, 10);
            if (!isNaN(id)) {
              try {
                await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
                loadSessions();
                if (state.currentSessionId === id) {
                  dispatch({ type: 'CLEAR_MESSAGES' });
                  dispatch({ type: 'SET_CURRENT_SESSION', id: null });
                }
                dispatch({
                  type: 'ADD_MESSAGE',
                  message: { role: 'system', content: `Deleted session ${id}.` },
                });
              } catch {
                dispatch({
                  type: 'ADD_MESSAGE',
                  message: { role: 'system', content: `Failed to delete session ${id}.` },
                });
              }
            } else {
              dispatch({
                type: 'ADD_MESSAGE',
                message: { role: 'system', content: 'Usage: /delete <session_id>' },
              });
            }
          } else {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content:
                  'Usage: /delete <session_id>\nSessions:\n' +
                  sessions.map((s) => `[${s.id}] ${s.name}`).join('\n'),
              },
            });
          }
          return;
        }
        case 'model': {
          const availableModels = modelsRef.current;
          if (args) {
            const matched = availableModels.find((m) => {
              const name = typeof m === 'string' ? m : m.name;
              return name.toLowerCase() === args.toLowerCase();
            });
            if (matched) {
              const modelName = typeof matched === 'string' ? matched : matched.name;
              dispatch({ type: 'SET_MODEL', model: modelName });
              try {
                await fetch('/api/config', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ model: modelName }),
                });
              } catch {
                // Ignore save errors
              }
              dispatch({
                type: 'ADD_MESSAGE',
                message: { role: 'system', content: `Model set to ${modelName}` },
              });
            } else {
              dispatch({
                type: 'ADD_MESSAGE',
                message: {
                  role: 'system',
                  content: `Model "${args}" not found. Use /model to see available models.`,
                },
              });
            }
          } else {
            const modelNames = availableModels.map((m) =>
              typeof m === 'string' ? m : m.name,
            );
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content:
                  'Available models:\n' +
                  (modelNames.length
                    ? modelNames.map((m) => `- ${m}`).join('\n')
                    : 'No models loaded yet.'),
              },
            });
          }
          return;
        }
        case 'compact': {
          const currentMessages = messagesRef.current;
          if (abortRef.current) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: 'Stop the current response before running /compact.',
              },
            });
            return;
          }

          if (isCompactingRef.current) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: 'Compaction is already in progress.',
              },
            });
            return;
          }

          if (!modelRef.current.trim()) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: 'Select a model before running /compact.',
              },
            });
            return;
          }

          if (currentMessages.length <= 1) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: 'Nothing to compact yet — continue the conversation and try again.',
              },
            });
            return;
          }

          isCompactingRef.current = true;
          setIsCompacting(true);

          try {
            const response = await fetch('/api/compact', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: currentMessages,
                model: modelRef.current,
                numCtx: numCtxRef.current,
                baseUrl: baseUrlRef.current,
                compactionModel: compactionModelRef.current,
                sessionId: sessionIdRef.current,
              }),
            });

            const data = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(data?.error ?? `HTTP ${response.status}`);
            }

            if (!Array.isArray(data?.messages)) {
              throw new Error('Compaction returned an invalid message list.');
            }

            dispatch({ type: 'SET_MESSAGES', messages: data.messages as ChatMessage[] });
            needsNewAssistantRef.current = true;
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: `⚡ Conversation compacted (${data.stats?.oldTokenCount ?? '?'} → ${data.stats?.newTokenCount ?? '?'} tokens)`,
              },
            });

            if (
              typeof data?.stats?.newTokenCount === 'number' &&
              data.stats.newTokenCount > numCtxRef.current
            ) {
              dispatch({
                type: 'ADD_MESSAGE',
                message: {
                  role: 'system',
                  content:
                    `⚠️ Compaction reduced the history but it is still over the current context limit ` +
                    `(${data.stats.newTokenCount}/${numCtxRef.current} tokens). The next turn may fail.`,
                },
              });
            }

            await loadSessions();
          } catch (error) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: `Compaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
              },
            });
          } finally {
            isCompactingRef.current = false;
            setIsCompacting(false);
          }
          return;
        }
        case 'title': {
          const currentMessages = messagesRef.current;
          if (abortRef.current) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: 'Stop the current response before running /title.',
              },
            });
            return;
          }

          if (isCompactingRef.current) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: 'Wait for compaction to finish before running /title.',
              },
            });
            return;
          }

          if (isGeneratingTitleRef.current) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: 'Title generation is already in progress.',
              },
            });
            return;
          }

          if (!modelRef.current.trim()) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: 'Select a model before running /title.',
              },
            });
            return;
          }

          if (currentMessages.length <= 1) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: 'Not enough conversation history to generate a title yet.',
              },
            });
            return;
          }

          if (!sessionIdRef.current) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: 'This conversation does not have a saved session yet. Send a message and wait for the reply first.',
              },
            });
            return;
          }

          isGeneratingTitleRef.current = true;
          setIsGeneratingTitle(true);

          try {
            const response = await fetch('/api/title', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: currentMessages,
                model: modelRef.current,
                numCtx: numCtxRef.current,
                baseUrl: baseUrlRef.current,
                compactionModel: compactionModelRef.current,
                sessionId: sessionIdRef.current,
              }),
            });

            const data = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(data?.error ?? `HTTP ${response.status}`);
            }

            if (typeof data?.title !== 'string' || data.title.trim().length === 0) {
              throw new Error('Title generation returned an invalid title.');
            }

            await loadSessions();
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: `Session title updated to: ${data.title}`,
              },
            });
          } catch (error) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: `Title generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
              },
            });
          } finally {
            isGeneratingTitleRef.current = false;
            setIsGeneratingTitle(false);
          }
          return;
        }
        case 'dump': {
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'system',
              content: 'Not yet implemented in web UI: /dump',
            },
          });
          return;
        }
        case 'nudge': {
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'system',
              content: 'Not yet implemented in web UI: /nudge',
            },
          });
          return;
        }
        case 'ctx': {
          const size = parseInt(args, 10);
          if (!args || isNaN(size) || size <= 0) {
            dispatch({
              type: 'ADD_MESSAGE',
              message: {
                role: 'system',
                content: 'Usage: /ctx <size> (e.g., /ctx 8192)',
              },
            });
          } else {
            dispatch({ type: 'SET_CONFIG', config: { numCtx: size } });
            try {
              await fetch('/api/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ numCtx: size }),
              });
            } catch {
              // Ignore save errors
            }
            dispatch({
              type: 'ADD_MESSAGE',
              message: { role: 'system', content: `Context size set to ${size}` },
            });
          }
          return;
        }
        default: {
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'system',
              content: `Unknown command: /${command}. Type /help for available commands.`,
            },
          });
          return;
        }
      }
    },
    [dispatch, state.sessions, state.currentSessionId],
  );

  // ── Send message via SSE streaming ──────────────────────────────
  const handleSend = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('/')) {
        await handleSlashCommand(trimmed);
        return;
      }
      if (state.isStreaming) return;

      // Guard: require a model
      if (!modelRef.current.trim()) {
        dispatch({ type: 'SET_ERROR', error: 'Please select a model first' });
        return;
      }

      const currentMessages = messagesRef.current;
      const userMessage: ChatMessage = { role: 'user', content: message };

      // Add user message to the UI immediately
      dispatch({
        type: 'ADD_MESSAGE',
        message: userMessage,
      });
      dispatch({ type: 'SET_STREAMING', isStreaming: true });
      dispatch({ type: 'SET_ERROR', error: null });
      needsNewAssistantRef.current = false;

      // Add placeholder assistant message that will be updated via SSE
      dispatch({
        type: 'ADD_MESSAGE',
        message: { role: 'assistant', content: '' },
      });

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [...currentMessages, userMessage],
            model: modelRef.current,
            numCtx: numCtxRef.current,
            baseUrl: baseUrlRef.current,
            sessionId: sessionIdRef.current,
            yolo: yoloRef.current,
            think: thinkingEnabledRef.current,
            compactionModel: compactionModelRef.current,
            chatTimeoutMs: chatTimeoutMsRef.current,
            webSearch: webSearchRef.current,
          }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body stream');

        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';
        let currentData = '';

        // Read the SSE stream
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines from the buffer
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // Keep incomplete trailing data

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              currentData = line.slice(6).trim();
            } else if (line === '' && currentEvent && currentData) {
              // Empty line signals end of an SSE message
              try {
                const parsed = JSON.parse(currentData);
                handleEvent(currentEvent, parsed);
              } catch {
                // If data is not JSON, pass it as raw string
                handleEvent(currentEvent, currentData);
              }
              currentEvent = '';
              currentData = '';
            }
          }
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          dispatch({ type: 'SET_ERROR', error: err.message });
        }
      } finally {
        dispatch({ type: 'SET_STREAMING', isStreaming: false });
        abortRef.current = null;
        // Reload sessions so the new/updated session appears in the sidebar
        loadSessions();
      }
    },
    // Only re-create handleSend when isStreaming or dispatch changes,
    // NOT when messages change – we use the ref for messages.
    [state.isStreaming, dispatch, handleEvent, handleSlashCommand],
  );

  // ── Abort streaming ─────────────────────────────────────────────
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ── Approval modal handlers ─────────────────────────────────────
  const handleApprove = useCallback(() => {
    dispatch({ type: 'SHOW_APPROVAL', command: null });
    // The parent orchestrator will read the approval and continue
  }, [dispatch]);

  const handleReject = useCallback(() => {
    dispatch({ type: 'SHOW_APPROVAL', command: null });
    dispatch({
      type: 'ADD_MESSAGE',
      message: {
        role: 'tool',
        content: '⛔ Command rejected by user.',
      },
    });
  }, [dispatch]);

  // ── New session ─────────────────────────────────────────────────
  const handleNewSession = useCallback(async () => {
    dispatch({ type: 'CLEAR_MESSAGES' });
    dispatch({ type: 'SET_CURRENT_SESSION', id: null });
    // Reload to pick up any sessions created during this conversation
    await loadSessions();
  }, [dispatch]);

  // ── Delete session ──────────────────────────────────────────────
  const handleDeleteSession = useCallback(
    async (id: number) => {
      try {
        await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
        loadSessions();
        if (state.currentSessionId === id) {
          dispatch({ type: 'CLEAR_MESSAGES' });
          dispatch({ type: 'SET_CURRENT_SESSION', id: null });
        }
      } catch {
        // Silently ignore
      }
    },
    [state.currentSessionId, dispatch],
  );

  // ── Settings ──────────────────────────────────────────────────
  const handleOpenSettings = useCallback(() => {
    setShowSettings(true);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setShowSettings(false);
  }, []);

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
      }}
    >
      {/* Sidebar */}
      <SessionSidebar
        onNewSession={handleNewSession}
        onSelectSession={loadSessionMessages}
        onDeleteSession={handleDeleteSession}
        onSettings={handleOpenSettings}
      />

      {/* Main chat area */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
        }}
      >
        {/* Messages area */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {state.messages.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <h1 style={{ fontSize: '24px', fontWeight: 'normal', margin: 0 }}>
                Locopilot
              </h1>
              <p style={{ margin: 0 }}>Local, Private, Safe AI Assistant</p>
              {state.models.length > 0 && (
                <p style={{ fontSize: '13px', margin: 0 }}>
                  {state.models.length} model{state.models.length !== 1 ? 's' : ''} available
                </p>
              )}
            </div>
          ) : (
            state.messages.map((msg, i) => (
              <ChatMessageBubble key={i} message={msg} />
            ))
          )}

          {/* Error banner */}
          {state.error && (
            <div
              style={{
                padding: '12px',
                marginTop: '8px',
                background: '#3d1f1f',
                border: '1px solid #e94560',
                borderRadius: '8px',
                color: '#ff6b81',
                fontSize: '13px',
              }}
            >
              {state.error}
              <button
                onClick={() => dispatch({ type: 'SET_ERROR', error: null })}
                style={{
                  marginLeft: '12px',
                  background: 'none',
                  border: 'none',
                  color: '#ff6b81',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  fontSize: '13px',
                }}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Scroll anchor */}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div
          style={{
            padding: '16px',
            borderTop: '1px solid #333',
            background: 'var(--bg-secondary)',
          }}
        >
          {state.isStreaming ? (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ color: 'var(--accent)', fontSize: '14px' }}>
                ● Streaming...
              </span>
              <button
                onClick={handleStop}
                style={{
                  padding: '8px 20px',
                  borderRadius: '8px',
                  border: '1px solid #e94560',
                  background: 'transparent',
                  color: '#e94560',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                Stop
              </button>
            </div>
          ) : isCompacting ? (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ color: 'var(--accent)', fontSize: '14px' }}>
                ● Compacting conversation...
              </span>
            </div>
          ) : isGeneratingTitle ? (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ color: 'var(--accent)', fontSize: '14px' }}>
                ● Generating session title...
              </span>
            </div>
          ) : (
            <ChatInput onSend={handleSend} disabled={false} />
          )}
        </div>

        {/* Status bar */}
        <StatusBar />
      </div>

      {/* Approval modal */}
      {state.showApproval && state.pendingCommand && (
        <ApprovalModal
          command={state.pendingCommand}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

      {/* Settings modal */}
      {showSettings && <SettingsModal onClose={handleCloseSettings} />}
    </div>
  );
}
