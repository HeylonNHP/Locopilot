/**
 * POST /api/chat – Streaming AI chat route with tool-calling loop.
 *
 * The client sends:
 *   { messages, model, numCtx?, sessionId?, baseUrl?, think?,
 *     completionMode?, maxPromptLoopIterations? }
 *
 * The server runs the full AI agent loop (LLM → tools → LLM → …) and
 * streams back Server-Sent Events (SSE) for every incremental update.
 *
 * Full SSE contract (event names and payload shapes) lives in
 * src/types/sse.ts so the producer and consumers stay in sync.
 * Highlights:
 *   event: thinking\ndata: {"content":"…"}\n\n
 *   event: chunk\ndata: {"content":"…"}\n\n
 *   event: tool_call\ndata: {"name":"…","arguments":{…}}\n\n
 *   event: tool_result\ndata: {"name":"…","result":"…","duration":123}\n\n
 *   event: status\ndata: {"phase":"thinking"|"responding"|"tools"|"truncated"|"completeness-check","tokensUsed":N,"tokenLimit":N}\n\n
 *   event: done\ndata: {"content":"…","thinking":"…","sessionId":N,"tokenStats":{…},"doneReason":"stop"|"length"}\n\n
 *   event: error\ndata: {"message":"…"}\n\n
 */

import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';

import type { DoneReason } from '@/app/lib/chatStore';
import type { ToolDefinition } from '@/services/adapters/llmAdapter';

import {
  type ApprovalDecision,
  resolveApproval,
  waitForApproval,
} from '@/app/lib/approvalRegistry';
import { debugLog } from '@/app/lib/debugLogger';
import { logger } from '@/app/lib/logger';
import {
  consumeModelSwitch,
  registerActiveTurn,
  unregisterActiveTurn,
} from '@/app/lib/modelSwitchRegistry';
import { enqueueSessionRename, enqueueSessionWrite } from '@/app/lib/sessionWriteQueue';
import {
  AUTO_COMPACT_THRESHOLD_PCT,
  DEFAULT_NUM_CTX,
  DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
  DEFAULT_SESSION_NAME,
  DEFAULT_WEB_SEARCH_MAX_QUERIES,
  DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
  DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY,
  HTTP_BAD_REQUEST,
  MCP_TOOL_SEARCH_THRESHOLD,
  SSE_CONTENT_TYPE,
  TPS_STATUS_MIN_INTERVAL_MS,
} from '@/constants';
import {
  getMCPToolCount,
  getMergedMCPToolDefinitions,
  getMergedMCPToolDefinitionsForSearch,
  parseMCPToolName,
} from '@/mcp';
import { recordDiscoveredCap, resolveEffectiveNumCtx } from '@/services/capResolver';
import { createSystemPrompt } from '@/services/chatSession';
import {
  compactHistory,
  COMPACTION_ADAPTIVE_DIRECTIVE,
  COMPACTION_ADAPTIVE_DIRECTIVE_THRESHOLD,
  SYNTHETIC_NUDGE_END,
  SYNTHETIC_NUDGE_MARKER,
} from '@/services/compact';
import {
  DEFAULT_MAX_PROMPT_LOOP_ITERATIONS,
  DEFAULT_OLLAMA_BASE_URL,
} from '@/services/configDefaults';
import { loadConfig } from '@/services/configManager';
import { createSession, getSessionName, renameSession, sessionExists } from '@/services/history';
import {
  buildLlmRequestContext,
  type ChatMessage,
  fetchLlmModelInfo,
  getLlmApiErrorMessage,
  getLlmModelSamplingParamSupportAsync,
  getLlmModelVisionSupportAsync,
  type LlmRequestContext,
  type PersistedChatMessage,
  recordDiscoveredUnsupportedParam,
  type SamplingParamName,
  selectLlmAdapter,
  sendLlmChatStream,
  type StreamChatParams,
} from '@/services/llm';
import {
  parseContextLimitFromError,
  parseUnsupportedParamFromError,
  parseVisionUnsupportedFromError,
} from '@/services/llmContextLimit';
import { resolveCompactionModel } from '@/services/modelManager';
import { checkCompleteness } from '@/services/promptLoop';
import { getProviderNumCtx, resolveProviderRequestContext } from '@/services/providerResolver';
import {
  discoverSkills,
  getAllowedToolsFromSkills,
  getEnabledSkills,
  loadSkillState,
} from '@/services/skillManager';
import { sanitizeChatMessage, stripSpecialTokens } from '@/services/textUtils';
import { generateSessionTitle, sanitizeContentForTitle } from '@/services/titleGeneration';
import { generateFallbackTitle } from '@/services/titleUtils';
import { countMessagesTokens, countTextTokens } from '@/services/tokenizer';
import { buildUserMessageStamp } from '@/services/userMessageStamp';
import { recordDiscoveredNonVision } from '@/services/visionCache';
import { filterGrantedMCPTools, isAutoApprovedMCPTarget } from '@/tools/impl/mcpTool';
import { enterRequestScope } from '@/tools/impl/runCommandTool';
import {
  handleToolCall,
  type RequestContext,
  sanitize,
  type ToolOutputSink,
  TOOLS,
} from '@/tools/tools';
import { WorkingDirectoryScope } from '@/tools/workingDirectory';
import {
  type Config,
  isReasoningEffort,
  type ProviderConfig,
  type ReasoningEffort,
} from '@/types/chatConfig';

import { createSseStream, isRetryableError } from './sseStream';

// Prevent static generation – this route must always run on the server.
export const dynamic = 'force-dynamic';

const MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 3;
const CHANNEL_LABEL_ONLY_PATTERN = /^\s*(?:thought|analysis|final|commentary)\s*$/i;
const VALID_DONE_REASONS = new Set(['stop', 'length', 'load', 'unload']);

/**
 * The standard sampling-param registry the openai-compatible adapter
 * materializes onto outgoing requests. Re-exported here so the chat
 * route's reactive 400-driven discovery block can map an upstream's
 * param name onto a known entry without re-importing the registry
 * from the cache module.
 */
const KNOWN_SAMPLING_PARAMS = new Set<string>([
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'stop',
  'logit_bias',
]);

function isKnownSamplingParam(name: string): boolean {
  return KNOWN_SAMPLING_PARAMS.has(name);
}

/** Client message shape: the LLM-protocol ChatMessage plus the UI-only subagent_log role. */
type ClientChatMessage =
  | ChatMessage
  | { role: 'subagent_log'; content: string; subagentId?: string };

function isClientChatMessage(value: unknown): value is ClientChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  if (typeof msg.role !== 'string' || typeof msg.content !== 'string') return false;
  if (msg.role === 'subagent_log') return true;
  return (
    msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
  );
}

/** Compare two persisted messages for the initial-state merge. */
function messagesEqual(a: PersistedChatMessage, b: PersistedChatMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.content !== b.content) return false;
  if (a.role === 'subagent_log' && b.role === 'subagent_log') {
    return (
      (a as { role: 'subagent_log'; subagentId?: string }).subagentId ===
      (b as { role: 'subagent_log'; subagentId?: string }).subagentId
    );
  }
  if (a.role === 'tool' || b.role === 'tool') {
    // Tool messages are identified by tool_call_id. Content is already
    // compared above, but we repeat the check here so this branch is
    // self-contained and defensive against display-only client artifacts
    // that may share a position but have a different payload.
    const aTool = a as { role: 'tool'; tool_call_id?: string; content: string };
    const bTool = b as { role: 'tool'; tool_call_id?: string; content: string };
    if (aTool.tool_call_id !== bTool.tool_call_id) return false;
    if (aTool.content !== bTool.content) return false;
    return true;
  }
  const aMsg = a as ChatMessage;
  const bMsg = b as ChatMessage;
  if (aMsg.tool_calls || bMsg.tool_calls) {
    return JSON.stringify(aMsg.tool_calls) === JSON.stringify(bMsg.tool_calls);
  }
  return true;
}

/**
 * Merge the client's view of the conversation into the freshly-loaded DB state.
 * Preserves any messages already persisted (e.g. from a concurrent tab) and
 * appends only the client messages that are new, including subagent_log entries.
 */
function mergeClientMessages(
  fresh: PersistedChatMessage[],
  client: PersistedChatMessage[]
): PersistedChatMessage[] {
  let prefix = 0;
  const maxPrefix = Math.min(fresh.length, client.length);
  while (prefix < maxPrefix && messagesEqual(fresh[prefix]!, client[prefix]!)) {
    prefix++;
  }
  return [
    ...fresh,
    ...client.slice(prefix).filter((message) => {
      // Client-only messages have no durable identity yet and must be appended.
      // A numeric ID that is absent from fresh was removed or replaced while
      // this request was in flight; do not resurrect that stale row.
      return (
        typeof message.id !== 'number' || fresh.some((persisted) => persisted.id === message.id)
      );
    }),
  ];
}

function sanitizeAssistantTextFragment(text: string): string {
  const cleaned = stripSpecialTokens(text ?? '');
  return CHANNEL_LABEL_ONLY_PATTERN.test(cleaned.trim()) ? '' : cleaned;
}

/**
 * Build the LLM-bound copy of a user message. When the promptTimestamps
 * toggle is on and the message carries a createdAt, prepend a
 * `[Sent YYYY-MM-DD HH:MM]` header so the LLM can reason about elapsed
 * time. The `createdAt` field itself is stripped from the result so it
 * does not leak into the LLM payload as an unknown JSON key. Returns the
 * message unchanged when the toggle is off, the role is not user, or no
 * createdAt is available.
 */
function maybeInjectPromptTimestamp(
  message: ChatMessage,
  promptTimestampsEnabled: boolean
): ChatMessage {
  if (!promptTimestampsEnabled) return message;
  if (message.role !== 'user') return message;
  if (typeof message.createdAt !== 'string') return message;

  const stamp = buildUserMessageStamp(new Date(message.createdAt));
  if (message.content.startsWith(stamp)) return message;

  const { createdAt: _createdAt, ...rest } = message;
  void _createdAt;
  return { ...rest, content: `${stamp}\n${message.content}` };
}

function hasMeaningfulAssistantContent(message: ChatMessage): boolean {
  const cleanedContent = sanitizeAssistantTextFragment(message.content ?? '').trim();
  if (cleanedContent.length === 0) {
    return false;
  }

  return !CHANNEL_LABEL_ONLY_PATTERN.test(cleanedContent);
}

