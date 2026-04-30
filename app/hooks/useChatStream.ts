'use client';

import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import { useChat, type ChatMessage } from '@/app/lib/chatStore';
import type { StableRefs } from './useStableRefs';

/**
 * Owns the SSE event dispatcher and the sendChatMessage driver that runs a
 * full streaming chat turn (fetch → SSE parse → dispatch → finally loadSessions).
 */
export function useChatStream(
  refs: StableRefs,
  abortRef: MutableRefObject<AbortController | null>,
  needsNewAssistantRef: MutableRefObject<boolean>,
  loadSessions: () => Promise<void>,
) {
  const { state, dispatch } = useChat();

  const handleEvent = useCallback(
    (event: string, data: any) => {
      switch (event) {
        case 'thinking':
          if (needsNewAssistantRef.current) {
            dispatch({ type: 'ADD_MESSAGE', message: { role: 'assistant', content: '', thinking: data.content ?? data } });
            needsNewAssistantRef.current = false;
          } else {
            dispatch({ type: 'UPDATE_LAST_MESSAGE', thinking: data.content ?? data });
          }
          break;

        case 'chunk':
          if (needsNewAssistantRef.current) {
            dispatch({ type: 'ADD_MESSAGE', message: { role: 'assistant', content: data.content ?? data } });
            needsNewAssistantRef.current = false;
          } else {
            dispatch({ type: 'UPDATE_LAST_MESSAGE', content: data.content ?? data });
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

        case 'approval_request':
          // The backend is paused waiting for the user to approve or reject
          // the run_command request.  Show the ApprovalModal.
          dispatch({
            type: 'SHOW_APPROVAL',
            command: { name: data.toolName ?? data.name, args: data.args },
            requestId: data.requestId,
          });
          break;

        case 'tool_result':
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'tool',
              content: `✅ **${data.name}** (${data.duration ?? 0}ms)\n\n\`\`\`\n${data.result ?? ''}\n\`\`\``,
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
          if (Array.isArray(data.messages)) {
            dispatch({ type: 'SET_MESSAGES', messages: data.messages });
          }
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
          dispatch({ type: 'SET_ERROR', error: data.message ?? 'Unknown error' });
          break;

        default:
          break;
      }
    },
    [dispatch, needsNewAssistantRef],
  );

  const sendChatMessage = useCallback(
    async (message: string) => {
      if (state.isStreaming) return;

      if (!refs.modelRef.current.trim()) {
        dispatch({ type: 'SET_ERROR', error: 'Please select a model first' });
        return;
      }

      const currentMessages = refs.messagesRef.current;
      const userMessage: ChatMessage = { role: 'user', content: message };

      dispatch({ type: 'ADD_MESSAGE', message: userMessage });
      dispatch({ type: 'SET_STREAMING', isStreaming: true });
      dispatch({ type: 'SET_ERROR', error: null });
      needsNewAssistantRef.current = false;
      dispatch({ type: 'ADD_MESSAGE', message: { role: 'assistant', content: '' } });

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [...currentMessages, userMessage],
            model: refs.modelRef.current,
            numCtx: refs.numCtxRef.current,
            baseUrl: refs.baseUrlRef.current,
            sessionId: refs.sessionIdRef.current,
            yolo: refs.yoloRef.current,
            think: refs.thinkingEnabledRef.current,
            compactionModel: refs.compactionModelRef.current,
            chatTimeoutMs: refs.chatTimeoutMsRef.current,
            webSearch: refs.webSearchRef.current,
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
        let currentDataLines: string[] = [];

        const flushEvent = () => {
          if (!currentEvent || currentDataLines.length === 0) {
            currentEvent = '';
            currentDataLines = [];
            return;
          }

          const currentData = currentDataLines.join('\n');
          try {
            const parsed = JSON.parse(currentData);
            handleEvent(currentEvent, parsed);
          } catch {
            handleEvent(currentEvent, currentData);
          }

          currentEvent = '';
          currentDataLines = [];
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data:')) {
              const value = line.slice(5).replace(/^ /, '');
              currentDataLines.push(value);
            } else if (line === '') {
              flushEvent();
            }
          }
        }

        flushEvent();
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          dispatch({ type: 'SET_ERROR', error: err.message });
        }
      } finally {
        dispatch({ type: 'SET_STREAMING', isStreaming: false });
        abortRef.current = null;
        loadSessions();
      }
    },
    [state.isStreaming, dispatch, handleEvent, refs, abortRef, needsNewAssistantRef, loadSessions],
  );

  return { sendChatMessage, handleEvent };
}
