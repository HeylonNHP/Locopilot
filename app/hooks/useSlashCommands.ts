'use client';

import { useCallback } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import { useChat, type ChatMessage } from '@/app/lib/chatStore';
import { buildToolUseNudge } from '@/services/toolUseNudge';
import type { StableRefs } from './useStableRefs';

interface SlashCommandDeps {
  refs: StableRefs;
  isCurrentSessionStreaming: boolean;
  isCompactingRef: MutableRefObject<boolean>;
  isGeneratingTitleRef: MutableRefObject<boolean>;
  setIsCompacting: Dispatch<SetStateAction<boolean>>;
  setIsGeneratingTitle: Dispatch<SetStateAction<boolean>>;
  onOpenSettings: () => void;
  loadSessions: () => Promise<void>;
  sendChatMessage: (message: string) => Promise<void>;
}

/**
 * Parses and dispatches all /slash commands typed into the chat input.
 */
export function useSlashCommands({
  refs,
  isCurrentSessionStreaming,
  isCompactingRef,
  isGeneratingTitleRef,
  setIsCompacting,
  setIsGeneratingTitle,
  onOpenSettings,
  loadSessions,
  sendChatMessage,
}: SlashCommandDeps) {
  const { state, dispatch } = useChat();

  const parseDownloadFileName = (contentDisposition: string | null): string => {
    if (!contentDisposition) {
      return 'locopilot-history.md';
    }

    const filenameStarMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
    const encodedName = filenameStarMatch?.[1] ?? filenameMatch?.[1];

    if (!encodedName) {
      return 'locopilot-history.md';
    }

    try {
      return decodeURIComponent(encodedName);
    } catch {
      return encodedName;
    }
  };

  const triggerDownload = (content: string, fileName: string): void => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = downloadUrl;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  };

  const readErrorMessage = async (response: Response): Promise<string> => {
    const responseText = await response.text().catch(() => '');

    try {
      const parsed = JSON.parse(responseText) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
        return parsed.error;
      }
    } catch {
      // Ignore JSON parse failures and fall back to the raw response body.
    }

    return responseText.trim().length > 0 ? responseText.trim() : `HTTP ${response.status}`;
  };

  const handleSlashCommand = useCallback(
    async (message: string) => {
      const parts = message.slice(1).split(' ');
      if (parts.length === 0) return;
      const command = (parts[0] ?? '').toLowerCase();
      const args = parts.slice(1).join(' ').trim();

      const addSystem = (content: string) =>
        dispatch({ type: 'ADD_MESSAGE', message: { role: 'system', content } });

      switch (command) {
        case 'help': {
          addSystem(
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
          );
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
          addSystem('Started a new conversation.');
          return;
        }

        case 'exit': {
          addSystem('Reloading page...');
          window.location.reload();
          return;
        }

        case 'settings': {
          onOpenSettings();
          addSystem('Settings opened.');
          return;
        }

        case 'sessions': {
          const { sessions } = state;
          if (sessions.length === 0) {
            addSystem('No saved sessions yet.');
          } else {
            addSystem(
              'Saved sessions:\n' +
              sessions.map((s) => `[${s.id}] ${s.name} (${s.model})`).join('\n') +
              '\n\nClick a session in the sidebar to switch.',
            );
          }
          return;
        }

        case 'delete': {
          const { sessions } = state;
          if (sessions.length === 0) {
            addSystem('No saved sessions to delete.');
            return;
          }
          if (args) {
            const id = parseInt(args, 10);
            if (!isNaN(id)) {
              try {
                await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
                loadSessions();
                if (refs.sessionIdRef.current === id) {
                  dispatch({ type: 'CLEAR_MESSAGES' });
                  dispatch({ type: 'SET_CURRENT_SESSION', id: null });
                }
                addSystem(`Deleted session ${id}.`);
              } catch {
                addSystem(`Failed to delete session ${id}.`);
              }
            } else {
              addSystem('Usage: /delete <session_id>');
            }
          } else {
            addSystem(
              'Usage: /delete <session_id>\nSessions:\n' +
              sessions.map((s) => `[${s.id}] ${s.name}`).join('\n'),
            );
          }
          return;
        }

        case 'model': {
          const availableModels = refs.modelsRef.current;
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
              addSystem(`Model set to ${modelName}`);
            } else {
              addSystem(`Model "${args}" not found. Use /model to see available models.`);
            }
          } else {
            const modelNames = availableModels.map((m) => typeof m === 'string' ? m : m.name);
            addSystem(
              'Available models:\n' +
              (modelNames.length ? modelNames.map((m) => `- ${m}`).join('\n') : 'No models loaded yet.'),
            );
          }
          return;
        }

        case 'compact': {
          const currentMessages = refs.messagesRef.current;
          if (isCurrentSessionStreaming) {
            addSystem('Stop the current response before running /compact.');
            return;
          }
          if (isCompactingRef.current) {
            addSystem('Compaction is already in progress.');
            return;
          }
          if (!refs.modelRef.current.trim()) {
            addSystem('Select a model before running /compact.');
            return;
          }
          if (currentMessages.length <= 1) {
            addSystem('Nothing to compact yet — continue the conversation and try again.');
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
                model: refs.modelRef.current,
                numCtx: refs.numCtxRef.current,
                baseUrl: refs.baseUrlRef.current,
                compactionModel: refs.compactionModelRef.current,
                sessionId: refs.sessionIdRef.current,
              }),
            });

            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
            if (!Array.isArray(data?.messages)) throw new Error('Compaction returned an invalid message list.');

            dispatch({ type: 'SET_MESSAGES', messages: data.messages as ChatMessage[] });
            if (typeof data?.stats?.newTokenCount === 'number') {
              dispatch({
                type: 'SET_TOKEN_STATS',
                stats: {
                  promptEvalCount: data.stats.newTokenCount,
                  evalCount: 0,
                  totalTokens: data.stats.newTokenCount,
                  tokenLimit: refs.numCtxRef.current,
                },
              });
            }
            const oldTokens = data.stats?.oldTokenCount;
            const newTokens = data.stats?.newTokenCount;
            if (typeof oldTokens === 'number' && typeof newTokens === 'number') {
              const saved = oldTokens - newTokens;
              const pct = oldTokens > 0 ? ((saved / oldTokens) * 100).toFixed(1) : '0.0';
              addSystem(`⚡ **Conversation compacted:** ${oldTokens.toLocaleString()} → ${newTokens.toLocaleString()} tokens (−${saved.toLocaleString()}, ${pct}% reduction)`);
              if (newTokens > refs.numCtxRef.current) {
                addSystem(`⚠️ Compaction reduced the history but it is still over the current context limit (${newTokens.toLocaleString()}/${refs.numCtxRef.current.toLocaleString()} tokens). The next turn may fail.`);
              }
            } else {
              addSystem(`⚡ Conversation compacted (${oldTokens ?? '?'} → ${newTokens ?? '?'} tokens)`);
            }
            await loadSessions();
          } catch (error) {
            addSystem(`Compaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          } finally {
            isCompactingRef.current = false;
            setIsCompacting(false);
          }
          return;
        }

        case 'title': {
          const currentMessages = refs.messagesRef.current;
          if (isCurrentSessionStreaming) {
            addSystem('Stop the current response before running /title.');
            return;
          }
          if (isCompactingRef.current) {
            addSystem('Wait for compaction to finish before running /title.');
            return;
          }
          if (isGeneratingTitleRef.current) {
            addSystem('Title generation is already in progress.');
            return;
          }
          if (!refs.modelRef.current.trim()) {
            addSystem('Select a model before running /title.');
            return;
          }
          if (currentMessages.length <= 1) {
            addSystem('Not enough conversation history to generate a title yet.');
            return;
          }
          if (!refs.sessionIdRef.current) {
            addSystem('This conversation does not have a saved session yet. Send a message and wait for the reply first.');
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
                model: refs.modelRef.current,
                numCtx: refs.numCtxRef.current,
                baseUrl: refs.baseUrlRef.current,
                compactionModel: refs.compactionModelRef.current,
                sessionId: refs.sessionIdRef.current,
              }),
            });

            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
            if (typeof data?.title !== 'string' || data.title.trim().length === 0) {
              throw new Error('Title generation returned an invalid title.');
            }

            await loadSessions();
            addSystem(`Session title updated to: ${data.title}`);
          } catch (error) {
            addSystem(`Title generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          } finally {
            isGeneratingTitleRef.current = false;
            setIsGeneratingTitle(false);
          }
          return;
        }

        case 'dump': {
          const currentMessages = refs.messagesRef.current;
          if (isCurrentSessionStreaming) {
            addSystem('Stop the current response before running /dump.');
            return;
          }
          if (isCompactingRef.current) {
            addSystem('Wait for compaction to finish before running /dump.');
            return;
          }
          if (isGeneratingTitleRef.current) {
            addSystem('Wait for title generation to finish before running /dump.');
            return;
          }
          if (!refs.modelRef.current.trim()) {
            addSystem('Select a model before running /dump.');
            return;
          }

          try {
            const response = await fetch('/api/dump', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: currentMessages,
                model: refs.modelRef.current,
                numCtx: refs.numCtxRef.current,
                baseUrl: refs.baseUrlRef.current,
                sessionId: refs.sessionIdRef.current,
              }),
            });

            if (!response.ok) {
              throw new Error(await readErrorMessage(response));
            }

            const markdown = await response.text();
            const fileName = parseDownloadFileName(response.headers.get('content-disposition'));
            triggerDownload(markdown, fileName);
          } catch (error) {
            addSystem(`Conversation dump failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
          return;
        }

        case 'nudge': {
          await sendChatMessage(buildToolUseNudge(refs.yoloRef.current));
          return;
        }

        case 'ctx': {
          const size = parseInt(args, 10);
          if (!args || isNaN(size) || size <= 0) {
            addSystem('Usage: /ctx <size> (e.g., /ctx 8192)');
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
            addSystem(`Context size set to ${size}`);
          }
          return;
        }

        default: {
          addSystem(`Unknown command: /${command}. Type /help for available commands.`);
          return;
        }
      }
    },
    [
      dispatch,
      refs,
      isCurrentSessionStreaming,
      isCompactingRef,
      isGeneratingTitleRef,
      setIsCompacting,
      setIsGeneratingTitle,
      onOpenSettings,
      loadSessions,
      sendChatMessage,
      state.sessions,
    ],
  );

  return { handleSlashCommand };
}