export async function POST(req: NextRequest): Promise<Response> {
  // Per-request correlation ID for debug tracing.
  const requestId = randomUUID();
  // Build a context object for debugLog that only includes sessionId when defined
  // (required because exactOptionalPropertyTypes forbids explicit undefined).
  const logCtx = (sid: number | undefined): { requestId: string; sessionId?: number } => ({
    requestId,
    ...(sid === undefined ? {} : { sessionId: sid }),
  });
  // ── Parse & validate the request body ──────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ message: 'Invalid JSON body' })}\n\n`,
      {
        status: HTTP_BAD_REQUEST,
        headers: { 'Content-Type': SSE_CONTENT_TYPE },
      }
    );
  }

  const messages: ClientChatMessage[] = body.messages as ClientChatMessage[];
  // Mutable for the whole turn: /api/chat/switch-model can hot-swap the
  // model between tool-call loop iterations. See applyPendingModelSwitch.
  let model: string = body.model as string;
  const numCtx: number | undefined = body.numCtx as number | undefined;
  const sessionId: number | undefined = body.sessionId as number | undefined;
  const baseUrl: string | undefined = body.baseUrl as string | undefined;
  const providerId: string | undefined =
    typeof body.providerId === 'string' ? body.providerId : undefined;
  const compactionProviderId: string | undefined =
    typeof body.compactionProviderId === 'string' ? body.compactionProviderId : undefined;
  const compactionModel: string | undefined =
    typeof body.compactionModel === 'string' ? body.compactionModel : undefined;
  const think: boolean | undefined = body.think as boolean | undefined;
  const reasoningEffortRaw: unknown = body.reasoningEffort;
  const reasoningEffort: ReasoningEffort | undefined = isReasoningEffort(reasoningEffortRaw)
    ? reasoningEffortRaw
    : undefined;
  const chatTimeoutMs: number | undefined = body.chatTimeoutMs as number | undefined;
  const completionMode: string | undefined = body.completionMode as string | undefined;
  const maxPromptLoopIterations: number | undefined = body.maxPromptLoopIterations as
    | number
    | undefined;

  // -- Validation ------------------------------------------------
  if (typeof model !== 'string' || !model.trim()) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ message: 'Model name is required' })}\n\n`,
      {
        status: HTTP_BAD_REQUEST,
        headers: { 'Content-Type': SSE_CONTENT_TYPE },
      }
    );
  }

  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isClientChatMessage)) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ message: 'Messages array is required and must contain valid message objects' })}\n\n`,
      {
        status: HTTP_BAD_REQUEST,
        headers: { 'Content-Type': SSE_CONTENT_TYPE },
      }
    );
  }

  const typedMessages: ClientChatMessage[] = messages;

  const effectiveBaseUrl =
    typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : DEFAULT_OLLAMA_BASE_URL;

  // The client's numCtx (from the request body) is treated as the user's
  // *requested* value. The actual effective value sent to the model is
  // resolved server-side by resolveEffectiveNumCtx (see below, after
  // config is loaded) so the clamp against the model's runtime cap is
  // never the client's responsibility. The fallback chain here mirrors
  // the priority the resolver will see: explicit per-request value,
  // persisted config value, then DEFAULT_NUM_CTX.
  const requestedNumCtx =
    typeof numCtx === 'number' && Number.isFinite(numCtx) && numCtx > 0
      ? Math.floor(numCtx)
      : DEFAULT_NUM_CTX;
  let effectiveNumCtx = requestedNumCtx;
  /** The model's runtime cap as known to the resolver, or null if unknown. */
  let modelContextLimit: number | null = null;

  const effectiveChatTimeoutMs =
    typeof chatTimeoutMs === 'number' && Number.isFinite(chatTimeoutMs) && chatTimeoutMs > 0
      ? Math.floor(chatTimeoutMs)
      : DEFAULT_OLLAMA_CHAT_TIMEOUT_MS;

  const parsedSessionId = typeof sessionId === 'number' ? sessionId : undefined;

  const effectiveCompletionMode =
    typeof completionMode === 'string' && completionMode === 'prompt-loop'
      ? 'prompt-loop'
      : 'normal';

  const effectiveMaxPromptLoopIterations =
    typeof maxPromptLoopIterations === 'number' && Number.isFinite(maxPromptLoopIterations)
      ? Math.max(0, Math.floor(maxPromptLoopIterations))
      : DEFAULT_MAX_PROMPT_LOOP_ITERATIONS;

  // Capture the last user-role message from the incoming request as the
  // "original user request" for the prompt-loop judge.
  let originalUserRequest: string | null = null;
  for (let i = typedMessages.length - 1; i >= 0; i--) {
    const m = typedMessages[i];
    if (!m) continue;
    if (m.role === 'user' && typeof m.content === 'string') {
      originalUserRequest = m.content;
      break;
    }
  }

  // Total judge checks across all outer-loop iterations (prevents counter
  // reset on continue outer).
  let promptLoopIterations = 0;

  const thinkEnabled = typeof think === 'boolean' ? think : undefined;

  // ── SSE streaming setup ───────────────────────────────────────────

  const stream = new ReadableStream({
    async start(controller): Promise<void> {
      // Create a per-request process registry so concurrent requests
      // cannot see each other's running commands.
      enterRequestScope();

      const { sendEvent, startKeepalive, stopKeepalive } = createSseStream(controller);
      debugLog.diagnostic({
        layer: 'route',
        phase: 'request_start',
        requestId,
        sessionId: parsedSessionId,
        model: model as string,
        baseUrl: effectiveBaseUrl,
        messageCount: typedMessages.length,
      });
      startKeepalive();

      // Strip any system messages from the client and inject a fresh system prompt
      // so the model always sees the current date, tool definitions, and policy.
      const conversationMessages: ClientChatMessage[] = structuredClone(typedMessages);

      let finalContent = '';
      let finalThinking = '';
      // Body compactionModel is authoritative when present, including an empty
      // string which explicitly means "same as the main model". Persisted config
      // is consulted only when the body omits the field.
      let effectiveCompactionModel: string = resolveCompactionModel(
        compactionModel,
        model as string
      );
      // Last authoritative token count from Ollama; used by the auto-compact
      // check so it stays anchored to the latest exact provider count.
      let lastAuthoritativeTokens = 0;
      // Whether YOLO mode is active (set from config below). When true,
      // run_command skips the approval gate and executes unconditionally.
      let effectiveYolo = false;
      // Whether the user wants the LLM to see a `[Sent …]` header on
      // each user-role message. Read from config below (default true).
      // The created_at column is always populated regardless of this
      // flag, so toggling it later retroactively changes LLM visibility
      // for every persisted message.
      let effectivePromptTimestamps = true;
      // Whether the user wants the model to cite web-research sources as
      // numbered links. Read from config below (default true). The numbered
      // SOURCES block is always appended to tool results; this flag gates the
      // system-prompt directive and the tool-result reminder.
      let effectiveCiteSources = true;
      let emptyResponseRecoveryAttempts = 0;
      // How many times auto-compaction has fired since this request (i.e.
      // since the user's last real prompt) began. Each real user message
      // starts a fresh request, so this counter needs no explicit reset —
      // it resets naturally per turn. Surfaced to the LLM in the
      // post-compaction nudge so it can adapt when it repeatedly hits the
      // context limit.
      let compactionsSinceLastPrompt = 0;
      // Server-generated messages that have not yet been persisted.
      // flushSessionState appends these to the fresh DB message list.
      // Compaction uses a full replacement instead.
      const pendingAppends: PersistedChatMessage[] = [];
      let pendingReplace: PersistedChatMessage[] | null = null;
      // Sub-agent log accumulation. The per-agent bubbles are client-only
      // during streaming; the subagentOutputSink appends every line/chunk
      // here so the tool-loop push site can persist one subagent_log row
      // per agentId alongside the run_subagents tool result. Without this
      // the end-of-turn client reload (which reads the DB) wipes the
      // bubbles the moment the turn completes.
      const subagentLogContent = new Map<string, string>();

      /** Build a subagent_log row and remove the agent from the pending map. */
      function takeSubagentRow(agentId: string): PersistedChatMessage {
        const row: PersistedChatMessage = {
          role: 'subagent_log',
          content: subagentLogContent.get(agentId) ?? '',
          subagentId: agentId,
        };
        subagentLogContent.delete(agentId);
        return row;
      }

      /**
       * Flush any remaining sub-agent log rows into pendingAppends. Used on
       * the abort/error paths where the run_subagents tool result push site
       * may never be reached.
       */
      function flushRemainingSubagentLogs(): void {
        for (const agentId of subagentLogContent.keys()) {
          pendingAppends.push(takeSubagentRow(agentId));
        }
      }

      async function flushSessionState(): Promise<{ ok: true } | { ok: false; error: string }> {
        if (activeSessionId === undefined) return { ok: true };
        const sessionId = activeSessionId;
        // Race: session may have been deleted mid-stream by another tab.
        if (!sessionExists(sessionId)) return { ok: true };

        if (pendingReplace) {
          const replacement = pendingReplace;
          try {
            await enqueueSessionWrite(sessionId, () => replacement, { promptEvalCount, evalCount });
          } catch (err) {
            // Keep `pendingReplace` so a later attempt can retry.
            // Note: `currentMessages` is not rolled back because the
            // replacement is already a complete, LLM-observed state
            // (e.g. after compaction) — removing it would break the
            // LLM stream mid-loop. The DB will diverge; surface the
            // error so the user can decide whether to retry.
            const message = err instanceof Error ? err.message : 'Unknown write error';
            sendEvent('write_error', { message });
            return { ok: false, error: message };
          }
          pendingReplace = null;
        } else if (pendingAppends.length > 0) {
          const appends = [...pendingAppends];
          try {
            await enqueueSessionWrite(sessionId, (fresh) => [...fresh, ...appends], {
              promptEvalCount,
              evalCount,
            });
          } catch (err) {
            // Keep `pendingAppends` so a later attempt can retry.
            // Note: `currentMessages` is not rolled back because the
            // newly-appended messages are the LLM's own assistant
            // turn and the tool results it must observe on the next
            // iteration. Removing them would break the LLM stream.
            // The DB will diverge; surface the error so the user
            // can decide whether to retry.
            const message = err instanceof Error ? err.message : 'Unknown write error';
            sendEvent('write_error', { message });
            return { ok: false, error: message };
          }
          pendingAppends.length = 0;
        }
        return { ok: true };
      }

      const systemMessage: ChatMessage = {
        role: 'system',
        content: createSystemPrompt(undefined, effectiveYolo, effectiveCiteSources),
      };

      // Snapshot the client's original non-system messages in their original order.
      // These include subagent_log messages which are NOT sent to the LLM.
      const originalClientMessages: ClientChatMessage[] = conversationMessages.filter(
        (m): m is ClientChatMessage =>
          typeof m === 'object' &&
          m !== null &&
          'role' in m &&
          typeof (m as { role: unknown }).role === 'string' &&
          (m as { role: string }).role !== 'system' &&
          typeof (m as { content: unknown }).content === 'string'
      );

      // Build the LLM working array: system prompt + client messages excluding subagent_log.
      const currentMessages: ChatMessage[] = [
        systemMessage,
        ...originalClientMessages.filter((m): m is ChatMessage => m.role !== 'subagent_log'),
      ];

      // Defensive: some tool responses may have been lost (e.g. a request
      // was interrupted mid-tool-loop). OpenAI requires every assistant
      // tool_call to be immediately followed by tool messages responding
      // to each tool_call_id. Walk the history, assign missing ids to
      // orphaned tool responses in the same block, and insert synthesized
      // error responses for any ids that are still missing.
      const normalizedMessages: ChatMessage[] = [];
      debugLog.messageArraySummary('normalize: input', currentMessages, logCtx(parsedSessionId));
      for (let i = 0; i < currentMessages.length; i += 1) {
        const msg = currentMessages[i]!;
        normalizedMessages.push(msg);

        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
          const expectedIds = msg.tool_calls.map((tc) => tc.id);
          const respondedIds = new Set<string>();
          const orphanToolMessages: ChatMessage[] = [];
          let j = i + 1;
          while (j < currentMessages.length && currentMessages[j]?.role === 'tool') {
            const toolMsg = currentMessages[j]!;
            if (toolMsg.tool_call_id) {
              respondedIds.add(toolMsg.tool_call_id);
            } else {
              orphanToolMessages.push(toolMsg);
              debugLog.toolMessage({
                layer: 'route',
                action: 'normalize',
                messageIndex: j,
                role: 'tool',
                hasToolCallId: false,
                tool_call_id: null,
                precedingAssistantToolCalls: msg.tool_calls.length,
                contentPreview: typeof toolMsg.content === 'string' ? toolMsg.content : '',
                note: 'orphan tool message (no tool_call_id) found in multi-tool block',
                ...logCtx(parsedSessionId),
              });
            }
            j += 1;
          }

          // Assign each orphan tool message a missing tool_call_id
          // in order, without removing or re-ordering messages.
          const missingIds = expectedIds.filter((id) => !respondedIds.has(id));
          for (const orphan of orphanToolMessages) {
            const missingId = missingIds.shift();
            if (!missingId) break;
            orphan.tool_call_id = missingId;
            debugLog.toolMessage({
              layer: 'route',
              action: 'normalize',
              role: 'tool',
              hasToolCallId: true,
              tool_call_id: missingId,
              precedingAssistantToolCalls: msg.tool_calls.length,
              contentPreview: typeof orphan.content === 'string' ? orphan.content : '',
              note: 'assigned missing tool_call_id to orphan tool message',
              ...logCtx(parsedSessionId),
            });
          }

          for (const toolId of missingIds) {
            const missingToolMessage: ChatMessage = {
              role: 'tool',
              content:
                '[Tool response missing: the tool call was recorded but no result was produced.]',
              tool_call_id: toolId,
            };
            normalizedMessages.push(missingToolMessage);
            pendingAppends.push(missingToolMessage);
            debugLog.toolMessage({
              layer: 'route',
              action: 'synthesize',
              messageIndex: normalizedMessages.length - 1,
              role: 'tool',
              hasToolCallId: true,
              tool_call_id: toolId,
              precedingAssistantToolCalls: msg.tool_calls.length,
              contentPreview: missingToolMessage.content,
              note: 'synthetic tool message inserted for missing tool_call_id',
              ...logCtx(parsedSessionId),
            });
          }
        }
      }
      currentMessages.splice(0, currentMessages.length, ...normalizedMessages);
      debugLog.messageArraySummary('normalize: output', currentMessages, logCtx(parsedSessionId));

      // ── Eagerly create the session so it appears in the sidebar immediately ──
      // If the client already has a session ID (resuming), use it as-is.
      // Otherwise create a placeholder session now and rename it once we have
      // the actual AI response content.
      let activeSessionId: number | undefined = parsedSessionId;
      let promptEvalCount = 0;
      let evalCount = 0;

      // Fail fast if the client is trying to resume a session that was
      // deleted in another tab. Without this guard the server burns LLM
      // tokens and silently drops the result at the write stage.
      if (activeSessionId !== undefined && !sessionExists(activeSessionId)) {
        sendEvent('error', {
          message: 'Session not found. It may have been deleted in another tab.',
        });
        controller.close();
        return;
      }

      // Hoisted so the outer `catch` (line 1792) can use it to format
      // a sensible error message.  The inner try block at 563 sets the
      // real value from the loaded config; this default is the
      // ollama-default fallback for the very rare case where the
      // error fires before config is loaded.
      let llmRequestContext: LlmRequestContext = buildLlmRequestContext({
        baseUrl: effectiveBaseUrl,
        requestId,
      });
      let activeProvider: ProviderConfig | null = null;
      // Resolved after the main provider and effective main context size are
      // known. A missing or stale explicit provider ID deliberately falls back
      // to this main request context rather than another configured provider.
      let compactionLlmRequestContext: LlmRequestContext = llmRequestContext;
      let compactionNumCtx = effectiveNumCtx;

      try {
        if (!activeSessionId) {
          activeSessionId = createSession(DEFAULT_SESSION_NAME, model as string);
          sendEvent('session_created', { sessionId: activeSessionId });
        }
        // Accept mid-turn model switches for this session from now until the
        // finally block below deregisters the turn.
        registerActiveTurn(activeSessionId, requestId);

        // Persist the client's messages (including subagent_log entries) as
        // the base state for this request.  Merging avoids clobbering any
        // messages written concurrently from another tab.
        await enqueueSessionWrite(activeSessionId, (fresh) => {
          debugLog.messageArraySummary('merge: fresh (DB)', fresh, logCtx(activeSessionId));
          debugLog.messageArraySummary(
            'merge: client',
            originalClientMessages as PersistedChatMessage[],
            logCtx(activeSessionId)
          );
          (originalClientMessages as PersistedChatMessage[]).forEach((m, idx) => {
            if (m.role === 'tool' && !(m as { tool_call_id?: string }).tool_call_id) {
              debugLog.toolMessage({
                layer: 'route',
                action: 'merge',
                messageIndex: idx,
                role: m.role,
                hasToolCallId: false,
                tool_call_id: null,
                precedingAssistantToolCalls: 0,
                contentPreview: typeof m.content === 'string' ? m.content : '',
                note: 'client tool message has no tool_call_id',
                ...logCtx(activeSessionId),
              });
            }
          });
          const merged = mergeClientMessages(
            fresh,
            originalClientMessages as PersistedChatMessage[]
          );
          debugLog.messageArraySummary('merge: result', merged, logCtx(activeSessionId));
          return merged;
        });
        // Per-request MCP approval set. Mutated in place when the user
        // resolves an approval_request event for a specific mcp_call.
        const mcpApprovalsSet = new Set<string>();

        // Per-request working-directory scope — a stable identity token
        // so that `run_command`'s `cd` tracking persists across all
        // tool calls within this HTTP request (previously broken because
        // fresh ToolOutputSink objects were created per tool call).
        const workingDirectoryScope = new WorkingDirectoryScope();

        // Load runtime tool configuration from disk so that web search
        // and YOLO settings reflect the latest user preferences.
        // Build per-request context from config (no global state setters).
        let requestContext: RequestContext;
        let disabledSubAgent: string[] = [];

        const buildRequestContext = (
          config: Config | null,
          activeProv: ProviderConfig | null
        ): RequestContext => {
          const disabledMain = config?.tools?.disabledMain ?? [];
          disabledSubAgent = config?.tools?.disabledSubAgent ?? [];
          const providerSettings = activeProv
            ? {
                provider: activeProv.provider,
                ...(activeProv.apiKey ? { apiKey: activeProv.apiKey } : {}),
              }
            : {};
          const configuredBaseUrl = activeProv?.baseUrl ?? effectiveBaseUrl;
          return {
            yoloMode: config?.yolo ?? false,
            citeSources: config?.citeSources ?? true,
            allowedTools: undefined,
            disabledMainTools: disabledMain,
            mcpApprovals: [...mcpApprovalsSet],
            model: model as string,
            numCtx: effectiveNumCtx,
            workingDirectoryScope,
            webSearch: {
              ...providerSettings,
              maxQueries: config?.webSearch?.maxQueries ?? DEFAULT_WEB_SEARCH_MAX_QUERIES,
              resultsPerQuery:
                config?.webSearch?.resultsPerQuery ?? DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY,
              requestTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
              perPageCharLimit:
                config?.webSearch?.perPageCharLimit ?? DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
              baseUrl: configuredBaseUrl,
              compactionModel: effectiveCompactionModel,
              compactionLlmRequestContext,
            },
            subAgent: {
              ...providerSettings,
              baseUrl: configuredBaseUrl,
              model: model as string,
              numCtx: effectiveNumCtx,
              compactionModel: effectiveCompactionModel,
              compactionLlmRequestContext,
              compactionNumCtx,
              ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
              tools: TOOLS.filter(
                (tool) =>
                  tool.function.name !== 'run_subagents' &&
                  !disabledSubAgent.includes(tool.function.name)
              ),
              mcpApprovals: [...mcpApprovalsSet],
              approvalRequester: requestSubAgentApproval,
              refreshModels: refreshSubAgentModels,
            },
          };
        };

        // Lets a sub-agent apply a pending model switch itself. A
        // `run_subagents` batch parks the main tool-call loop for its whole
        // duration, so without this the swap would not land until the batch
        // finished. `applyPendingModelSwitch` is declared further down; this
        // only dereferences it at call time, from inside the tool loop.
        const refreshSubAgentModels = (): Promise<void> => applyPendingModelSwitch();

        // Phase 2 (sub-agent approval UX): build a closure that lets a
        // sub-agent bubble an approval request up to the main route's
        // SSE stream. The closure captures the SSE `sendEvent` from
        // the outer scope and races the user's response against the
        // parent request's abort signal.
        const requestSubAgentApproval = async (req2: {
          toolName: string;
          risk: 'command' | 'network' | 'file' | 'mcp' | 'other';
          args: unknown;
        }): Promise<{ approved: boolean; grantedTools?: string[] }> => {
          const subRequestId = randomUUID();
          const abortPromise = new Promise<ApprovalDecision>((resolve) => {
            if (req.signal.aborted) {
              resolve({ approved: false });
              return;
            }
            req.signal.addEventListener('abort', () => resolve({ approved: false }), {
              once: true,
            });
          });
          sendEvent('approval_request', {
            requestId: subRequestId,
            toolName: req2.toolName,
            args: req2.args as Record<string, unknown>,
            fromSubAgent: true,
          });
          const decision = await Promise.race([waitForApproval(subRequestId, req2), abortPromise]);
          resolveApproval(subRequestId, { approved: false });
          return decision;
        };

        // Per-request LLM context — passed through every LLM call in
        // this request's scope. Replaces the previous
        // `configureLlmAdapterAndAuth` singleton, which was a single
        // module-level axios instance shared by every concurrent
        // request. Two simultaneous requests with different
        // providers / api keys no longer race on a global.
        // (llmRequestContext is hoisted to the outer scope above
        // so the catch block at 1792 can see it; we just reassign
        // it here from the loaded config.)

        // Hoisted config so the merged-tool-list decision below
        // can read `config.mcpToolSearch` even when loadConfig()
        // throws. The inner try/catch owns the user-config
        // derivation; the outer build path is independent.
        let config: Config | null = null;

        // Model-dependent resolution, factored out of the initial setup so
        // a mid-turn model switch can re-run exactly the same logic against
        // the new model instead of carrying stale verdicts forward.

        /**
         * Resolve the effective numCtx against the current model's runtime
         * cap. This is the single backend source of truth for the clamp;
         * the client never applies it. The body numCtx (requestedNumCtx)
         * wins over the persisted config value for this turn, falling back
         * to the active provider's numCtx, then the global config.numCtx,
         * then DEFAULT_NUM_CTX.
         */
        const resolveNumCtxForModel = async (): Promise<void> => {
          const providerRequested = activeProvider
            ? getProviderNumCtx(activeProvider, config?.numCtx)
            : undefined;
          const configRequested = config?.numCtx;
          const requested =
            typeof numCtx === 'number' && Number.isFinite(numCtx) && numCtx > 0
              ? Math.floor(numCtx)
              : providerRequested !== undefined &&
                  Number.isFinite(providerRequested) &&
                  providerRequested > 0
                ? providerRequested
                : typeof configRequested === 'number' &&
                    Number.isFinite(configRequested) &&
                    configRequested > 0
                  ? Math.floor(configRequested)
                  : requestedNumCtx;
          try {
            const resolved = await resolveEffectiveNumCtx(llmRequestContext, model, requested);
            effectiveNumCtx = resolved.effective;
            modelContextLimit = resolved.modelCap;
          } catch {
            // Resolver is best-effort: if both probes fail, fall through
            // with the requested value. The reactive 400 catch below will
            // catch any over-budget request and update the cap.
            effectiveNumCtx = requested;
          }
        };

        /**
         * Determine vision support for the current model so we can strip
         * image attachments when the model does not support them. The
         * async resolver consults a per-(baseUrl, modelName) cache and
         * falls back to provider-specific optimistic defaults — see
         * `src/services/visionCache.ts` for the full resolution order.
         * This is what fixes the silent image-stripping bug for
         * openai-compatible providers (`/v1/models` has no standard
         * `capabilities` field, so the legacy sync heuristic always
         * returned `false` and the adapter stripped the image).
         */
        const resolveVisionForModel = async (): Promise<boolean | undefined> => {
          try {
            let modelInfo;
            try {
              modelInfo = await fetchLlmModelInfo(llmRequestContext, model);
            } catch {
              // Model metadata is best-effort. The cache/default resolver
              // below still provides a safe provider-specific fallback.
            }
            const resolved = await getLlmModelVisionSupportAsync(
              activeProvider?.baseUrl ?? effectiveBaseUrl,
              model,
              activeProvider?.provider ?? 'ollama',
              modelInfo
            );
            return resolved.visionSupported;
          } catch {
            // Best-effort: if both metadata and cache resolution fail,
            // preserve the existing behavior and let the adapter receive
            // any images.
            return undefined;
          }
        };

        /**
         * Resolve per-parameter sampling support for the current model so
         * the openai-compatible adapter can omit fields the upstream
         * rejects (e.g. `temperature` on `openai/gpt-5.6-luna`). Mirrors
         * the vision resolution above: best-effort, cache-aware, default
         * ('supported' for both providers) on failure.
         */
        const resolveSamplingSupportForModel = async (): Promise<
          Awaited<ReturnType<typeof getLlmModelSamplingParamSupportAsync>> | undefined
        > => {
          try {
            const provider = activeProvider?.provider ?? 'ollama';
            const adapter = selectLlmAdapter(provider);
            const probe = adapter.fetchSamplingParamSupport
              ? () =>
                  adapter.fetchSamplingParamSupport!(llmRequestContext, model).then((m) => m ?? {})
              : undefined;
            return await getLlmModelSamplingParamSupportAsync(
              activeProvider?.baseUrl ?? effectiveBaseUrl,
              model,
              provider,
              probe
            );
          } catch {
            // Best-effort: undefined means every param is treated as
            // supported (the adapter's optimistic default).
            return undefined;
          }
        };

        /**
         * Resolve the compaction runtime for the current model. Called
         * again after a switch so auto-compaction, sub-agent compaction,
         * web-content compaction, and title generation all stay on the
         * same selected model/provider semantics.
         *
         * Resolves the compaction provider by ID only. Passing no model
         * name is intentional: a stale explicit ID must not be recovered
         * by model matching or by resolveProvider's unrelated default
         * provider.
         */
        const resolveCompactionRuntime = (
          requestedCompactionModel: string | undefined,
          requestedCompactionProviderId: string | undefined
        ): void => {
          effectiveCompactionModel = resolveCompactionModel(requestedCompactionModel, model);
          const explicitId =
            typeof requestedCompactionProviderId === 'string' &&
            requestedCompactionProviderId.trim().length > 0
              ? requestedCompactionProviderId.trim()
              : undefined;
          const resolved = explicitId
            ? resolveProviderRequestContext(config, explicitId, undefined, requestId)
            : null;
          compactionLlmRequestContext = resolved?.ctx ?? llmRequestContext;
          compactionNumCtx = resolved
            ? getProviderNumCtx(resolved.provider, config?.numCtx)
            : effectiveNumCtx;
        };

        try {
          config = await loadConfig();
          const resolved = resolveProviderRequestContext(config, providerId, model, requestId);
          if (resolved) {
            activeProvider = resolved.provider;
            llmRequestContext = resolved.ctx;
          } else {
            llmRequestContext = buildLlmRequestContext({
              baseUrl: effectiveBaseUrl,
              requestId,
            });
          }
          if (config) {
            if (typeof config.yolo === 'boolean') {
              effectiveYolo = config.yolo;
            }
            if (typeof config.promptTimestamps === 'boolean') {
              effectivePromptTimestamps = config.promptTimestamps;
            }
            if (typeof config.citeSources === 'boolean') {
              effectiveCiteSources = config.citeSources;
            }
          }

          await resolveNumCtxForModel();
          resolveCompactionRuntime(
            compactionModel ?? config?.compactionModel,
            compactionProviderId
          );

          // Compute allowedTools from always-apply skills (best-effort)
          let allowedTools: string[] | undefined;
          try {
            const allSkills = discoverSkills();
            const skillState = loadSkillState();
            const enabledSkills = getEnabledSkills(allSkills, skillState);
            allowedTools = getAllowedToolsFromSkills(enabledSkills.filter((s) => s.alwaysApply));
          } catch {
            // Skills discovery is best-effort; leave allowedTools undefined
          }

          requestContext = buildRequestContext(config, activeProvider);
          requestContext.allowedTools = allowedTools;
        } catch {
          // Config load is best-effort; defaults already apply. The body
          // compaction selection remains authoritative even on this fallback.
          llmRequestContext = buildLlmRequestContext({
            baseUrl: effectiveBaseUrl,
            requestId,
          });
          resolveCompactionRuntime(compactionModel, undefined);
          requestContext = buildRequestContext(null, null);
        }
        // Build the merged tool list (static native TOOLS + dynamic MCP
        // tool defs from already-connected servers). Computed once per
        // request — tool additions/removals only take effect on the
        // next request (matches Phase 1's "no hot-reload" decision).
        //
        // Phase 3 (MCP Tool Search): when enabled — either explicitly
        // via `config.mcpToolSearch` or implicitly when the total
        // connected MCP tool count exceeds `MCP_TOOL_SEARCH_THRESHOLD`
        // — the chat route uses the lazy "stub" path. The LLM sees
        // the namespaced names + a short description for every MCP
        // tool (cheap, ~50-80 tokens per tool) and must call
        // `search_mcp_tools` to retrieve the full JSON Schema before
        // invoking. The `mcp_call` tool is still in the merged list
        // unchanged.
        // Type is the union of OllamaTool (native) and ToolDefinition
        // (MCP dynamic) — both shapes are accepted by the LLM adapter.
        type AnyTool = (typeof TOOLS)[number] | ToolDefinition;
        let mergedTools: AnyTool[];
        try {
          const totalMCPToolCount = await getMCPToolCount();
          const enableSearch =
            config?.mcpToolSearch === true || totalMCPToolCount > MCP_TOOL_SEARCH_THRESHOLD;
          if (enableSearch) {
            const mcpStubs = await getMergedMCPToolDefinitionsForSearch();
            mergedTools = [...TOOLS, ...mcpStubs];
          } else {
            const mcpToolDefs = await getMergedMCPToolDefinitions();
            mergedTools = [...TOOLS, ...mcpToolDefs];
          }
        } catch {
          // MCP tool discovery is best-effort: fall back to native tools only.
          mergedTools = [...TOOLS];
        }

        // Phase 3.4 (sub-agent MCP tool exposure): swap the
        // sub-agent's `tools` list for the SAME `mergedTools` used
        // by the main agent, minus the tools a sub-agent should
        // never see (recursive `run_subagents` is already guarded
        // inside `runSingleAgent`, and `search_mcp_tools` is a
        // main-agent helper that has no value to a sub-agent which
        // already has the full schemas inline). The user-facing
        // `disabledMain` and `disabledSubAgent` lists still apply
        // — `disabledMain` because anything the user disabled for
        // the main agent should stay disabled for sub-agents
        // unless they explicitly overrode the sub-agent set, and
        // `disabledSubAgent` because the user may have a separate
        // per-sub-agent blocklist. We honour both — a tool listed
        // in EITHER set is removed.
        //
        // The previous implementation only had native tools here,
        // which forced a sub-agent to call `mcp_call` indirectly.
        // Now a sub-agent can call any `mcp__<server>__<tool>`
        // directly the same way the main agent can.
        if (requestContext.subAgent) {
          const disabled = new Set<string>([
            ...(requestContext.disabledMainTools ?? []),
            ...disabledSubAgent,
          ]);
          requestContext.subAgent.tools = mergedTools.filter(
            (tool) =>
              tool.function.name !== 'run_subagents' &&
              tool.function.name !== 'search_mcp_tools' &&
              !disabled.has(tool.function.name)
          );
        }

        // The verdicts are stashed on per-request closure variables so the
        // adapter's synchronous payload builder can read them, and so a
        // mid-turn model switch can replace them wholesale.
        let visionSupported: boolean | undefined = await resolveVisionForModel();
        let samplingParamSupport:
          | Awaited<ReturnType<typeof getLlmModelSamplingParamSupportAsync>>
          | undefined = await resolveSamplingSupportForModel();

        // Refresh the system prompt now that yolo and vision support are known.
        const refreshSystemPrompt = (): void => {
          currentMessages[0] = {
            role: 'system',
            content: createSystemPrompt(visionSupported, effectiveYolo, effectiveCiteSources),
          };
        };
        refreshSystemPrompt();

        /**
         * Apply a model switch requested via `/api/chat/switch-model` while
         * this turn was already streaming.
         *
         * Called at the top of each tool-call loop iteration, so the swap
         * lands at a natural boundary rather than interrupting an in-flight
         * LLM call. Everything the new model implies is re-derived here —
         * context cap, vision support, sampling-parameter support, and the
         * compaction runtime — so the rest of the turn never runs on
         * verdicts resolved for the previous model.
         *
         * Sub-agents pick the change up for free: `requestContext.subAgent`
         * is mutated in place, and `subAgentTool` reads `config.model` off
         * that same object on every one of its internal iterations. A
         * `run_subagents` batch that is already mid-flight therefore
         * switches on its next LLM call.
         */
        const applyPendingModelSwitch = async (): Promise<void> => {
          if (activeSessionId === undefined) return;
          const pending = consumeModelSwitch(activeSessionId);
          if (!pending) return;

          if (pending.model !== undefined && pending.model !== model) {
            model = pending.model;
            const resolved = resolveProviderRequestContext(
              config,
              pending.providerId ?? providerId,
              model,
              requestId
            );
            if (resolved) {
              activeProvider = resolved.provider;
              llmRequestContext = resolved.ctx;
            } else {
              activeProvider = null;
              llmRequestContext = buildLlmRequestContext({
                baseUrl: effectiveBaseUrl,
                requestId,
              });
            }
            await resolveNumCtxForModel();
            visionSupported = await resolveVisionForModel();
            samplingParamSupport = await resolveSamplingSupportForModel();
            refreshSystemPrompt();
          }

          // Always re-resolve the compaction runtime: an explicit switch
          // changes it directly, and a main-model switch changes it too for
          // anyone on "same as main".
          const nextCompactionModel =
            pending.compactionModel ?? compactionModel ?? config?.compactionModel;
          resolveCompactionRuntime(
            nextCompactionModel,
            pending.compactionProviderId ?? compactionProviderId
          );

          // Mutating in place (rather than rebuilding the context) is what
          // lets an already-running run_subagents batch see the new model.
          // Provider fields are deleted when the new model has no
          // configured provider, so a stale apiKey can't survive the swap.
          const applyProviderSettings = (target: {
            provider?: 'ollama' | 'openai-compatible';
            apiKey?: string;
          }): void => {
            if (!activeProvider) {
              delete target.provider;
              delete target.apiKey;
              return;
            }
            target.provider = activeProvider.provider;
            if (activeProvider.apiKey) {
              target.apiKey = activeProvider.apiKey;
            } else {
              delete target.apiKey;
            }
          };
          const configuredBaseUrl = activeProvider?.baseUrl ?? effectiveBaseUrl;

          requestContext.model = model;
          requestContext.numCtx = effectiveNumCtx;
          applyProviderSettings(requestContext.webSearch);
          requestContext.webSearch.baseUrl = configuredBaseUrl;
          requestContext.webSearch.compactionModel = effectiveCompactionModel;
          requestContext.webSearch.compactionLlmRequestContext = compactionLlmRequestContext;
          if (requestContext.subAgent) {
            applyProviderSettings(requestContext.subAgent);
            requestContext.subAgent.baseUrl = configuredBaseUrl;
            requestContext.subAgent.model = model;
            requestContext.subAgent.numCtx = effectiveNumCtx;
            requestContext.subAgent.compactionModel = effectiveCompactionModel;
            requestContext.subAgent.compactionLlmRequestContext = compactionLlmRequestContext;
            requestContext.subAgent.compactionNumCtx = compactionNumCtx;
          }

          sendEvent('status', {
            phase: 'model_switched',
            model,
            compactionModel: effectiveCompactionModel,
            tokenLimit: effectiveNumCtx,
            modelContextLimit,
          });
          debugLog.diagnostic({
            layer: 'route',
            phase: 'model_switched',
            ...logCtx(activeSessionId),
            model,
            compactionModel: effectiveCompactionModel,
          });
        };

        // ── Main tool-calling loop ──────────────────────────────────
        outer: while (true) {
          // Pick up any model switch the user requested while this turn was
          // streaming. Done before auto-compaction so compaction also runs
          // on the newly selected models and context size.
          await applyPendingModelSwitch();

          // Auto-compact when approaching the context limit, mirroring the
          // server-side autoCompactIfNeeded() logic in services/chatSession.ts.
          if (effectiveNumCtx > 0) {
            const tokensUsed =
              lastAuthoritativeTokens > 0
                ? lastAuthoritativeTokens
                : countMessagesTokens(currentMessages, model as string);
            const usagePct = (tokensUsed / effectiveNumCtx) * 100;

            // Only compact when there is enough history for the split logic to
            // produce a non-empty messagesToSummarise. With fewer than 4 messages,
            // the anchor-rescue fallback can return an empty array, which would
            // otherwise trip the too-short guard with a confusing near-zero token
            // estimate (see tools/impl/subAgentTool.ts and services/compact.ts).
            if (usagePct >= AUTO_COMPACT_THRESHOLD_PCT && currentMessages.length >= 4) {
              sendEvent('status', {
                phase: 'compacting',
                tokensUsed,
                tokenLimit: effectiveNumCtx,
                modelContextLimit,
              });
              let compactFailed = false;
              let persistedOk = true;
              let writeError: string | null = null;
              try {
                // The compaction runtime was resolved once, after the main
                // request context size was known. This keeps auto-compaction,
                // sub-agent compaction, web content compaction, and title
                // generation on the same selected model/provider semantics.
                const compactResult = await compactHistory(
                  compactionLlmRequestContext,
                  effectiveCompactionModel,
                  currentMessages,
                  compactionNumCtx,
                  (message: string) => {
                    sendEvent('compact_progress', { message });
                  },
                  1,
                  2,
                  undefined,
                  req.signal
                );
                // Replace server-side history with the compacted result.
                const preservedSystemMessage = currentMessages[0];
                if (!preservedSystemMessage || preservedSystemMessage.role !== 'system') {
                  throw new Error('Cannot compact: missing system prompt.');
                }
                currentMessages.splice(
                  0,
                  currentMessages.length,
                  preservedSystemMessage,
                  ...compactResult.newMessages
                );
                // Persist compacted history so the frontend sees the reduced state.
                pendingReplace = [...currentMessages];
                // LLM-only nudge – not sent to the client and not persisted.
                // Carries the cumulative compaction count and current usage so
                // the model can recognise it is repeatedly hitting the context
                // limit and adapt (tighter tool output, different approach).
                // Prefixed with SYNTHETIC_NUDGE_MARKER so the compaction
                // pipeline's latest-user-message anchor never latches onto it.
                compactionsSinceLastPrompt += 1;
                const adaptiveDirective =
                  compactionsSinceLastPrompt >= COMPACTION_ADAPTIVE_DIRECTIVE_THRESHOLD
                    ? COMPACTION_ADAPTIVE_DIRECTIVE
                    : ' Please continue working on the original task without asking for confirmation.';
                currentMessages.push({
                  role: 'user',
                  content:
                    `${SYNTHETIC_NUDGE_MARKER}The conversation history was automatically compacted due to context length. ` +
                    `It has now been compacted ${compactionsSinceLastPrompt} time${compactionsSinceLastPrompt === 1 ? '' : 's'} ` +
                    `since your last message, and context usage is around ${Math.min(100, Math.round(usagePct))}%.` +
                    `${adaptiveDirective}${SYNTHETIC_NUDGE_END}`,
                });
                const flushResult = await flushSessionState();
                if (!flushResult.ok) {
                  persistedOk = false;
                  writeError = flushResult.error;
                }
                // Send the compacted message list to the client AFTER
                // persisting so the client doesn't see a state that
                // might fail to persist.
                sendEvent('compact', {
                  messages: compactResult.newMessages,
                  stats: compactResult.stats,
                });
                lastAuthoritativeTokens = countMessagesTokens(currentMessages, model as string);
                if (compactResult.stats.newTokenCount > effectiveNumCtx) {
                  sendEvent('status', {
                    phase: 'compact_overflow',
                    tokensUsed: compactResult.stats.newTokenCount,
                    tokenLimit: effectiveNumCtx,
                    modelContextLimit,
                  });
                }
              } catch {
                // Non-fatal — log and continue with existing messages.
                compactFailed = true;
              }
              if (compactFailed) {
                sendEvent('status', {
                  phase: 'compact_failed',
                  tokensUsed,
                  tokenLimit: effectiveNumCtx,
                  modelContextLimit,
                });
              }
              if (!persistedOk) {
                // Persisting the compacted history failed. The DB
                // is now out of sync with `currentMessages`; bail
                // out of the entire tool loop so the user can
                // decide whether to retry. The `write_error`
                // event was already emitted by flushSessionState.
                throw new Error(`Write failed: ${writeError ?? 'unknown'}`);
              }
            }
          }

          // Derive the LLM-bound copy of the conversation. The user-typed
          // content stays in `currentMessages` (which is what we persist
          // and what we re-merge on retry); `llmMessages` is a fresh
          // derivative that optionally prepends a `[Sent …]` header on
          // each user-role message when the promptTimestamps toggle is
          // on. The toggle is checked here (not at send-time) so it
          // retroactively affects past messages whose created_at column
          // is already populated.
          const llmMessages: ChatMessage[] = currentMessages.map((message) =>
            maybeInjectPromptTimestamp(message, effectivePromptTimestamps)
          );

          // Signal that we are about to start an LLM call.
          const promptEstimate = countMessagesTokens(llmMessages, model as string);
          sendEvent('status', {
            phase: 'thinking',
            tokensUsed: promptEstimate,
            tokenLimit: effectiveNumCtx,
            modelContextLimit,
            isEstimated: true,
          });

          // -- Call the LLM via the active adapter ------------------
          const params: StreamChatParams = {
            model: model as string,
            messages: llmMessages,
            tools: requestContext.disabledMainTools?.length
              ? mergedTools.filter(
                  (t) => !requestContext.disabledMainTools!.includes(t.function.name)
                )
              : mergedTools,
            numCtx: effectiveNumCtx,
            signal: req.signal,
            timeoutMs: effectiveChatTimeoutMs,
          };
          if (thinkEnabled !== undefined) {
            params.think = thinkEnabled;
          }
          // 'off' is the UI default and means "use the Thinking toggle";
          // only forward explicit reasoning levels so the adapter can fall
          // back to mapping thinkingEnabled -> reasoning effort.
          if (reasoningEffort !== undefined && reasoningEffort !== 'off') {
            params.reasoningEffort = reasoningEffort;
          }
          if (visionSupported !== undefined) {
            params.visionSupported = visionSupported;
          }
          if (samplingParamSupport !== undefined) {
            params.samplingParamSupport = samplingParamSupport;
          }

          let content = '';
          let thinking = '';
          let toolCalls: ChatMessage['tool_calls'] | undefined;
          let promptEvalDuration = 0;
          let evalDuration = 0;
          let wallClockTps: number | null = null;
          let streamStartMs = 0;
          let roughTokens = 0;
          let lastTpsStatusMs = 0;
          let firstChunkLogged = false;
          // Captured on the chunk with `done: true`. Distinguishes a natural
          // end-of-sequence (`stop`) from a token-cap truncation (`length`)
          // and from server heartbeats (`load` / `unload`). The chat route
          // never previously consulted this field.
          let lastDoneReason: DoneReason | undefined;

          // ── Retry transient LLM errors (503, 502, 504, 429, network) ──
          const MAX_LLM_RETRIES = 3;
          const RETRY_BASE_DELAY_MS = 1000;
          let retryAttempt = 0;
          let firstContent = '';
          let firstThinking = '';

          debugLog.messageArraySummary(
            'pre-LLM: currentMessages',
            currentMessages,
            logCtx(activeSessionId)
          );

          const requestStartedAt = Date.now();
          debugLog.diagnostic({
            layer: 'route',
            phase: 'model_request_start',
            ...logCtx(activeSessionId),
            provider: llmRequestContext.provider,
            model: model as string,
            baseUrl: llmRequestContext.baseUrl,
            messageCount: currentMessages.length,
            toolCallCount: currentMessages.reduce(
              (total, message) => total + (message.tool_calls?.length ?? 0),
              0
            ),
          });

          while (true) {
            try {
              streamStartMs = Date.now();
              roughTokens = 0;
              lastTpsStatusMs = 0;

              firstChunkLogged = false;

              const llmStream = sendLlmChatStream(llmRequestContext, params);

              for await (const chunk of llmStream) {
                if (!firstChunkLogged) {
                  firstChunkLogged = true;
                  debugLog.diagnostic({
                    layer: 'route',
                    phase: 'model_first_chunk',
                    ...logCtx(activeSessionId),
                    provider: llmRequestContext.provider,
                    model: model as string,
                    baseUrl: llmRequestContext.baseUrl,
                    elapsedMs: Date.now() - requestStartedAt,
                  });
                }
                const msg = chunk.message;

                // Stream thinking token chunks (e.g. for deep-thinking models).
                if (msg?.thinking) {
                  const thinkingChunk = sanitizeAssistantTextFragment(msg.thinking);
                  if (thinkingChunk) {
                    thinking += thinkingChunk;
                    sendEvent('thinking', { content: thinkingChunk });
                    // Count thinking tokens toward live throughput so the TPS
                    // badge stays visible during long reasoning chains.
                    roughTokens += countTextTokens(thinkingChunk, model as string);
                  }
                }

                // Stream regular content chunks.
                if (msg?.content) {
                  const contentChunk = sanitizeAssistantTextFragment(msg.content);
                  if (contentChunk) {
                    content += contentChunk;
                    sendEvent('chunk', { content: contentChunk });
                    roughTokens += countTextTokens(contentChunk, model as string);
                  }
                }

                // Live token count for t/s display — emit at most once every 800 ms.
                if (roughTokens > 0) {
                  const now = Date.now();
                  if (now - lastTpsStatusMs > TPS_STATUS_MIN_INTERVAL_MS) {
                    const elapsedSec = (now - streamStartMs) / 1000;
                    if (elapsedSec > 0) {
                      sendEvent('status', {
                        phase: 'responding',
                        tps: +(roughTokens / elapsedSec).toFixed(2),
                      });
                    }
                    lastTpsStatusMs = now;
                  }
                }

                // Capture tool calls from the final (or any) chunk.
                if (msg?.tool_calls && msg.tool_calls.length > 0) {
                  toolCalls = msg.tool_calls;
                }

                // Capture authoritative token counts and durations from the final chunk.
                if (chunk.done) {
                  promptEvalCount = chunk.prompt_eval_count ?? 0;
                  evalCount = chunk.eval_count ?? 0;
                  promptEvalDuration = chunk.prompt_eval_duration ?? 0;
                  evalDuration = chunk.eval_duration ?? 0;
                  lastDoneReason =
                    typeof chunk.done_reason === 'string' &&
                    VALID_DONE_REASONS.has(chunk.done_reason)
                      ? (chunk.done_reason as DoneReason)
                      : undefined;
                }
              }

              debugLog.diagnostic({
                layer: 'route',
                phase: 'model_complete',
                ...logCtx(activeSessionId),
                provider: llmRequestContext.provider,
                model: model as string,
                baseUrl: llmRequestContext.baseUrl,
                elapsedMs: Date.now() - requestStartedAt,
                result: firstChunkLogged ? 'streamed' : 'no_chunks',
              });

              // Wall-clock fallback in case Ollama durations are missing.
              const wallClockElapsedMs = Date.now() - streamStartMs;
              wallClockTps =
                evalCount > 0 && wallClockElapsedMs > 0
                  ? +(evalCount / (wallClockElapsedMs / 1000)).toFixed(2)
                  : null;

              // Preserve the first successful response for auto-titling
              // across retries in case the subsequent attempt differs.
              if (!firstContent && content.trim()) {
                firstContent = content;
                firstThinking = thinking;
              }

              break; // success — exit retry loop
            } catch (err) {
              debugLog.diagnostic({
                layer: 'route',
                phase: 'error',
                ...logCtx(activeSessionId),
                provider: llmRequestContext.provider,
                model: model as string,
                baseUrl: llmRequestContext.baseUrl,
                attempt: retryAttempt + 1,
                elapsedMs: Date.now() - requestStartedAt,
                error: err,
              });
              if (retryAttempt >= MAX_LLM_RETRIES - 1 || !isRetryableError(err)) {
                logger.error(
                  'ollama',
                  `Request failed permanently (attempt ${retryAttempt + 1}/${MAX_LLM_RETRIES})`,
                  { error: err }
                );
                throw err; // propagate to outer catch
              }
              retryAttempt++;

              logger.warn(
                'ollama',
                `Request failed, retrying (attempt ${retryAttempt}/${MAX_LLM_RETRIES})`,
                { error: err }
              );

              sendEvent('status', {
                phase: 'retrying',
                attempt: retryAttempt,
                maxRetries: MAX_LLM_RETRIES,
              });
              sendEvent('clear_assistant', {});

              // Reset accumulators for the fresh attempt
              content = '';
              thinking = '';
              toolCalls = undefined;
              promptEvalCount = 0;
              evalCount = 0;
              promptEvalDuration = 0;
              evalDuration = 0;
              wallClockTps = null;
              streamStartMs = 0;
              roughTokens = 0;
              lastTpsStatusMs = 0;
              firstChunkLogged = false;
              lastDoneReason = undefined;

              // Exponential backoff with abort-signal awareness
              const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, retryAttempt - 1);
              if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, delayMs);
                const onAbort = () => {
                  clearTimeout(timer);
                  resolve();
                };
                req.signal?.addEventListener('abort', onAbort, { once: true });
              });
              if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            }
          }

          // Anchor the token estimate to Ollama's authoritative count so
          // the next loop iteration's auto-compact check is accurate.
          lastAuthoritativeTokens = promptEvalCount + evalCount;

          // -- Build the assistant message --------------------------
          const assistantMessage = sanitizeChatMessage({
            role: 'assistant',
            content,
          });
          if (thinking) {
            assistantMessage.thinking = thinking;
          }
          if (toolCalls && toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls;
          }

          // -- Handle tool calls if present -------------------------
          if (toolCalls && toolCalls.length > 0) {
            sendEvent('status', {
              phase: 'tools',
              tokensUsed: promptEvalCount + evalCount,
              tokenLimit: effectiveNumCtx,
              modelContextLimit,
            });

            const tokensUsedSoFar = promptEvalCount + evalCount;
            const toolResults: ChatMessage[] = [];

            for (const tc of toolCalls) {
              const toolName = tc.function.name;
              let toolArgs = tc.function.arguments;
              debugLog.toolMessage({
                layer: 'route',
                action: 'push',
                role: 'assistant',
                hasToolCallId: !!tc.id,
                tool_call_id: tc.id,
                precedingAssistantToolCalls: toolCalls.length,
                contentPreview: toolName,
                note: `executing tool "${toolName}" with tc.id=${tc.id}`,
                ...logCtx(activeSessionId),
              });
              if (typeof toolArgs === 'string') {
                try {
                  toolArgs = JSON.parse(toolArgs);
                } catch {
                  /* keep string as-is on parse failure */
                }
              }

              // If toolArgs is still a string after the parse attempt, the LLM
              // produced malformed JSON arguments. Skip this tool call with an
              // error result so the model can correct itself, and so the
              // malformed data never reaches the approval gates or handleToolCall.
              if (typeof toolArgs === 'string') {
                const errorMsg = `[Error: Tool "${toolName}" received malformed JSON arguments that could not be parsed. The model should retry with valid JSON.]`;
                sendEvent('tool_result', {
                  name: toolName,
                  result: errorMsg,
                  duration: 0,
                });
                toolResults.push({ role: 'tool', content: errorMsg, tool_call_id: tc.id });
                continue;
              }

              sendEvent('tool_call', {
                name: toolName,
                arguments: toolArgs,
              });

              // ── Approval gate for run_command (skipped in YOLO mode) ────
              if (toolName === 'run_command' && !effectiveYolo) {
                const requestId = randomUUID();

                // Race the user decision against an abort signal so the
                // server doesn't hang if the client disconnects. Both
                // branches resolve to an `ApprovalDecision` so the race's
                // result type stays uniform — the abort path returns
                // `{ approved: false }` rather than a bare `false`.
                const abortPromise = new Promise<ApprovalDecision>((resolve) => {
                  if (req.signal.aborted) {
                    resolve({ approved: false });
                    return;
                  }
                  req.signal.addEventListener('abort', () => resolve({ approved: false }), {
                    once: true,
                  });
                });

                sendEvent('approval_request', {
                  requestId,
                  toolName,
                  args: toolArgs,
                });

                const decision = await Promise.race([
                  waitForApproval(requestId, { toolName, risk: 'command', args: toolArgs }),
                  abortPromise,
                ]);

                // Clean up registry entry when the abort path won the race.
                resolveApproval(requestId, { approved: false });

                if (!decision.approved) {
                  const rejectedResult = '[Command rejected by user]';
                  sendEvent('tool_result', {
                    name: toolName,
                    result: rejectedResult,
                    duration: 0,
                  });
                  toolResults.push({ role: 'tool', content: rejectedResult, tool_call_id: tc.id });
                  continue;
                }
              }
              // ────────────────────────────────────────────────────────────

              // ── Approval gate for mcp_call and direct mcp__ namespaced
              // calls (skipped in YOLO mode). ──
              const isDirectNamespacedCall = parseMCPToolName(toolName) !== null;
              if ((toolName === 'mcp_call' || isDirectNamespacedCall) && !effectiveYolo) {
                const requestedServer = isDirectNamespacedCall
                  ? (parseMCPToolName(toolName)?.serverName ??
                    (typeof toolArgs?.server === 'string' ? toolArgs.server : ''))
                  : typeof toolArgs?.server === 'string'
                    ? toolArgs.server
                    : '';
                const requestedTool = isDirectNamespacedCall
                  ? (parseMCPToolName(toolName)?.toolName ??
                    (typeof toolArgs?.tool === 'string' ? toolArgs.tool : ''))
                  : typeof toolArgs?.tool === 'string'
                    ? toolArgs.tool
                    : '';
                const namespacedTarget =
                  requestedServer && requestedTool
                    ? `mcp__${requestedServer}__${requestedTool}`
                    : null;

                // A6 shortcut: already approved in this request.
                if (namespacedTarget && mcpApprovalsSet.has(namespacedTarget)) {
                  // Proceed without re-prompting.
                } else {
                  let autoApproved = false;

                  // A5 shortcut: on the server's autoApprove list. Uses the
                  // shared helper so the route's semantics match the
                  // dispatcher's glob matching exactly.
                  if (requestedServer && requestedTool) {
                    autoApproved = await isAutoApprovedMCPTarget(requestedServer, requestedTool);
                  }

                  if (autoApproved) {
                    // A5: server-config autoApprove — silently allow, no UI gate.
                    if (namespacedTarget) {
                      mcpApprovalsSet.add(namespacedTarget);
                      requestContext.mcpApprovals = [...mcpApprovalsSet];
                    }
                  } else {
                    // Full approval gate: emit approval_request, wait, race against abort.
                    const requestId = randomUUID();

                    const abortPromise = new Promise<ApprovalDecision>((resolve) => {
                      if (req.signal.aborted) {
                        resolve({ approved: false });
                        return;
                      }
                      req.signal.addEventListener('abort', () => resolve({ approved: false }), {
                        once: true,
                      });
                    });

                    sendEvent('approval_request', {
                      requestId,
                      toolName,
                      toolCallName: namespacedTarget ?? 'mcp__unknown__unknown',
                      args: toolArgs ?? {},
                    });

                    const decision = await Promise.race([
                      waitForApproval(requestId, {
                        toolName,
                        risk: 'mcp',
                        args: { server: requestedServer, tool: requestedTool, toolArgs },
                      }),
                      abortPromise,
                    ]);

                    resolveApproval(requestId, { approved: false });

                    if (!decision.approved) {
                      const rejectedResult = '[MCP call rejected by user]';
                      sendEvent('tool_result', {
                        name: toolName,
                        result: rejectedResult,
                        duration: 0,
                      });
                      toolResults.push({
                        role: 'tool',
                        content: rejectedResult,
                        tool_call_id: tc.id,
                      });
                      continue;
                    }

                    // When the user approves, record the call and
                    // any granted pre-authorisations.
                    if (namespacedTarget) {
                      const granted = await filterGrantedMCPTools(decision.grantedTools ?? []);
                      for (const grantedName of granted) {
                        mcpApprovalsSet.add(grantedName);
                      }
                      mcpApprovalsSet.add(namespacedTarget);
                      requestContext.mcpApprovals = [...mcpApprovalsSet];
                    }
                  }
                }
              }
              // ────────────────────────────────────────────────────────────

              const startTime = Date.now();
              if (toolName === 'run_subagents') {
                debugLog.diagnostic({
                  layer: 'route',
                  phase: 'nested_tool_start',
                  ...logCtx(activeSessionId),
                  tool: toolName,
                  toolCallId: tc.id,
                });
              }

              const runCommandProgress = (message: string) => {
                sendEvent('tool_progress', { name: toolName, message: sanitize(message) });
              };

              const shouldSurfaceToolProgress =
                toolName === 'web_search' || toolName === 'fetch_url';
              const webToolOutput: ToolOutputSink = {
                writeLine(message: string): void {
                  sendEvent('tool_progress', {
                    name: toolName,
                    message: sanitize(message),
                  });
                },
                writeInline(_message: string): void {
                  // Ignore inline progress updates in the web UI to avoid
                  // spamming one message with token-by-token churn.
                },
                clearInline(): void {
                  // No-op for the web UI.
                },
              };

              // Subagent output sink: strips ANSI, parses the [sub-agent: id]
              // prefix that makeLabeledSink prepends, and emits per-agent SSE
              // events so the client can render each agent in its own bubble.
              // Every line is also accumulated into subagentLogContent so
              // flushSessionState persists the bubbles for the end-of-turn
              // client reload.
              const subagentOutputSink: ToolOutputSink = {
                writeLine(message: string): void {
                  const clean = sanitize(message);
                  const match = clean.match(/^\[sub-agent:\s*([^\]]+)]\s([\S\s]*)$/);
                  const agentId = match ? match[1]!.trim() : '__subagent__';
                  const text = match ? (match[2] ?? '').trimEnd() : clean.trimEnd();
                  if (text.trim()) {
                    subagentLogContent.set(
                      agentId,
                      `${subagentLogContent.get(agentId) ?? ''}${text}\n`
                    );
                    sendEvent('subagent_output', { agentId, message: text });
                  }
                },
                writeInline(_message: string): void {},
                clearInline(): void {},
                writeAgentChunk(agentId: string, type: 'thinking' | 'content', text: string): void {
                  if (text) {
                    subagentLogContent.set(agentId, (subagentLogContent.get(agentId) ?? '') + text);
                    sendEvent('subagent_chunk', { agentId, type, text });
                  }
                },
                reportTps(tps: number | null): void {
                  sendEvent('status', { phase: 'subagent', tps });
                },
              };

              // Null sink for tools that don't need web output
              const nullOutputSink: ToolOutputSink = {
                writeLine(): void {},
                writeInline(): void {},
                clearInline(): void {},
              };

              // Execute the tool via the registry. Wrap each call so an
              // exception never leaves a tool_call_id without a matching
              // tool response, which would break the OpenAI message ordering
              // contract on the next turn.
              let result: { content: string; images?: string[] };
              try {
                result = shouldSurfaceToolProgress
                  ? await handleToolCall(
                      toolName,
                      toolArgs,
                      undefined,
                      webToolOutput,
                      requestContext,
                      req.signal
                    )
                  : toolName === 'run_subagents'
                    ? await handleToolCall(
                        toolName,
                        toolArgs,
                        undefined,
                        subagentOutputSink,
                        requestContext,
                        req.signal
                      )
                    : toolName === 'run_command'
                      ? await handleToolCall(
                          toolName,
                          toolArgs,
                          runCommandProgress,
                          nullOutputSink,
                          requestContext,
                          req.signal
                        )
                      : await handleToolCall(
                          toolName,
                          toolArgs,
                          undefined,
                          nullOutputSink,
                          requestContext,
                          req.signal
                        );
              } catch (err) {
                const errorContent = err instanceof Error ? err.message : String(err);
                result = { content: `[Tool error: ${errorContent}]` };
                sendEvent('tool_progress', {
                  name: toolName,
                  message: sanitize(errorContent),
                });
              }

              const duration = Date.now() - startTime;
              if (toolName === 'run_subagents') {
                debugLog.diagnostic({
                  layer: 'route',
                  phase: 'nested_tool_end',
                  ...logCtx(activeSessionId),
                  tool: toolName,
                  toolCallId: tc.id,
                  elapsedMs: duration,
                  result: 'completed',
                });
              }

              sendEvent('tool_result', {
                name: toolName,
                result: result.content,
                duration,
                toolCallId: tc.id,
              });

              const toolMessage: ChatMessage = {
                role: 'tool',
                content: result.content,
                tool_call_id: tc.id,
              };
              if (result.images && result.images.length > 0) {
                toolMessage.images = result.images;
              }
              toolResults.push(toolMessage);
              debugLog.toolMessage({
                layer: 'route',
                action: 'push',
                role: 'tool',
                hasToolCallId: !!toolMessage.tool_call_id,
                tool_call_id: toolMessage.tool_call_id ?? null,
                contentPreview: toolMessage.content,
                contentLength: toolMessage.content.length,
                note: `tool result for "${toolName}" (tc.id=${tc.id})`,
                ...logCtx(activeSessionId),
              });
            }

            // The assistant message with tool_calls and every tool response
            // are pushed together as an atomic block. No user message can be
            // inserted between them, satisfying the OpenAI message-ordering
            // contract.
            // If any path failed to collect a result, synthesize an error
            // response for the missing tool_call_id.
            const respondedToolIds = new Set(toolResults.map((m) => m.tool_call_id));
            for (const tc of toolCalls) {
              if (!respondedToolIds.has(tc.id)) {
                toolResults.push({
                  role: 'tool',
                  content: '[Tool response missing: the tool call did not produce a result.]',
                  tool_call_id: tc.id,
                });
                debugLog.toolMessage({
                  layer: 'route',
                  action: 'synthesize',
                  role: 'tool',
                  hasToolCallId: true,
                  tool_call_id: tc.id,
                  contentPreview:
                    '[Tool response missing: the tool call did not produce a result.]',
                  note: 'synthetic missing response created in tool execution loop',
                  ...logCtx(activeSessionId),
                });
              }
            }

            // Sub-agent log bubbles are client-only during streaming; persist
            // them here (one row per agentId, before the tool results so the
            // reloaded history matches the live streaming order) or the
            // end-of-turn client reload wipes them from the UI.
            const subagentRows = [...subagentLogContent.keys()].map(takeSubagentRow);

            currentMessages.push(assistantMessage, ...toolResults);
            pendingAppends.push(...subagentRows, assistantMessage, ...toolResults);
            emptyResponseRecoveryAttempts = 0;
            debugLog.messageArraySummary(
              'tool-loop: after push',
              currentMessages,
              logCtx(activeSessionId)
            );

            // Tool results are appended to `currentMessages` AFTER the
            // authoritative anchor was set from the LLM response, so the
            // anchor is now stale (it only reflects the request that
            // produced these tool calls, not the messages we're about to
            // send back). Invalidate it so the next loop iteration does
            // a fresh `countMessagesTokens` recount — this is the
            // auto-compact gate, and trusting the stale anchor would let
            // a large tool result push us past the 92% threshold without
            // triggering compaction.
            lastAuthoritativeTokens = 0;

            // Signal we are switching back to the LLM with tool results.
            sendEvent('status', {
              phase: 'responding',
              tokensUsed: tokensUsedSoFar,
              tokenLimit: effectiveNumCtx,
              modelContextLimit,
            });

            // Persist tool results so the frontend can load them if user switches away.
            const flushResult = await flushSessionState();
            if (!flushResult.ok) {
              // Bail out of the outer tool loop; the catch handler
              // at the bottom of this block will emit an `error`
              // event and close the stream.
              throw new Error(`Write failed: ${flushResult.error}`);
            }

            // Continue the loop so the LLM can process the tool results.
            continue outer;
          }

          // -- No tool calls – this is a plain assistant message ----
          // A terminal chunk with `done_reason` "load"/"unload" is a server
          // heartbeat (e.g. Ollama loading/unloading the model), not a real
          // turn, and carries no content. It must be skipped BEFORE we push an
          // (empty) assistant message: otherwise the empty-response recovery
          // below mistakes it for a silent model and injects a phantom empty
          // assistant turn plus a fake "Your last response was empty" user
          // nudge into the persisted history.
          if (lastDoneReason === 'load' || lastDoneReason === 'unload') {
            logger.warn('chat', `Ignoring terminal chunk with done_reason=${lastDoneReason}`);
            continue outer;
          }

          currentMessages.push(assistantMessage);
          pendingAppends.push(assistantMessage);

          if (hasMeaningfulAssistantContent(assistantMessage)) {
            emptyResponseRecoveryAttempts = 0;
          } else if (emptyResponseRecoveryAttempts < MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS) {
            emptyResponseRecoveryAttempts += 1;
            const recoveryMessage: ChatMessage = {
              role: 'user',
              content:
                `${SYNTHETIC_NUDGE_MARKER}Your last response was empty. Provide a direct answer now. ` +
                `If commands are needed, call run_command. If commands already ran, summarize their output and errors.${
                  SYNTHETIC_NUDGE_END
                }`,
            };
            currentMessages.push(recoveryMessage);
            pendingAppends.push(recoveryMessage);

            // The recovery nudge is appended to `currentMessages` after the
            // authoritative token anchor was set from the LLM response. Keep
            // the token accounting uniform across all message mutations by
            // invalidating the anchor so the next loop iteration performs a
            // fresh recount instead of trusting a stale cached value.
            lastAuthoritativeTokens = 0;

            continue;
          }

          // -- No tool calls – this is the final response -----------
          // Inspect the terminal chunk's `done_reason` to distinguish a
          // natural end-of-sequence from a token-cap truncation.
          if (lastDoneReason === 'length') {
            // Response was cut off by num_predict. Surface this to
            // the client so the UI can display a truncation hint
            // (when one is implemented) and so the Prompt-loop
            // feature can tailor its continuation nudge.
            sendEvent('status', {
              phase: 'truncated',
              tokensUsed: promptEvalCount + evalCount,
              tokenLimit: effectiveNumCtx,
              modelContextLimit,
            });
          }

          // -- Prompt-loop completeness check ────────────────────────
          // When prompt-loop mode is active and the model produced a
          // non-truncated final response, ask the judge whether the
          // original user request was really satisfied. If not,
          // inject a continuation nudge and re-enter the outer LLM
          // loop. Capped at effectiveMaxPromptLoopIterations (0 = unlimited).
          if (effectiveCompletionMode === 'prompt-loop' && originalUserRequest && content.trim()) {
            const cap =
              effectiveMaxPromptLoopIterations === 0 ? Infinity : effectiveMaxPromptLoopIterations;
            const HARD_CEILING = 20;
            const effectiveCap = Math.min(cap, HARD_CEILING);
            logger.info('chat', 'Prompt-loop active', {
              cap: cap === Infinity ? '∞' : cap,
              effectiveCap,
              doneReason: lastDoneReason ?? 'undefined',
            });
            while (promptLoopIterations < effectiveCap) {
              promptLoopIterations++;
              sendEvent('status', {
                phase: 'completeness-check',
                iteration: promptLoopIterations,
                maxIterations: effectiveMaxPromptLoopIterations,
                tokensUsed: promptEvalCount + evalCount,
                tokenLimit: effectiveNumCtx,
                modelContextLimit,
              });

              // Build trace: all messages between the original user request
              // and the final assistant response — tool calls, thinking,
              // and tool results that the judge currently cannot see.
              //
              // For a resumed session where the user re-asks the same
              // question ("fix the bug" today vs yesterday), the same
              // user request may appear multiple times in `currentMessages`.
              // We anchor on the LAST occurrence so we don't pull in
              // tool-call history from a previous turn.
              const lastUserIndex = (() => {
                for (let i = currentMessages.length - 1; i >= 0; i--) {
                  const m = currentMessages[i];
                  if (m && m.role === 'user' && m.content === originalUserRequest) {
                    return i;
                  }
                }
                return -1;
              })();
              const traceMessages: ChatMessage[] = [];
              if (lastUserIndex >= 0) {
                for (let i = lastUserIndex + 1; i < currentMessages.length; i++) {
                  const msg = currentMessages[i];
                  if (!msg) continue;
                  // Stop before the final assistant response — that's
                  // already passed as `content` to the judge.
                  if (msg.role === 'assistant' && !msg.tool_calls?.length) {
                    const msgContent = (msg.content ?? '').trim();
                    if (msgContent === content.trim() && msgContent.length > 0) {
                      break;
                    }
                  }
                  traceMessages.push(msg);
                }
              }

              const { satisfied, feedback } = await checkCompleteness(
                llmRequestContext,
                model as string,
                effectiveNumCtx,
                originalUserRequest,
                content,
                traceMessages,
                req.signal
              );

              if (satisfied) {
                logger.info('chat', 'Prompt-loop: satisfied', { iterations: promptLoopIterations });
                break;
              }

              // Not satisfied — inject a continuation nudge and
              // re-enter the outer streaming loop.
              logger.info('chat', 'Prompt-loop: not satisfied, injecting nudge', {
                iteration: promptLoopIterations,
              });
              const nudgeLines = [
                `${SYNTHETIC_NUDGE_MARKER}Continue working on my original request. It is not yet complete.`,
              ];
              if (feedback) {
                nudgeLines.push(
                  '',
                  `The completeness reviewer noted these specific deficiencies:`,
                  feedback
                );
              }
              nudgeLines.push(
                '',
                `Original request: ${originalUserRequest}`,
                SYNTHETIC_NUDGE_END.trim()
              );
              const nudgeText = nudgeLines.join('\n');
              currentMessages.push({
                role: 'user',
                content: nudgeText,
              });
              // Nudge is LLM-only — keep it out of the persisted history
              // so it does not appear as a phantom user message on reload.
              // Nudge messages added to history — reset the
              // authoritative token anchor so the next iteration
              // uses the fallback estimator for auto-compaction.
              lastAuthoritativeTokens = 0;
              const flushResult = await flushSessionState();
              if (!flushResult.ok) {
                // Bail out of the outer tool loop; the catch
                // handler at the bottom of this block will
                // emit an `error` event and close the stream.
                throw new Error(`Write failed: ${flushResult.error}`);
              }
              continue outer;
            }
          }

          finalContent = content;
          finalThinking = thinking;

          // Rename the session from the placeholder to a content-derived title,
          // but only if the user hasn't already renamed it (e.g. via /title).
          const currentSessionId = activeSessionId!;
          const currentName = getSessionName(currentSessionId);
          if (
            currentName === null ||
            currentName === undefined ||
            currentName === DEFAULT_SESSION_NAME
          ) {
            const titleContent = firstContent || content;
            const titleThinking = firstThinking || thinking;
            const titleText = titleThinking ? `${titleContent}\n${titleThinking}` : titleContent;
            renameSession(
              currentSessionId,
              generateFallbackTitle(sanitizeContentForTitle(titleText))
            );

            // Fire-and-forget background task to generate a proper LLM-based title.
            // The fallback title is already set above, so this is purely an upgrade.
            generateSessionTitle(
              compactionLlmRequestContext,
              effectiveCompactionModel,
              currentMessages,
              compactionNumCtx,
              undefined, // no onProgress (SSE stream is closing)
              undefined // no think override
            )
              .then((title) => enqueueSessionRename(currentSessionId, title))
              .catch(() => {
                // Background title generation failed — the fallback title is already set.
                // Silently ignore — the user can still use /title manually.
              });
          }

          // Persist final state (append any remaining server-generated
          // messages to the latest DB state).
          const flushResult = await flushSessionState();
          if (!flushResult.ok) {
            // Bail out of the outer tool loop; the catch handler
            // at the bottom of this block will emit an `error`
            // event and close the stream. Do NOT send `done` —
            // the client must see the failure so it does not
            // treat this turn as a successful final response.
            throw new Error(`Write failed: ${flushResult.error}`);
          }

          const totalTokens = promptEvalCount + evalCount;

          // Compute tokens-per-second from Ollama's nanosecond durations.
          // evalDuration is the generation phase; promptEvalDuration is the prompt-processing phase.
          const promptTps =
            promptEvalDuration > 0
              ? +(promptEvalCount / (promptEvalDuration / 1_000_000_000)).toFixed(2)
              : undefined;
          const evalTps =
            evalDuration > 0 ? +(evalCount / (evalDuration / 1_000_000_000)).toFixed(2) : undefined;
          const effectiveEvalTps = evalTps ?? wallClockTps;

          sendEvent('done', {
            content: finalContent,
            thinking: finalThinking,
            sessionId: currentSessionId,
            tokenStats: {
              promptEvalCount,
              evalCount,
              totalTokens,
              tokenLimit: effectiveNumCtx,
              modelContextLimit,
              ...(typeof promptTps === 'number' ? { promptTps } : {}),
              ...(typeof effectiveEvalTps === 'number' ? { evalTps: effectiveEvalTps } : {}),
            },
            doneReason: lastDoneReason && lastDoneReason !== 'unknown' ? lastDoneReason : 'stop',
          });

          controller.close();
          return;
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // Save whatever we have so far before closing. Sub-agent log
          // rows are flushed too — an interrupted run_subagents batch
          // should still leave its bubbles in the reloaded history.
          flushRemainingSubagentLogs();
          if (activeSessionId !== undefined && sessionExists(activeSessionId)) {
            await flushSessionState().catch((err_) => {
              logger.error('chat', 'Abort flush failed', { error: err_ });
            });
          }
          try {
            controller.close();
          } catch {
            /* ignore */
          }
          return;
        }

        const message = await getLlmApiErrorMessage(llmRequestContext, err);
        // Use the actual provider for the log tag — previously this was
        // hard-coded to 'ollama' which silently misattributed every
        // OpenAI-compatible 400 (and any non-Ollama error) to the Ollama
        // adapter in logs.
        const errorLogTag = llmRequestContext.provider ?? 'ollama';
        logger.error(errorLogTag, message, { error: err, requestId });

        // Parse the model's actual context limit from 400 error responses.
        // OpenAI-compatible providers don't expose context window via
        // /v1/models, but the 400 error message contains it. The cap
        // is folded back into the resolver's cache so the next turn
        // uses the correct value without another 400; the SSE stream
        // is notified via the existing `status` channel so the client
        // can update its in-memory display.
        const discoveredLimit = parseContextLimitFromError(message);
        if (discoveredLimit !== null && discoveredLimit !== effectiveNumCtx) {
          effectiveNumCtx = discoveredLimit;
          modelContextLimit = discoveredLimit;
          recordDiscoveredCap(
            activeProvider?.baseUrl ?? effectiveBaseUrl,
            model as string,
            discoveredLimit
          );
          try {
            sendEvent('status', {
              phase: 'context_limit_adjusted',
              tokenLimit: discoveredLimit,
              modelContextLimit: discoveredLimit,
            });
          } catch {
            // Controller may already be closed – ignore.
          }
        }

        // Parse the error message for a "vision not supported" signal.
        // When matched, record the (baseUrl, model) as non-vision in
        // the vision cache and notify the client so the ChatInput
        // warning UI can update for future image attachments in this
        // session. See `src/services/visionCache.ts` and
        // `parseVisionUnsupportedFromError` in
        // `src/services/llmContextLimit.ts` for the matcher details.
        const visionNotSupported = parseVisionUnsupportedFromError(message);
        if (visionNotSupported) {
          recordDiscoveredNonVision(
            activeProvider?.baseUrl ?? effectiveBaseUrl,
            model as string,
            activeProvider?.provider ?? 'ollama'
          );
          try {
            sendEvent('status', { phase: 'vision_unsupported' });
          } catch {
            // Controller may already be closed – ignore.
          }
        }

        // Parse the error message for an "unsupported sampling parameter"
        // signal. When matched, record the verdict in the sampling-params
        // cache so the next turn omits the field, and notify the client
        // via the SSE `status` channel so the UI can surface an
        // indicator. The matcher returns the upstream's param name
        // verbatim; we map it onto the standard sampling-param registry
        // before recording. See `parseUnsupportedParamFromError` in
        // `src/services/llmContextLimit.ts` and
        // `recordDiscoveredUnsupportedParam` in
        // `src/services/samplingParamsCache.ts`.
        const unsupportedParam = parseUnsupportedParamFromError(message);
        if (unsupportedParam && isKnownSamplingParam(unsupportedParam)) {
          const param = unsupportedParam as SamplingParamName;
          recordDiscoveredUnsupportedParam(
            activeProvider?.baseUrl ?? effectiveBaseUrl,
            model as string,
            param,
            activeProvider?.provider ?? 'ollama'
          );
          try {
            sendEvent('status', { phase: 'sampling_param_unsupported', param });
          } catch {
            // Controller may already be closed – ignore.
          }
        }

        try {
          sendEvent('error', { message });
        } catch {
          // Controller may already be closed – ignore.
        }
      } finally {
        debugLog.diagnostic({
          layer: 'route',
          phase: 'cleanup',
          ...logCtx(activeSessionId),
          result: req.signal.aborted ? 'aborted' : 'closed',
        });
        if (activeSessionId !== undefined) {
          unregisterActiveTurn(activeSessionId, requestId);
        }
        stopKeepalive();
        try {
          controller.close();
        } catch {
          // Already closed – ignore.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': SSE_CONTENT_TYPE,
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
