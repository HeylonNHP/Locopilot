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
 * SSE event types:
 *   event: thinking\ndata: <string>\n\n
 *   event: chunk\ndata: <string>\n\n
 *   event: tool_call\ndata: {"name":"…","arguments":{…}}\n\n
 *   event: tool_result\ndata: {"name":"…","result":"…","duration":123}\n\n
 *   event: status\ndata: {"phase":"thinking"|"responding"|"tools"|"truncated"|"completeness-check","tokensUsed":N,"tokenLimit":N}\n\n
 *   event: done\ndata: {"content":"…","thinking":"…","sessionId":N,"tokenStats":{…},"doneReason":"stop"|"length"}\n\n
 *   event: error\ndata: {"message":"…"}\n\n
 */

import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';

import type { ToolDefinition } from '@/services/adapters/llmAdapter';
import type { Config } from '@/types/chatConfig';

import {
  AUTO_COMPACT_THRESHOLD_PCT,
  DEFAULT_NUM_CTX,
  DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
  DEFAULT_SESSION_NAME,
  MCP_TOOL_SEARCH_THRESHOLD,
} from '@/constants';
import { createSession, getSessionName, renameSession, sessionExists } from '@/history';
import { getMCPServerConfig, getMCPToolCount, getMergedMCPToolDefinitions, getMergedMCPToolDefinitionsForSearch } from '@/mcp';
import { createSystemPrompt } from '@/services/chatSession';
import { compactHistory } from '@/services/compact';
import { loadConfig } from '@/services/configManager';
import { resolveCompactionModel } from '@/services/modelManager';
import { checkCompleteness } from '@/services/promptLoop';
import { discoverSkills, getAllowedToolsFromSkills, getEnabledSkills, loadSkillState } from '@/services/skillManager';
import { sanitizeChatMessage, stripSpecialTokens } from '@/services/textUtils';
import { generateSessionTitle, sanitizeContentForTitle } from '@/services/titleGeneration';
import { generateFallbackTitle } from '@/services/titleUtils';
import { countMessagesTokens, countTextTokens } from '@/services/tokenizer';
import { enterRequestScope } from '@/tools/impl/runCommandTool';
import { handleToolCall, type RequestContext, sanitize, type ToolOutputSink, TOOLS } from '@/tools/tools';

import {
  type ChatMessage,
  fetchLlmModelInfo,
  getLlmApiErrorMessage,
  getLlmModelVisionSupport,
  type PersistedChatMessage,
  sendLlmChatStream,
  type StreamChatParams,
} from '../../../services/llm';
import { type ApprovalDecision, resolveApproval, waitForApproval } from '../../lib/approvalRegistry';
import { logger } from '../../lib/logger';
import { enqueueSessionRename, enqueueSessionWrite } from '../../lib/sessionWriteQueue';

// Prevent static generation – this route must always run on the server.
export const dynamic = 'force-dynamic';

const MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 3;
const CHANNEL_LABEL_ONLY_PATTERN = /^\s*(?:thought|analysis|final|commentary)\s*$/i;
const VALID_DONE_REASONS = new Set(['stop', 'length', 'load', 'unload']);

/** Client message shape: the LLM-protocol ChatMessage plus the UI-only subagent_log role. */
type ClientChatMessage = ChatMessage | { role: 'subagent_log'; content: string; subagentId?: string };

function isClientChatMessage(value: unknown): value is ClientChatMessage {
    if (typeof value !== 'object' || value === null) return false;
    const msg = value as Record<string, unknown>;
    if (typeof msg.role !== 'string' || typeof msg.content !== 'string') return false;
    if (msg.role === 'subagent_log') return true;
    return msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool';
}

