'use client';

import { type EventSourceMessage, EventSourceParserStream } from 'eventsource-parser/stream';
import { type Dispatch, type SetStateAction, useCallback } from 'react';

import { type ChatMessage, useChat } from '@/app/lib/chatStore';
import { IMAGE_TOKEN_ESTIMATE } from '@/constants';
import { buildToolUseNudge } from '@/services/toolUseNudge';

import type { StableRefs, WritableRef } from './useStableRefs';

/**
 * Sentinel key under which the in-flight /compact, /title, and /dump
 * AbortControllers are registered in `abortControllersRef`. Real session
 * IDs are positive integers (the DB primary key), so a negative sentinel
 * cannot collide. The Stop button iterates every value in the map, so
 * registering here means the user can cancel these long-running commands
 * with the same button that aborts a chat stream.
 */
export const COMPACTION_ABORT_KEY = Number.MIN_SAFE_INTEGER;

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

interface SlashCommandDeps {
  refs: StableRefs;
  isCurrentSessionStreaming: boolean;
  isCompactingRef: WritableRef<boolean>;
  isGeneratingTitleRef: WritableRef<boolean>;
  abortControllersRef: WritableRef<Map<number, AbortController>>;
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
  abortControllersRef,
  setIsCompacting,
  setIsGeneratingTitle,
  onOpenSettings,
  loadSessions,
  sendChatMessage,
}: SlashCommandDeps) {
  const { dispatch } = useChat();

  const parseDownloadFileName = (contentDisposition: string | null): string => {
    if (!contentDisposition) {
      return 'locopilot-history.md';
    }

    const filenameStarMatch = contentDisposition.match(/filename\*=utf-8''([^;]+)/i);
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

    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    globalThis.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
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
              '/clear-images - Remove image attachments to free context\n' +
              '/mcp       - List MCP servers, /mcp reload, or /mcp auth <server>\n' +
              '/model [name] - Switch LLM model\n' +
              '/compact   - Summarise conversation history\n' +
              '/title     - Generate a title for current session\n' +
              '/dump      - Export conversation to markdown file\n' +
              '/sessions  - List and switch sessions\n' +
              '/delete    - Delete a session\n' +
              '/settings  - Open settings modal\n' +
              '/new       - Start a fresh conversation\n' +
              '/nudge     - Manually remind AI to use tools'
          );
          return;
        }

        case 'clear': {
          dispatch({ type: 'CLEAR_MESSAGES' });
          return;
        }

        case 'clear-images': {
          if (isCurrentSessionStreaming) {
            addSystem('Stop the current response before running /clear-images.');
            return;
          }

          const currentMessages = refs.messagesRef.current;
          const sessionId = refs.sessionIdRef.current;

          // Count images to report
          let removedImages = 0;
          let removedMessages = 0;
          for (const m of currentMessages) {
            if (m.images && m.images.length > 0) {
              removedImages += m.images.length;
              removedMessages += 1;
            }
          }

          if (removedImages === 0) {
            addSystem('No image attachments to clear.');
            return;
          }

          if (sessionId) {
            // Server-first: call API, then apply the server's cleaned messages
            try {
              const response = await fetch('/api/clear-images', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId }),
              });
              if (!response.ok) {
                const errText = await response.text().catch(() => `HTTP ${response.status}`);
                addSystem(`Failed to clear images on server: ${errText}`);
                return;
              }
              const data = (await response.json().catch(() => null)) as {
                messages?: ChatMessage[];
                removedImages?: number;
                removedMessages?: number;
              } | null;
              if (data && Array.isArray(data.messages)) {
                removedImages = data.removedImages ?? removedImages;
                removedMessages = data.removedMessages ?? removedMessages;
                dispatch({ type: 'SET_MESSAGES', messages: data.messages });
              } else {
                // Fallback: server didn't return messages, strip client-side
                const stripped = currentMessages.map((m) => {
                  if (m.images && m.images.length > 0) {
                    const { images: _images, ...rest } = m;
                    return rest as ChatMessage;
                  }
                  return m;
                });
                dispatch({ type: 'SET_MESSAGES', messages: stripped });
              }
            } catch (err) {
              addSystem(
                `Failed to clear images: ${err instanceof Error ? err.message : 'Unknown error'}`
              );
              return;
            }
          } else {
            // No session ID (unsaved session) — strip client-side only
            const stripped = currentMessages.map((m) => {
              if (m.images && m.images.length > 0) {
                const { images: _images, ...rest } = m;
                return rest as ChatMessage;
              }
              return m;
            });
            dispatch({ type: 'SET_MESSAGES', messages: stripped });
          }

          const freedTokens = removedImages * IMAGE_TOKEN_ESTIMATE;
          addSystem(
            `🖼️ **Cleared image attachments:** ${removedImages} image${removedImages === 1 ? '' : 's'} ` +
              `from ${removedMessages} message${removedMessages === 1 ? '' : 's'}. ` +
              `(~${freedTokens.toLocaleString()} tokens freed)`
          );
          return;
        }

        case 'new': {
          dispatch({ type: 'CLEAR_MESSAGES' });
          dispatch({ type: 'SET_CURRENT_SESSION', id: null });
          await loadSessions();
          addSystem('Started a new conversation.');
          return;
        }

        case 'settings': {
          onOpenSettings();
          addSystem('Settings opened.');
          return;
        }

        case 'sessions': {
          const sessions = refs.sessionsRef.current;
          if (sessions.length === 0) {
            addSystem('No saved sessions yet.');
          } else {
            addSystem(
              `Saved sessions:\n${ 
                sessions.map((s) => `[${s.id}] ${s.name} (${s.model})`).join('\n') 
                }\n\nClick a session in the sidebar to switch.`
            );
          }
          return;
        }

        case 'delete': {
          const sessions = refs.sessionsRef.current;
          if (sessions.length === 0) {
            addSystem('No saved sessions to delete.');
            return;
          }
          if (args) {
            const id = Number.parseInt(args, 10);
            if (Number.isNaN(id)) {
              addSystem('Usage: /delete <session_id>');
            } else {
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
            }
          } else {
            addSystem(
              `Usage: /delete <session_id>\nSessions:\n${ 
                sessions.map((s) => `[${s.id}] ${s.name}`).join('\n')}`
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
            const modelNames = availableModels.map((m) => (typeof m === 'string' ? m : m.name));
            addSystem(
              `Available models:\n${ 
                modelNames.length > 0
                  ? modelNames.map((m) => `- ${m}`).join('\n')
                  : 'No models loaded yet.'}`
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

          // Capture the session ID now, before the async fetch. If the user
          // switches sessions while compaction is in-flight, targetSessionId
          // ensures the result lands in the correct session slot rather than
          // overwriting whatever session happens to be active at resolve-time.
          const compactSessionId = refs.sessionIdRef.current;
          isCompactingRef.current = true;
          setIsCompacting(true);
          // Clear any stale phases from previous compactions so the indicator
          // starts fresh.
          dispatch({ type: 'CLEAR_COMPACT_PROGRESS' });

          // Register an AbortController under a sentinel key so the Stop
          // button (which iterates every value in the map) can also cancel
          // this long-running SSE stream. Real session IDs are positive
          // integers, so a negative sentinel cannot collide.
          const abortController = new AbortController();
          abortControllersRef.current.set(COMPACTION_ABORT_KEY, abortController);
          let reader: ReadableStreamDefaultReader<EventSourceMessage> | null = null;
          try {
            const response = await fetch('/api/compact', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: currentMessages,
                model: refs.modelRef.current,
                numCtx: refs.requestedNumCtxRef.current,
                baseUrl: refs.baseUrlRef.current,
                compactionModel: refs.compactionModelRef.current,
                sessionId: compactSessionId,
              }),
              signal: abortController.signal,
            });

            if (!response.ok) {
              const errorData = await response.json().catch(() => null);
              throw new Error(errorData?.error ?? `HTTP ${response.status}`);
            }
            if (!response.body) throw new Error('Compaction returned no response body.');

            // Parse the SSE stream for live compaction progress updates.
            const eventStream = response.body
              .pipeThrough(new TextDecoderStream())
              .pipeThrough(new EventSourceParserStream());

            reader = eventStream.getReader();
            let compactData: {
              messages: ChatMessage[];
              stats: { oldTokenCount?: number; newTokenCount?: number };
            } | null = null;
            let errorMessage: string | null = null;

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const event = value.event || 'message';
              try {
                const parsed = JSON.parse(value.data);
                if (event === 'compact_progress' && typeof parsed.message === 'string') {
                  dispatch({ type: 'COMPACT_PROGRESS', message: parsed.message });
                } else if (event === 'compact' && Array.isArray(parsed.messages)) {
                  compactData = parsed;
                } else if (event === 'error' && typeof parsed.message === 'string') {
                  errorMessage = parsed.message;
                }
              } catch {
                // Ignore malformed SSE frames
              }
            }

            if (errorMessage) throw new Error(errorMessage);
            if (!compactData) throw new Error('Compaction returned an invalid response.');

            dispatch({
              type: 'SET_MESSAGES',
              messages: compactData.messages as ChatMessage[],
              ...(compactSessionId === null ? {} : { targetSessionId: compactSessionId }),
            });
            if (typeof compactData.stats?.newTokenCount === 'number') {
              dispatch({
                type: 'SET_TOKEN_STATS',
                stats: {
                  promptEvalCount: compactData.stats.newTokenCount,
                  evalCount: 0,
                  totalTokens: compactData.stats.newTokenCount,
                  tokenLimit: refs.requestedNumCtxRef.current,
                },
                ...(compactSessionId === null ? {} : { targetSessionId: compactSessionId }),
              });
            }
            const oldTokens = compactData.stats?.oldTokenCount;
            const newTokens = compactData.stats?.newTokenCount;
            if (typeof oldTokens === 'number' && typeof newTokens === 'number') {
              const saved = oldTokens - newTokens;
              const pct = oldTokens > 0 ? ((saved / oldTokens) * 100).toFixed(1) : '0.0';
              addSystem(
                `⚡ **Conversation compacted:** ${oldTokens.toLocaleString()} → ${newTokens.toLocaleString()} tokens (−${saved.toLocaleString()}, ${pct}% reduction)`
              );
              // Compare against the server's effective cap (the
              // value the next turn will actually use), not the
              // user's raw requested value. If the server has not
              // yet reported a cap, fall back to the requested
              // value; this is a display-only check, so the worst
              // case is a slightly conservative warning.
              const capForWarning = Math.min(
                refs.requestedNumCtxRef.current,
                refs.effectiveNumCtxRef.current
              );
              if (newTokens > capForWarning) {
                addSystem(
                  `⚠️ Compaction reduced the history but it is still over the current context limit (${newTokens.toLocaleString()}/${capForWarning.toLocaleString()} tokens). The next turn may fail.`
                );
              }
            } else {
              addSystem(
                `⚡ Conversation compacted (${oldTokens ?? '?'} → ${newTokens ?? '?'} tokens)`
              );
            }
            await loadSessions();
          } catch (err) {
            if (isAbortError(err)) {
              addSystem('Compaction cancelled.');
            } else {
              addSystem(
                `Compaction failed: ${err instanceof Error ? err.message : 'Unknown error'}`
              );
            }
          } finally {
            // Cancel the reader so an in-flight read() unblocks if the
            // controller was aborted, then unregister.
            if (reader) {
              try {
                await reader.cancel();
              } catch {
                // Ignore — the stream may already be closed.
              }
            }
            if (abortControllersRef.current.get(COMPACTION_ABORT_KEY) === abortController) {
              abortControllersRef.current.delete(COMPACTION_ABORT_KEY);
            }
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
          const nonSystemMessages = currentMessages.filter((m: ChatMessage) => m.role !== 'system');
          if (nonSystemMessages.length <= 1) {
            addSystem('Not enough conversation history to generate a title yet.');
            return;
          }
          if (!refs.sessionIdRef.current) {
            addSystem(
              'This conversation does not have a saved session yet. Send a message and wait for the reply first.'
            );
            return;
          }

          isGeneratingTitleRef.current = true;
          setIsGeneratingTitle(true);

          // Register an AbortController under a sentinel key so the Stop
          // button can cancel title generation alongside chat streams.
          const abortController = new AbortController();
          abortControllersRef.current.set(COMPACTION_ABORT_KEY, abortController);
          try {
            const response = await fetch('/api/title', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: refs.modelRef.current,
                numCtx: refs.requestedNumCtxRef.current,
                baseUrl: refs.baseUrlRef.current,
                compactionModel: refs.compactionModelRef.current,
                sessionId: refs.sessionIdRef.current,
                think: refs.thinkingEnabledRef.current,
              }),
              signal: abortController.signal,
            });

            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
            if (typeof data?.title !== 'string' || data.title.trim().length === 0) {
              throw new Error('Title generation returned an invalid title.');
            }

            await loadSessions();
          } catch (err) {
            if (!isAbortError(err)) {
              dispatch({
                type: 'SET_ERROR',
                error: `Title generation failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
              });
            }
          } finally {
            if (abortControllersRef.current.get(COMPACTION_ABORT_KEY) === abortController) {
              abortControllersRef.current.delete(COMPACTION_ABORT_KEY);
            }
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

          // Register an AbortController under a sentinel key so the Stop
          // button can cancel /dump alongside chat streams.
          const abortController = new AbortController();
          abortControllersRef.current.set(COMPACTION_ABORT_KEY, abortController);
          try {
            const response = await fetch('/api/dump', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: currentMessages,
                model: refs.modelRef.current,
                numCtx: refs.requestedNumCtxRef.current,
                baseUrl: refs.baseUrlRef.current,
                sessionId: refs.sessionIdRef.current,
              }),
              signal: abortController.signal,
            });

            if (!response.ok) {
              throw new Error(await readErrorMessage(response));
            }
            if (abortController.signal.aborted) {
              return;
            }

            const markdown = await response.text();
            const fileName = parseDownloadFileName(response.headers.get('content-disposition'));
            triggerDownload(markdown, fileName);
          } catch (err) {
            if (!isAbortError(err)) {
              addSystem(
                `Conversation dump failed: ${err instanceof Error ? err.message : 'Unknown error'}`
              );
            }
          } finally {
            if (abortControllersRef.current.get(COMPACTION_ABORT_KEY) === abortController) {
              abortControllersRef.current.delete(COMPACTION_ABORT_KEY);
            }
          }
          return;
        }

        case 'nudge': {
          await sendChatMessage(buildToolUseNudge(refs.yoloRef.current));
          return;
        }

        case 'mcp': {
          const subCommand = (args.split(' ')[0] ?? '').toLowerCase();
          if (subCommand === 'reload') {
            try {
              const response = await fetch('/api/mcp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'reload' }),
              });
              if (!response.ok) {
                throw new Error(await readErrorMessage(response));
              }
              addSystem('🔄 MCP servers reloaded.');
            } catch (err) {
              addSystem(
                `MCP reload failed: ${err instanceof Error ? err.message : 'Unknown error'}`
              );
            }
            return;
          }
          if (subCommand === 'auth') {
            const target = args.split(' ').slice(1).join(' ').trim();
            if (!target) {
              addSystem(
                'Usage: /mcp auth <server>\n\nRe-authenticates the named MCP server with OAuth 2.1 + PKCE. The auth URL is printed to the locopilot dev-server stderr; if you are running the chat UI, the "needs auth" pill in the MCP tab is also a click-to-authenticate shortcut.'
              );
              return;
            }
            // Bug #11 fix: client-side server-name validation
            // mirrors the API route's `VALID_NAME_REGEX` so a
            // typo gives an immediate, in-context error rather
            // than a 400 round-trip. The API also validates,
            // so this is belt-and-suspenders.
            if (!/^[\w-]+$/i.test(target)) {
              addSystem(
                `MCP auth failed: server name "${target}" is invalid (must match /^[a-z0-9_-]+$/i).`
              );
              return;
            }
            try {
              const response = await fetch('/api/mcp/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ server: target }),
              });
              const data = (await response.json().catch(() => ({}))) as {
                ok?: boolean;
                error?: string;
                connected?: boolean;
              };
              if (!response.ok || data.ok !== true) {
                throw new Error(data.error ?? `HTTP ${response.status}`);
              }
              if (data.connected === true) {
                addSystem(`✅ MCP server "${target}" authenticated and connected.`);
              } else {
                addSystem(
                  `🔐 MCP server "${target}" requires authorization.\n` +
                    `Open the URL printed in the locopilot dev-server stderr in your browser, then come back here. The connection will retry automatically once you approve.\n` +
                    `(You can also paste the captured "code" parameter back via: /mcp auth-code)`
                );
              }
            } catch (err) {
              addSystem(
                `MCP auth failed: ${err instanceof Error ? err.message : 'Unknown error'}`
              );
            }
            return;
          }
          if (subCommand && subCommand !== 'list') {
            addSystem(
              'Usage: /mcp [list|reload|auth <server>]\n\n/mcp list   - show configured servers and their tools\n/mcp reload - close all clients and re-read mcp.json\n/mcp auth <server> - re-authenticate an OAuth-protected server'
            );
            return;
          }
          try {
            const response = await fetch('/api/mcp', { method: 'GET' });
            if (!response.ok) {
              throw new Error(await readErrorMessage(response));
            }
            const data = (await response.json()) as {
              servers?: Array<{
                name: string;
                status: string;
                transport: string;
                description?: string;
                lastError?: string;
                toolCount: number;
                tools: Array<{ name: string; description?: string; fullName: string }>;
                authUrl?: string;
              }>;
            };
            const servers = data.servers ?? [];
            if (servers.length === 0) {
              addSystem(
                'No MCP servers configured. Add a `mcpServers` block to `~/.locopilot/mcp.json` to get started.'
              );
              return;
            }
            const lines: string[] = ['MCP servers (from ~/.locopilot/mcp.json):'];
            for (const server of servers) {
              const statusEmoji =
                server.status === 'connected'
                  ? '🟢'
                  : server.status === 'connecting'
                    ? '🟡'
                    : server.status === 'error'
                      ? '🔴'
                      : server.status === 'auth_required'
                        ? '🔐'
                        : server.status === 'not_loaded'
                          ? '⚪'
                          : '⚪';
              const desc = server.description ? ` — ${server.description}` : '';
              lines.push(
                `  ${statusEmoji} ${server.name} [${server.transport}] (${server.status}, ${server.toolCount} tool${server.toolCount === 1 ? '' : 's'})${desc}`
              );
              if (server.lastError) {
                lines.push(`      last error: ${server.lastError}`);
              }
              if (server.status === 'auth_required') {
                lines.push(`      run /mcp auth ${server.name} to re-authenticate`);
              }
              for (const tool of server.tools) {
                const toolDesc = tool.description ? ` — ${tool.description}` : '';
                lines.push(`      • ${tool.fullName}${toolDesc}`);
              }
            }
            lines.push('\nUse /mcp reload after editing mcp.json to apply changes.', 'Use /mcp auth <server> to re-authenticate an OAuth-protected server.');
            addSystem(lines.join('\n'));
          } catch (err) {
            addSystem(
              `MCP list failed: ${err instanceof Error ? err.message : 'Unknown error'}`
            );
          }
          return;
        }

        case 'ctx': {
          const size = Number.parseInt(args, 10);
          if (!args || Number.isNaN(size) || size <= 0) {
            addSystem('Usage: /ctx <size> (e.g., /ctx 8192)');
          } else {
            dispatch({ type: 'SET_CONFIG', config: { requestedNumCtx: size } });
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
      abortControllersRef,
      setIsCompacting,
      setIsGeneratingTitle,
      onOpenSettings,
      loadSessions,
      sendChatMessage,
    ]
  );

  return { handleSlashCommand };
}