/** Compare two persisted messages for the initial-state merge. */
function messagesEqual(a: PersistedChatMessage, b: PersistedChatMessage): boolean {
    if (a.role !== b.role) return false;
    if (a.content !== b.content) return false;
    if (a.role === 'subagent_log' && b.role === 'subagent_log') {
        return (a as { role: 'subagent_log'; subagentId?: string }).subagentId ===
            (b as { role: 'subagent_log'; subagentId?: string }).subagentId;
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
    client: PersistedChatMessage[],
): PersistedChatMessage[] {
    let prefix = 0;
    const maxPrefix = Math.min(fresh.length, client.length);
    while (prefix < maxPrefix && messagesEqual(fresh[prefix]!, client[prefix]!)) {
        prefix++;
    }
    return [...fresh, ...client.slice(prefix)];
}

function sanitizeAssistantTextFragment(text: string): string {
    const cleaned = stripSpecialTokens(text ?? '');
    return CHANNEL_LABEL_ONLY_PATTERN.test(cleaned.trim()) ? '' : cleaned;
}

function hasMeaningfulAssistantContent(message: ChatMessage): boolean {
    const cleanedContent = sanitizeAssistantTextFragment(message.content ?? '').trim();
    if (cleanedContent.length === 0) {
        return false;
    }

    return !CHANNEL_LABEL_ONLY_PATTERN.test(cleanedContent);
}

export async function POST(req: NextRequest): Promise<Response> {
    // ── Parse & validate the request body ──────────────────────────────
    let body: Record<string, unknown>;
    try {
        body = await req.json() as Record<string, unknown>;
    } catch {
        return new Response(
            `event: error\ndata: ${JSON.stringify({ message: 'Invalid JSON body' })}\n\n`,
            {
                status: 400,
                headers: { 'Content-Type': 'text/event-stream' },
            },
        );
    }

    const messages: unknown = body.messages;
    const model: unknown = body.model;
    const numCtx: unknown = body.numCtx;
    const sessionId: unknown = body.sessionId;
    const baseUrl: unknown = body.baseUrl;
    const think: unknown = body.think;
    const chatTimeoutMs: unknown = body.chatTimeoutMs;
    const completionMode: unknown = body.completionMode;
    const maxPromptLoopIterations: unknown = body.maxPromptLoopIterations;

    // -- Validation ------------------------------------------------
    if (typeof model !== 'string' || !model.trim()) {
        return new Response(
            `event: error\ndata: ${JSON.stringify({ message: 'Model name is required' })}\n\n`,
            {
                status: 400,
                headers: { 'Content-Type': 'text/event-stream' },
            },
        );
    }

    if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isClientChatMessage)) {
        return new Response(
            `event: error\ndata: ${JSON.stringify({ message: 'Messages array is required and must contain valid message objects' })}\n\n`,
            {
                status: 400,
                headers: { 'Content-Type': 'text/event-stream' },
            },
        );
    }

    const typedMessages: ClientChatMessage[] = messages;

    const effectiveBaseUrl = typeof baseUrl === 'string' && baseUrl.trim()
        ? baseUrl.trim()
        : 'http://localhost:11434';

    const effectiveNumCtx = typeof numCtx === 'number' && Number.isFinite(numCtx) && numCtx > 0
        ? Math.floor(numCtx)
        : DEFAULT_NUM_CTX;

    const effectiveChatTimeoutMs = typeof chatTimeoutMs === 'number' && Number.isFinite(chatTimeoutMs) && chatTimeoutMs > 0
        ? Math.floor(chatTimeoutMs)
        : DEFAULT_OLLAMA_CHAT_TIMEOUT_MS;

    const parsedSessionId = typeof sessionId === 'number'
        ? sessionId
        : undefined;

    const effectiveCompletionMode = typeof completionMode === 'string' && completionMode === 'prompt-loop'
        ? 'prompt-loop'
        : 'normal';

    const effectiveMaxPromptLoopIterations = typeof maxPromptLoopIterations === 'number'
        && Number.isFinite(maxPromptLoopIterations)
        ? Math.max(0, Math.floor(maxPromptLoopIterations))
        : 4;

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
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller): Promise<void> {
            // Create a per-request process registry so concurrent requests
            // cannot see each other's running commands.
            enterRequestScope();

            function sendEvent(event: string, data: unknown): void {
                try {
                    controller.enqueue(
                        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
                    );
                } catch {
                    // Client disconnected — safe to ignore
                }
            }

            let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

            function isRetryableError(err: unknown): boolean {
                const e = err as Record<string, any> | null | undefined;
                if (!e) return false;
                // axios-style HTTP errors
                if (e.response && typeof e.response.status === 'number') {
                    const status = e.response.status;
                    if (status === 429 || status === 502 || status === 503 || status === 504) return true;
                }
                // axios network-level codes
                if (typeof e.code === 'string' && (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'EPIPE')) return true;
                // generic fetch/network failures
                if (typeof e.message === 'string' && (e.message.includes('fetch failed') || e.message.includes('network timeout'))) return true;
                return false;
            }

            function startKeepalive(): void {
                if (keepaliveInterval) return;
                keepaliveInterval = setInterval(() => {
                    try {
                        controller.enqueue(encoder.encode(': \n\n'));
                    } catch {
                        // Client disconnected – ignore.
                    }
                }, 5000);
            }

            function stopKeepalive(): void {
                if (keepaliveInterval) {
                    clearInterval(keepaliveInterval);
                    keepaliveInterval = null;
                }
            }

            startKeepalive();

            // Strip any system messages from the client and inject a fresh system prompt
            // so the model always sees the current date, tool definitions, and policy.
            const conversationMessages: ClientChatMessage[] = structuredClone(typedMessages);

            let finalContent = '';
            let finalThinking = '';
            // Compaction model resolved from config (set below); starts as the chat model.
            let effectiveCompactionModel: string = model as string;
            // Last authoritative token count from Ollama; used by the auto-compact
            // check so it stays anchored to the latest exact provider count.
            let lastAuthoritativeTokens = 0;
            // Whether YOLO mode is active (set from config below). When true,
            // run_command skips the approval gate and executes unconditionally.
            let effectiveYolo = false;
            let emptyResponseRecoveryAttempts = 0;
            // Server-generated messages that have not yet been persisted.
            // flushSessionState appends these to the fresh DB message list.
            // Compaction uses a full replacement instead.
            const pendingAppends: PersistedChatMessage[] = [];
            let pendingReplace: PersistedChatMessage[] | null = null;

            async function flushSessionState(): Promise<void> {
                if (activeSessionId === undefined) return;
                const sessionId = activeSessionId;
                // Race: session may have been deleted mid-stream by another tab.
                if (!sessionExists(sessionId)) return;

                if (pendingReplace) {
                    const replacement = pendingReplace;
                    pendingReplace = null;
                    await enqueueSessionWrite(
                        sessionId,
                        () => replacement,
                        { promptEvalCount, evalCount },
                    );
                } else if (pendingAppends.length > 0) {
                    const appends = [...pendingAppends];
                    await enqueueSessionWrite(
                        sessionId,
                        (fresh) => [...fresh, ...appends],
                        { promptEvalCount, evalCount },
                    );
                    pendingAppends.length = 0;
                }
            }

            const systemMessage: ChatMessage = {
                role: 'system',
                content: createSystemPrompt(undefined, effectiveYolo),
            };

            // Snapshot the client's original non-system messages in their original order.
            // These include subagent_log messages which are NOT sent to the LLM.
            const originalClientMessages: ClientChatMessage[] = conversationMessages.filter(
                (m): m is ClientChatMessage =>
                    typeof m === 'object' && m !== null &&
                    'role' in m && typeof (m as { role: unknown }).role === 'string' &&
                    (m as { role: string }).role !== 'system' &&
                    typeof (m as { content: unknown }).content === 'string',
            );

            // Build the LLM working array: system prompt + client messages excluding subagent_log.
            const currentMessages: ChatMessage[] = [
                systemMessage,
                ...originalClientMessages.filter((m): m is ChatMessage => m.role !== 'subagent_log'),
            ];

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
                sendEvent('error', { message: 'Session not found. It may have been deleted in another tab.' });
                controller.close();
                return;
            }

            try {
                if (!activeSessionId) {
                    activeSessionId = createSession(DEFAULT_SESSION_NAME, model as string);
                    sendEvent('session_created', { sessionId: activeSessionId });
                }

                // Persist the client's messages (including subagent_log entries) as
                // the base state for this request.  Merging avoids clobbering any
                // messages written concurrently from another tab.
                await enqueueSessionWrite(
                    activeSessionId,
                    (fresh) => mergeClientMessages(fresh, originalClientMessages as PersistedChatMessage[]),
                );
                // Per-request MCP approval set. Mutated in place when the user
                // resolves an approval_request event for a specific mcp_call.
                const mcpApprovalsSet = new Set<string>();

                // Load runtime tool configuration from disk so that web search
                // and YOLO settings reflect the latest user preferences.
                // Build per-request context from config (no global state setters).
                let requestContext: RequestContext;
                let disabledSubAgent: string[] = [];

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
                        if (req.signal.aborted) { resolve({ approved: false }); return; }
                        req.signal.addEventListener('abort', () => resolve({ approved: false }), { once: true });
                    });
                    sendEvent('approval_request', {
                        requestId: subRequestId,
                        toolName: req2.toolName,
                        args: req2.args,
                        fromSubAgent: true,
                    });
                    const decision = await Promise.race([
                        waitForApproval(subRequestId, req2),
                        abortPromise,
                    ]);
                    resolveApproval(subRequestId, { approved: false });
                    return decision;
                };

                // Hoisted config so the merged-tool-list decision below
                // can read `config.mcpToolSearch` even when loadConfig()
                // throws. The inner try/catch owns the user-config
                // derivation; the outer build path is independent.
                let config: Config | null = null;
                try {
                    config = await loadConfig();
                    if (config) {
                        if (typeof config.yolo === 'boolean') {
                            effectiveYolo = config.yolo;
                        }

                        effectiveCompactionModel = resolveCompactionModel(config.compactionModel, model as string);
                    }

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

                    const disabledMain = config?.tools?.disabledMain ?? [];
                    disabledSubAgent = config?.tools?.disabledSubAgent ?? [];
                    requestContext = {
                        yoloMode: config?.yolo ?? false,
                        allowedTools,
                        disabledMainTools: disabledMain,
                        mcpApprovals: [...mcpApprovalsSet],
                        model: model as string,
                        numCtx: effectiveNumCtx,
                        webSearch: {
                            maxQueries: config?.webSearch?.maxQueries ?? 3,
                            resultsPerQuery: config?.webSearch?.resultsPerQuery ?? 3,
                            requestTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
                            perPageCharLimit: config?.webSearch?.perPageCharLimit ?? 5000,
                            baseUrl: config?.baseUrl || effectiveBaseUrl,
                            compactionModel: resolveCompactionModel(config?.compactionModel ?? '', model as string),
                        },
                        subAgent: {
                            baseUrl: config?.baseUrl || effectiveBaseUrl,
                            model: model as string,
                            numCtx: effectiveNumCtx,
                            compactionModel: resolveCompactionModel(config?.compactionModel ?? '', model as string),
                            tools: TOOLS.filter((tool) => tool.function.name !== 'run_subagents' && !disabledSubAgent.includes(tool.function.name)),
                            // Seed the sub-agent's mcpApprovals ledger with
                            // whatever the parent route has already approved
                            // this turn (e.g. an earlier `mcp_call` from the
                            // main agent on the same target). The route hands
                            // over a fresh `Array.from(...)` snapshot; the
                            // sub-agent's loop maintains its OWN local set
                            // (Phase 3.4) so the parent's per-turn ledger is
                            // never mutated by the sub-agent's own approvals.
                            mcpApprovals: [...mcpApprovalsSet],
                            approvalRequester: requestSubAgentApproval,
                        },
                    };
                } catch {
                    // Config load is best-effort; defaults already apply.
                    requestContext = {
                        yoloMode: false,
                        allowedTools: undefined,
                        disabledMainTools: [],
                        mcpApprovals: [...mcpApprovalsSet],
                        model: model as string,
                        numCtx: effectiveNumCtx,
                        webSearch: {
                            maxQueries: 3,
                            resultsPerQuery: 3,
                            requestTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
                            perPageCharLimit: 5000,
                            baseUrl: effectiveBaseUrl,
                            compactionModel: model as string,
                        },
                        subAgent: {
                            baseUrl: effectiveBaseUrl,
                            model: model as string,
                            numCtx: effectiveNumCtx,
                            compactionModel: model as string,
                            tools: TOOLS.filter((tool) => tool.function.name !== 'run_subagents' && !disabledSubAgent.includes(tool.function.name)),
                            mcpApprovals: [...mcpApprovalsSet],
                            approvalRequester: requestSubAgentApproval,
                        },
                    };
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
                    const enableSearch = config?.mcpToolSearch === true || totalMCPToolCount > MCP_TOOL_SEARCH_THRESHOLD;
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
                            !disabled.has(tool.function.name),
                    );
                }

                // Determine vision support for the selected model so we can strip
                // image attachments when the model does not support them.
                let visionSupported: boolean | undefined = undefined;
                try {
                    const modelInfo = await fetchLlmModelInfo(effectiveBaseUrl, model as string);
                    visionSupported = getLlmModelVisionSupport(modelInfo);
                } catch {
                    // Best-effort: if model info is unavailable, preserve current
                    // behaviour (images sent, fetch_image tool included).
                }

                // Refresh the system prompt now that yolo and vision support are known.
                currentMessages[0] = {
                    role: 'system',
                    content: createSystemPrompt(visionSupported, effectiveYolo),
                };

                // ── Main tool-calling loop ──────────────────────────────────
                outer: while (true) {

                    // Auto-compact when approaching the context limit, mirroring the
                    // server-side autoCompactIfNeeded() logic in services/chatSession.ts.
                    if (effectiveNumCtx > 0) {
                        const tokensUsed = lastAuthoritativeTokens > 0
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
                            });
                            try {
                                const compactResult = await compactHistory(
                                    effectiveBaseUrl,
                                    effectiveCompactionModel,
                                    currentMessages,
                                    effectiveNumCtx,
                                    (message: string) => {
                                        sendEvent('compact_progress', { message });
                                    },
                                    1,
                                    2,
                                    undefined,
                                    req.signal,
                                );
                                // Replace server-side history with the compacted result.
                                const preservedSystemMessage = currentMessages[0];
                                if (!preservedSystemMessage || preservedSystemMessage.role !== 'system') {
                                    throw new Error('Cannot compact: missing system prompt.');
                                }
                                currentMessages.splice(0, currentMessages.length, preservedSystemMessage, ...compactResult.newMessages);
                                // LLM-only nudge – not sent to the client and not persisted.
                                currentMessages.push({
                                    role: 'user',
                                    content:
                                        'The conversation history was automatically compacted due to context length. ' +
                                        'Please continue working on the original task without asking for confirmation.',
                                });
                                // Persist compacted history so the frontend sees the reduced state.
                                pendingReplace = [...currentMessages];
                                await flushSessionState();
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
                                    });
                                }
                            } catch {
                                // Non-fatal — log and continue with existing messages.
                                sendEvent('status', {
                                    phase: 'compact_failed',
                                    tokensUsed,
                                    tokenLimit: effectiveNumCtx,
                                });
                            }
                        }
                    }

                    // Signal that we are about to start an LLM call.
                    const promptEstimate = countMessagesTokens(currentMessages, model as string);
                    sendEvent('status', {
                        phase: 'thinking',
                        tokensUsed: promptEstimate,
                        tokenLimit: effectiveNumCtx,
                        isEstimated: true,
                    });

                    // -- Call the LLM via the active adapter ------------------
                    const params: StreamChatParams = {
                        model: model as string,
                        messages: currentMessages,
                        tools: requestContext.disabledMainTools?.length
                            ? mergedTools.filter((t) => !requestContext.disabledMainTools!.includes(t.function.name))
                            : mergedTools,
                        numCtx: effectiveNumCtx,
                        signal: req.signal,
                        timeoutMs: effectiveChatTimeoutMs,
                    };
                    if (thinkEnabled !== undefined) {
                        params.think = thinkEnabled;
                    }
                    if (visionSupported !== undefined) {
                        params.visionSupported = visionSupported;
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
                    // Captured on the chunk with `done: true`. Distinguishes a natural
                    // end-of-sequence (`stop`) from a token-cap truncation (`length`)
                    // and from server heartbeats (`load` / `unload`). The chat route
                    // never previously consulted this field.
                    let lastDoneReason: string | undefined;

                    // ── Retry transient LLM errors (503, 502, 504, 429, network) ──
                    const MAX_LLM_RETRIES = 3;
                    const RETRY_BASE_DELAY_MS = 1000;
                    let retryAttempt = 0;
                    let firstContent = '';
                    let firstThinking = '';

                    while (true) {
                        try {
                            streamStartMs = Date.now();
                            roughTokens = 0;
                            lastTpsStatusMs = 0;

                            const llmStream = sendLlmChatStream(effectiveBaseUrl, params);

                            for await (const chunk of llmStream) {
                                const msg = chunk.message;

                            // Stream thinking token chunks (e.g. for deep-thinking models).
                            if (msg?.thinking) {
                                const thinkingChunk = sanitizeAssistantTextFragment(msg.thinking);
                                if (thinkingChunk) {
                                    thinking += thinkingChunk;
                                    sendEvent('thinking', thinkingChunk);
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
                                    sendEvent('chunk', contentChunk);
                                    roughTokens += countTextTokens(contentChunk, model as string);
                                }
                            }

                            // Live token count for t/s display — emit at most once every 800 ms.
                            if (roughTokens > 0) {
                                const now = Date.now();
                                if (now - lastTpsStatusMs > 800) {
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
                                    lastDoneReason = (typeof chunk.done_reason === 'string' && VALID_DONE_REASONS.has(chunk.done_reason))
                                    ? chunk.done_reason
                                    : undefined;
                                }
                            }

                            // Wall-clock fallback in case Ollama durations are missing.
                            const wallClockElapsedMs = Date.now() - streamStartMs;
                            wallClockTps = (evalCount > 0 && wallClockElapsedMs > 0)
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
                            if (retryAttempt >= MAX_LLM_RETRIES - 1 || !isRetryableError(err)) {
                                logger.error(
                                    'ollama',
                                    `Request failed permanently (attempt ${retryAttempt + 1}/${MAX_LLM_RETRIES})`,
                                    { error: err },
                                );
                                throw err; // propagate to outer catch
                            }
                            retryAttempt++;

                            logger.warn(
                                'ollama',
                                `Request failed, retrying (attempt ${retryAttempt}/${MAX_LLM_RETRIES})`,
                                { error: err },
                            );

                            sendEvent('status', { phase: 'retrying', attempt: retryAttempt, maxRetries: MAX_LLM_RETRIES });
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
                            lastDoneReason = undefined;

                            // Exponential backoff with abort-signal awareness
                            const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, retryAttempt - 1);
                            if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                            await new Promise<void>((resolve) => {
                                const timer = setTimeout(resolve, delayMs);
                                const onAbort = () => { clearTimeout(timer); resolve(); };
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

                    currentMessages.push(assistantMessage);
                    pendingAppends.push(assistantMessage);

                    if ((!toolCalls || toolCalls.length === 0) && !hasMeaningfulAssistantContent(assistantMessage)) {
                        if (emptyResponseRecoveryAttempts < MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS) {
                            emptyResponseRecoveryAttempts += 1;
                            currentMessages.push({
                                role: 'user',
                                content:
                                    'Your last response was empty. Provide a direct answer now. ' +
                                    'If commands are needed, call run_command. If commands already ran, summarize their output and errors.',
                            });
                            pendingAppends.push({
                                role: 'user',
                                content:
                                    'Your last response was empty. Provide a direct answer now. ' +
                                    'If commands are needed, call run_command. If commands already ran, summarize their output and errors.',
                            });
                            continue;
                        }
                    } else {
                        emptyResponseRecoveryAttempts = 0;
                    }

                    // -- Handle tool calls if present -------------------------
                    if (toolCalls && toolCalls.length > 0) {
                        sendEvent('status', {
                            phase: 'tools',
                            tokensUsed: promptEvalCount + evalCount,
                            tokenLimit: effectiveNumCtx,
                        });

                        const tokensUsedSoFar = promptEvalCount + evalCount;

                        for (const tc of toolCalls) {
                            const toolName = tc.function.name;
                            let toolArgs = tc.function.arguments;
                            if (typeof toolArgs === 'string') {
                                try { toolArgs = JSON.parse(toolArgs); } catch { /* keep string as-is on parse failure */ }
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
                                    if (req.signal.aborted) { resolve({ approved: false }); return; }
                                    req.signal.addEventListener('abort', () => resolve({ approved: false }), { once: true });
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
                                    currentMessages.push({ role: 'tool', content: rejectedResult, tool_call_id: tc.id });
                                    pendingAppends.push({ role: 'tool', content: rejectedResult, tool_call_id: tc.id });
                                    continue;
                                }
                            }
                            // ────────────────────────────────────────────────────────────

                            // ── Approval gate for mcp_call (skipped in YOLO mode or when
                            //    the namespaced target is in the per-server autoApprove
                            //    list). Phase 1 keeps the gate inline; Phase 2 should
                            //    unify this with the run_command flow + generalise
                            //    approvalRegistry to any tool name. ────────────────
                            if (toolName === 'mcp_call' && !effectiveYolo) {
                                // Parse the requested target up-front so we can
                                // apply the autoApprove / already-approved
                                // short-circuits before doing any UI work.
                                const requestedServer = typeof toolArgs?.server === 'string' ? toolArgs.server : '';
                                const requestedTool = typeof toolArgs?.tool === 'string' ? toolArgs.tool : '';
                                const namespacedTarget = requestedServer && requestedTool
                                    ? `mcp__${requestedServer}__${requestedTool}`
                                    : null;

                                if (namespacedTarget) {
                                    // A6: if the user already approved this
                                    // namespaced target earlier in the same
                                    // request (e.g. it was the first tool
                                    // call in a multi-step plan), skip the
                                    // prompt and proceed directly.
                                    if (mcpApprovalsSet.has(namespacedTarget)) {
                                        // Proceed without re-prompting.
                                    } else {
                                        // A5: honour the server's `autoApprove`
                                        // list. If the tool is on the list, the
                                        // user has already pre-authorised it
                                        // (and the dispatcher enforces the same
                                        // check, so the call will not be
                                        // rejected by the dispatcher).
                                        let autoApproved = false;
                                        try {
                                            const serverCfg = await getMCPServerConfig(requestedServer);
                                            if (serverCfg?.autoApprove?.includes(requestedTool)) {
                                                autoApproved = true;
                                            }
                                        } catch {
                                            // Best-effort: if config lookup
                                            // fails, fall through to the prompt.
                                        }

                                        if (autoApproved) {
                                            mcpApprovalsSet.add(namespacedTarget);
                                            requestContext.mcpApprovals = [...mcpApprovalsSet];
                                        } else {
                                            const requestId = randomUUID();

                                            const abortPromise = new Promise<ApprovalDecision>((resolve) => {
                                                if (req.signal.aborted) { resolve({ approved: false }); return; }
                                                req.signal.addEventListener('abort', () => resolve({ approved: false }), { once: true });
                                            });

                                            sendEvent('approval_request', {
                                                requestId,
                                                toolName,
                                                toolCallName: namespacedTarget,
                                                args: toolArgs,
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
                                                currentMessages.push({ role: 'tool', content: rejectedResult, tool_call_id: tc.id });
                                                pendingAppends.push({ role: 'tool', content: rejectedResult, tool_call_id: tc.id });
                                                continue;
                                            }

                                            // H1 bug-hunt fix: when the user
                                            // approves, the decision may carry
                                            // a `grantedTools` list of
                                            // additional namespaced targets the
                                            // user wants to pre-authorise.
                                            // `/api/approve` already filtered
                                            // the list to well-formed
                                            // `mcp__<server>__<tool>` names;
                                            // here we additionally verify the
                                            // server is actually configured so a
                                            // client can't pre-authorise tools
                                            // for a server that doesn't exist.
                                            const granted = decision.grantedTools ?? [];
                                            for (const grantedName of granted) {
                                                const grantedServer = grantedName.slice(
                                                    'mcp__'.length,
                                                    grantedName.lastIndexOf('__'),
                                                );
                                                try {
                                                    const grantedCfg = await getMCPServerConfig(grantedServer);
                                                    if (grantedCfg) {
                                                        mcpApprovalsSet.add(grantedName);
                                                    }
                                                } catch {
                                                    // Best-effort: skip namespaced
                                                    // targets we can't verify.
                                                }
                                            }

                                            // Always record the immediate call
                                            // for any future repeat in this
                                            // request.
                                            mcpApprovalsSet.add(namespacedTarget);
                                            requestContext.mcpApprovals = [...mcpApprovalsSet];
                                        }
                                    }
                                }
                            }
                            // ────────────────────────────────────────────────────────────

                            const startTime = Date.now();

                            const runCommandProgress = (message: string) => {
                                sendEvent('tool_progress', { name: toolName, message: sanitize(message) });
                            };

                            const shouldSurfaceToolProgress = toolName === 'web_search' || toolName === 'fetch_url';
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
                            const subagentOutputSink: ToolOutputSink = {
                                writeLine(message: string): void {
                                    const clean = sanitize(message);
                                    const match = clean.match(/^\[sub-agent:\s*([^\]]+)]\s([\S\s]*)$/);
                                    const agentId = match ? match[1]!.trim() : '__subagent__';
                                    const text = match ? (match[2] ?? '').trimEnd() : clean.trimEnd();
                                    if (text.trim()) {
                                        sendEvent('subagent_output', { agentId, message: text });
                                    }
                                },
                                writeInline(_message: string): void {},
                                clearInline(): void {},
                                writeAgentChunk(agentId: string, type: 'thinking' | 'content', text: string): void {
                                    if (text) {
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

                            // Execute the tool via the registry.
                            const result = shouldSurfaceToolProgress
                                ? await handleToolCall(toolName, toolArgs, undefined, webToolOutput, requestContext, req.signal)
                                : toolName === 'run_subagents'
                                    ? await handleToolCall(toolName, toolArgs, undefined, subagentOutputSink, requestContext, req.signal)
                                    : toolName === 'run_command'
                                        ? await handleToolCall(toolName, toolArgs, runCommandProgress, nullOutputSink, requestContext, req.signal)
                                        : await handleToolCall(toolName, toolArgs, undefined, nullOutputSink, requestContext, req.signal);

                            const duration = Date.now() - startTime;

                            sendEvent('tool_result', {
                                name: toolName,
                                result: result.content,
                                duration,
                            });

                            const toolMessage: ChatMessage = {
                                role: 'tool',
                                content: result.content,
                                tool_call_id: tc.id,
                            };
                            if (result.images && result.images.length > 0) {
                                toolMessage.images = result.images;
                            }
                            currentMessages.push(toolMessage);
                            pendingAppends.push(toolMessage);
                        }

                        // Signal we are switching back to the LLM with tool results.
                        sendEvent('status', {
                            phase: 'responding',
                            tokensUsed: tokensUsedSoFar,
                            tokenLimit: effectiveNumCtx,
                        });

                        // Persist tool results so the frontend can load them if user switches away.
                        await flushSessionState();

                        // Continue the loop so the LLM can process the tool results.
                        continue outer;
                    }

                    // -- No tool calls – this is the final response -----------
                    // Inspect the terminal chunk's `done_reason` to distinguish a
                    // natural end-of-sequence from a token-cap truncation or a
                    // server heartbeat. The reason field augments the existing
                    // content-based "no tool calls = final" check; it never
                    // replaces it (some local providers can return
                    // done_reason="stop" even when tool_calls is populated).
                    if (lastDoneReason === 'load' || lastDoneReason === 'unload') {
                        // Server heartbeat with `done: true` — not a real turn.
                        // Skip it and let the outer loop continue; the stream
                        // will end naturally on the next iteration.
                        logger.warn(
                            'chat',
                            `Ignoring terminal chunk with done_reason=${lastDoneReason}`,
                        );
                        continue outer;
                    }

                    if (lastDoneReason === 'length') {
                        // Response was cut off by num_predict. Surface this to
                        // the client so the UI can display a truncation hint
                        // (when one is implemented) and so the Prompt-loop
                        // feature can tailor its continuation nudge.
                        sendEvent('status', {
                            phase: 'truncated',
                            tokensUsed: promptEvalCount + evalCount,
                            tokenLimit: effectiveNumCtx,
                        });
                    }

                    // -- Prompt-loop completeness check ────────────────────────
                    // When prompt-loop mode is active and the model produced a
                    // non-truncated final response, ask the judge whether the
                    // original user request was really satisfied. If not,
                    // inject a continuation nudge and re-enter the outer LLM
                    // loop. Capped at effectiveMaxPromptLoopIterations (0 = unlimited).
                    if (
                        effectiveCompletionMode === 'prompt-loop'
                        && lastDoneReason !== 'load'
                        && lastDoneReason !== 'unload'
                        && originalUserRequest
                        && content.trim()
                    ) {
                        const cap = effectiveMaxPromptLoopIterations === 0
                            ? Infinity
                            : effectiveMaxPromptLoopIterations;
                        const HARD_CEILING = 20;
                        const effectiveCap = Math.min(cap, HARD_CEILING);
                        logger.info(
                            'chat',
                            'Prompt-loop active',
                            {
                                cap: cap === Infinity ? '∞' : cap,
                                effectiveCap,
                                doneReason: lastDoneReason ?? 'undefined',
                            },
                        );
                        while (promptLoopIterations < effectiveCap) {
                            promptLoopIterations++;
                            sendEvent('status', {
                                phase: 'completeness-check',
                                iteration: promptLoopIterations,
                                maxIterations: effectiveMaxPromptLoopIterations,
                                tokensUsed: promptEvalCount + evalCount,
                                tokenLimit: effectiveNumCtx,
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
                                effectiveBaseUrl,
                                model as string,
                                effectiveNumCtx,
                                originalUserRequest,
                                content,
                                traceMessages,
                                req.signal,
                            );

                            if (satisfied) {
                                logger.info(
                                    'chat',
                                    'Prompt-loop: satisfied',
                                    { iterations: promptLoopIterations },
                                );
                                break;
                            }

                            // Not satisfied — inject a continuation nudge and
                            // re-enter the outer streaming loop.
                            logger.info(
                                'chat',
                                'Prompt-loop: not satisfied, injecting nudge',
                                { iteration: promptLoopIterations },
                            );
                            const nudgeLines = [
                                `Continue working on my original request. It is not yet complete.`,
                            ];
                            if (feedback) {
                                nudgeLines.push(
                                    '',
                                    `The completeness reviewer noted these specific deficiencies:`,
                                    feedback,
                                );
                            }
                            nudgeLines.push(
                                '',
                                `Original request: ${originalUserRequest}`,
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
                            await flushSessionState();
                            continue outer;
                        }
                    }

                    finalContent = content;
                    finalThinking = thinking;

                    // Rename the session from the placeholder to a content-derived title,
                    // but only if the user hasn't already renamed it (e.g. via /title).
                    const currentSessionId = activeSessionId!;
                    const currentName = getSessionName(currentSessionId);
                    if (currentName === null || currentName === undefined || currentName === DEFAULT_SESSION_NAME) {
                        const titleContent = firstContent || content;
                        const titleThinking = firstThinking || thinking;
                        const titleText = titleThinking ? `${titleContent}\n${titleThinking}` : titleContent;
                        renameSession(currentSessionId, generateFallbackTitle(sanitizeContentForTitle(titleText)));

                        // Fire-and-forget background task to generate a proper LLM-based title.
                        // The fallback title is already set above, so this is purely an upgrade.
                        generateSessionTitle(
                            effectiveBaseUrl,
                            effectiveCompactionModel,
                            currentMessages,
                            effectiveNumCtx,
                            undefined, // no onProgress (SSE stream is closing)
                            undefined, // no think override
                        )
                            .then((title) => enqueueSessionRename(currentSessionId, title))
                            .catch(() => {
                                // Background title generation failed — the fallback title is already set.
                                // Silently ignore — the user can still use /title manually.
                            });
                    }

                    // Persist final state (append any remaining server-generated
                    // messages to the latest DB state).
                    await flushSessionState();

                    const totalTokens = promptEvalCount + evalCount;

                    // Compute tokens-per-second from Ollama's nanosecond durations.
                    // evalDuration is the generation phase; promptEvalDuration is the prompt-processing phase.
                    const promptTps = promptEvalDuration > 0
                        ? +(promptEvalCount / (promptEvalDuration / 1_000_000_000)).toFixed(2)
                        : null;
                    const evalTps = evalDuration > 0
                        ? +(evalCount / (evalDuration / 1_000_000_000)).toFixed(2)
                        : null;
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
                            promptTps,
                            evalTps: effectiveEvalTps,
                        },
                        doneReason: lastDoneReason ?? 'stop',
                    });

                    controller.close();
                    return;
                }


            } catch (err: unknown) {
                if (err instanceof DOMException && err.name === 'AbortError') {
                    // Save whatever we have so far before closing.
                    if (activeSessionId !== undefined && sessionExists(activeSessionId)) {
                        await flushSessionState().catch((err_) => {
                            logger.error('chat', 'Abort flush failed', { error: err_ });
                        });
                    }
                    try { controller.close(); } catch { /* ignore */ }
                    return;
                }

                const message = await getLlmApiErrorMessage(err);
                logger.error('ollama', message, { error: err });

                try {
                    sendEvent('error', { message });
                } catch {
                    // Controller may already be closed – ignore.
                }
            } finally {
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
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}
