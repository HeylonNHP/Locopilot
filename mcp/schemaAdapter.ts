/**
 * Converts MCP tool schemas (JSON Schema) into Locopilot's Ollama tool
 * definitions, and dispatches `mcp__<server>__<tool>` invocations back
 * to the live MCP client.
 *
 * Phase 1 design notes:
 * - Schemas are converted 1:1. MCP's `inputSchema` is a JSON Schema
 *   object; Ollama's `parameters` is structurally identical so no
 *   translation is required beyond prepending the `mcp__<server>__`
 *   namespace to the function name.
 * - Description is prefixed with `[MCP:<server>]` so the model can
 *   see provenance in its tool list.
 * - The dispatcher takes per-request state (AbortSignal, approval
 *   tokens) explicitly so the client manager stays request-agnostic.
 */

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolCallResult } from '../tools/toolRegistry';
import type { ToolDefinition } from '../services/adapters/llmAdapter';
import { type MCPToolInfo } from './types';
import { getClientManager } from './clientManager';

export const MCP_TOOL_NAMESPACE_PREFIX = 'mcp__';
export const MCP_TOOL_NAMESPACE_SEPARATOR = '__';

/**
 * Server names that would shadow a native Locopilot tool if a user
 * defined an MCP server with the same name (e.g. `mcp__run_command__`
 * would be indistinguishable from the `run_command` entry in the
 * merged tool list). See B4 in the bug report.
 *
 * Hand-maintained to mirror `tools/tools.ts` `TOOLS` array.
 */
export const MCP_FORBIDDEN_SERVER_NAMES: ReadonlySet<string> = new Set([
    'run_command',
    'check_process_output',
    'web_search',
    'fetch_url',
    'fetch_image',
    'read_file',
    'patch_file',
    'write_file',
    'run_subagents',
    'load_skill',
    'create_skill',
    'read_pdf',
    'mcp_call',
]);

export function buildNamespacedName(serverName: string, toolName: string): string {
    return `${MCP_TOOL_NAMESPACE_PREFIX}${serverName}${MCP_TOOL_NAMESPACE_SEPARATOR}${toolName}`;
}

export interface ParsedMCPToolName {
    serverName: string;
    toolName: string;
}

/**
 * Parses a `mcp__<server>__<tool>` name. Returns null if the name is
 * not a valid namespaced MCP name (so callers can fall through to
 * "unknown tool" without confusing the model).
 */
export function parseMCPToolName(namespacedName: string): ParsedMCPToolName | null {
    if (!namespacedName.startsWith(MCP_TOOL_NAMESPACE_PREFIX)) return null;
    const rest = namespacedName.slice(MCP_TOOL_NAMESPACE_PREFIX.length);
    const sep = rest.indexOf(MCP_TOOL_NAMESPACE_SEPARATOR);
    if (sep < 0) return null;
    const serverName = rest.slice(0, sep);
    const toolName = rest.slice(sep + MCP_TOOL_NAMESPACE_SEPARATOR.length);
    if (serverName.length === 0 || toolName.length === 0) return null;
    return { serverName, toolName };
}

/**
 * Convert a single MCP tool descriptor to the Ollama tool schema shape.
 *
 * The returned object is intentionally `unknown`-shaped for the
 * `properties` map because MCP's inputSchema may legitimately contain
 * nested JSON Schema (e.g. arrays of objects) that doesn't fit the
 * `ToolSchemaParameter` discriminated union exactly. The schema is
 * passed through verbatim and Ollama validates it server-side.
 */
export function mcpToolToOllamaTool(serverName: string, tool: MCPToolInfo): ToolDefinition {
    const description = tool.description
        ? `[MCP:${serverName}] ${tool.description}`
        : `[MCP:${serverName}] Tool "${tool.name}" from MCP server "${serverName}"`;

    return {
        type: 'function',
        function: {
            name: buildNamespacedName(serverName, tool.name),
            description,
            parameters: {
                type: 'object',
                properties: (tool.inputSchema.properties ?? {}) as Record<string, unknown>,
                ...(tool.inputSchema.required && tool.inputSchema.required.length > 0
                    ? { required: tool.inputSchema.required }
                    : {}),
            },
        },
    };
}

/**
 * Build the full list of Ollama tool definitions for the live MCP
 * servers. Phase 1 does not eagerly connect — tools are surfaced from
 * already-connected handles only. To get a complete listing including
 * unconnected servers, the caller must connect first (the
 * `mcp__<server>__<tool>` schema is sent to the LLM only after a
 * connection is established, because the tool list is what the model
 * uses to decide what to call).
 */
export async function buildMCPToolDefinitions(): Promise<ToolDefinition[]> {
    const manager = getClientManager();
    const definitions: ToolDefinition[] = [];
    for (const handle of manager.list()) {
        if (handle.status !== 'connected') continue;
        for (const tool of handle.tools) {
            definitions.push(mcpToolToOllamaTool(handle.name, tool));
        }
    }
    return definitions;
}

export interface DispatchContext {
    /** Aborts the MCP call when the parent request is aborted. */
    signal?: AbortSignal;
}

export interface DispatchOptions extends DispatchContext {
    /**
     * Per-request approval tokens. If the namespaced tool name is
     * present in this set, the call is allowed to proceed without an
     * extra prompt (the caller already collected the approval).
     */
    approvedTools?: Set<string>;
}

/**
 * Dispatch a `mcp__<server>__<tool>` call to the live client.
 *
 * Returns a `ToolCallResult` suitable for direct return from a tool
 * command. Always sets `content`; image content is forwarded via
 * `images` (base64).
 */
export async function dispatchMCPToolCall(
    namespacedName: string,
    args: unknown,
    options: DispatchOptions = {},
): Promise<ToolCallResult> {
    const parsed = parseMCPToolName(namespacedName);
    if (!parsed) {
        return { content: `[MCP error: tool name "${namespacedName}" is not a valid mcp__<server>__<tool> name]` };
    }
    const { serverName, toolName } = parsed;

    // B4 fix: defence in depth. A user-defined MCP server named
    // `run_command` (or any other native tool name) would shadow the
    // native tool in the merged tool list because the namespace
    // segment and the tool name segment happen to be identical. The
    // config loader already rejects these at load time; this check
    // also catches the case where the same name was added via a
    // future code path that bypasses the loader.
    if (MCP_FORBIDDEN_SERVER_NAMES.has(serverName)) {
        return {
            content: `[MCP error: server name "${serverName}" conflicts with a native Locopilot tool. Choose a different server name.]`,
        };
    }

    const manager = getClientManager();
    let handle = manager.get(serverName);
    if (!handle || handle.status === 'error' || handle.status === 'disconnected') {
        try {
            handle = await manager.connect(serverName);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: `[MCP error: failed to connect to server "${serverName}": ${message}]` };
        }
    }
    if (!handle) {
        return { content: `[MCP error: server "${serverName}" is not configured]` };
    }
    if (handle.status !== 'connected') {
        return { content: `[MCP error: server "${serverName}" is in status "${handle.status}"${handle.lastError ? `: ${handle.lastError}` : ''}]` };
    }

    // Verify the tool exists on the server. This guards against stale
    // namespacing (e.g. server changed its tool set without notifying).
    const tool = handle.tools.find((t) => t.name === toolName);
    if (!tool) {
        return { content: `[MCP error: tool "${toolName}" is not available on server "${serverName}"]` };
    }

    // Per-server blocklist check.
    if (handle.config.disabledTools?.includes(toolName)) {
        return { content: `[MCP error: tool "${toolName}" is disabled on server "${serverName}"]` };
    }

    // Approval gate: the dispatcher enforces a per-call approval
    // requirement unless the caller pre-authorised this tool via the
    // approval registry (e.g. a previous approval_request event for
    // the same tool was resolved positively) or the tool matches an
    // `autoApprove` glob pattern in the server config.
    //
    // The pattern check supports BOTH long-form patterns
    // (`mcp__github__*`, which matches by full namespaced name) and
    // short-form patterns (`*`, `list_*`, which match by bare tool
    // name). This mirrors the `mcp__<server>__<tool>` convention users
    // see in the model prompt — copy-pasting the namespace from the
    // tool list into `autoApprove` works as you'd expect.
    const approvedByAutoApprove = handle.config.autoApprove?.some((pattern) =>
        matchesAutoApprovePattern(pattern, namespacedName) ||
        matchesAutoApprovePattern(pattern, toolName),
    ) ?? false;
    const approvedByToken = options.approvedTools?.has(namespacedName) ?? false;
    if (!approvedByAutoApprove && !approvedByToken) {
        return {
            content: `[MCP call requires approval: server="${serverName}", tool="${toolName}". The user must approve this call before it is executed. (Use the approval flow in the chat UI to grant one-time access.)]`,
        };
    }

    // Race the actual call against the AbortSignal.
    //
    // We pass the signal through the SDK's `options.signal` so that
    // `client.callTool` itself rejects when the parent request is
    // aborted (the SDK will then unwind the JSON-RPC request, which
    // in turn triggers the transport's close path, killing the
    // child process). The `Promise.race` below is a *belt-and-braces*
    // safety net: if the SDK ever fails to honour the signal (e.g.
    // because the child is wedged), the race still returns a clean
    // error to the caller instead of hanging the whole request.
    const timeoutMs = manager.getTimeoutMs(serverName);
    const callPromise = handle.client
        .callTool(
            { name: toolName, arguments: (args ?? {}) as Record<string, unknown> },
            CallToolResultSchema,
            options.signal ? { signal: options.signal } : {},
        )
        .then((value): RaceResult => ({ kind: 'ok', value: value as CallToolResult }));
    const result: RaceResult = await Promise.race([
        callPromise,
        abortAfter(options.signal).then((): RaceResult => ({ kind: 'aborted' })),
        timeoutAfter(timeoutMs).then((): RaceResult => ({ kind: 'timeout' })),
    ]);

    if (result.kind === 'aborted') {
        return { content: `[MCP error: call to "${serverName}/${toolName}" was aborted by the client]` };
    }
    if (result.kind === 'timeout') {
        return { content: `[MCP error: call to "${serverName}/${toolName}" timed out after ${timeoutMs}ms]` };
    }

    return formatMCPResult(result.value, serverName, toolName);
}

interface AbortedResult { kind: 'aborted' }
interface TimeoutResult { kind: 'timeout' }
interface OkResult { kind: 'ok'; value: CallToolResult }
type RaceResult = AbortedResult | TimeoutResult | OkResult;

function abortAfter(signal: AbortSignal | undefined): Promise<AbortedResult> {
    if (!signal) return new Promise<AbortedResult>(() => { /* never resolves */ });
    if (signal.aborted) return Promise.resolve({ kind: 'aborted' });
    return new Promise<AbortedResult>((resolve) => {
        signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
    });
}

function timeoutAfter(ms: number): Promise<TimeoutResult> {
    return new Promise<TimeoutResult>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), ms);
    });
}

/**
 * Convert an MCP `CallToolResult` into Locopilot's `ToolCallResult`.
 * The `content` array can hold text, image, audio, or resource blocks;
 * Phase 1 surfaces text and images and treats audio as a notice.
 */
function formatMCPResult(
    result: CallToolResult,
    serverName: string,
    toolName: string,
): ToolCallResult {
    // The SDK types the callTool return as a discriminated union of two
    // shapes: the conventional { content: [...], isError?: boolean } form
    // and a structured-content { toolResult: unknown } form. We use a
    // runtime presence check (the SDK's narrower conditional type doesn't
    // survive the Promise.race wrapper).
    if (!('content' in result)) {
        const toolResult = (result as { toolResult?: unknown }).toolResult;
        const text = toolResult === undefined ? '(empty structured result)' :
            typeof toolResult === 'string' ? toolResult :
                JSON.stringify(toolResult, null, 2);
        return { content: text };
    }
    // The conventional path — narrow through a local type to keep the
    // callTool result's union from contaminating downstream loops.
    const conventional = result as {
        isError?: boolean;
        content: Array<
            | { type: 'text'; text: string }
            | { type: 'image'; data: string; mimeType: string }
            | { type: 'audio'; data: string; mimeType: string }
            | { type: 'resource'; resource: { uri: string; text?: string; blob?: string } }
            | { type: 'resource_link'; uri: string; name: string }
        >;
    };

    const textBlocks: string[] = [];
    const images: string[] = [];

    // The SDK returns `content` as a union of content-block shapes.
    // We narrow with typeof/type discriminators and use 'in' for blocks
    // that share the same shape variants.
    for (const block of conventional.content) {
        if (block.type === 'text') {
            textBlocks.push(block.text);
            continue;
        }
        if (block.type === 'image') {
            images.push(block.data);
            const size = Math.round(block.data.length * 0.75);
            textBlocks.push(`[image: ${block.mimeType}, ~${size} bytes]`);
            continue;
        }
        if (block.type === 'audio') {
            textBlocks.push(`[audio block dropped: ${block.mimeType} — audio content is not yet supported in Locopilot]`);
            continue;
        }
        if (block.type === 'resource') {
            const resource = block.resource;
            if ('text' in resource && typeof resource.text === 'string') {
                textBlocks.push(`[embedded resource: ${resource.uri}]\n${resource.text}`);
            } else {
                textBlocks.push(`[embedded resource (blob): ${resource.uri}]`);
            }
            continue;
        }
        // resource_link blocks (Type 2025-06-18 spec variant).
        if (block.type === 'resource_link') {
            textBlocks.push(`[resource link: ${block.uri} (${block.name})]`);
            continue;
        }
        // Unknown block — surface as a marker so the model can adapt.
        textBlocks.push(`[unknown MCP content block]`);
    }

    const joined = textBlocks.join('\n').trim();
    if (conventional.isError) {
        return {
            content: `[MCP "${serverName}/${toolName}" returned an error]\n${joined || '(no message)'}`,
        };
    }
    return {
        content: joined || '(empty result)',
        ...(images.length > 0 ? { images } : {}),
    };
}

/**
 * Test whether `toolName` matches a single `autoApprove` glob `pattern`.
 *
 * Matching rules:
 * - `*` matches any sequence of characters except `/`. (We don't accept
 *   `/` in `toolName` for MCP tool names anyway — the namespace separator
 *   is `__` — so the restriction is purely defensive.)
 * - `?` matches exactly one character (except `/`).
 * - All other characters match literally. Matching is case-sensitive.
 * - If the pattern contains no wildcard characters (`*` or `?`), it is
 *   treated as a literal exact match. This preserves backwards
 *   compatibility with existing `autoApprove: ["run_command"]`-style
 *   configs that pre-date wildcard support.
 *
 * The pattern is matched against `toolName` directly. The function does
 * NOT know about the `mcp__<server>__` namespace — callers must pass the
 * segment they want to match against (e.g. the bare `toolName` from a
 * parsed namespaced call, or a fully-qualified `mcp__github__*` form).
 * For the common MCP case, callers pass the short tool name and a
 * short-form pattern like `list_*` or `*`, which works exactly as users
 * would expect. A long-form pattern like `mcp__github__*` will not match
 * a short tool name like `list_issues` — the caller is expected to
 * supply a pattern in the form that matches the value being compared.
 *
 * The implementation is a small state machine (linear, single pass) and
 * does not pull in a glob library.
 */
export function matchesAutoApprovePattern(pattern: string, toolName: string): boolean {
    // Fast path: no wildcards → literal equality. This keeps the
    // existing exact-match behaviour for backwards compatibility and
    // skips the loop entirely for the (very common) non-wildcard case.
    if (!pattern.includes('*') && !pattern.includes('?')) {
        return pattern === toolName;
    }

    let pi = 0; // pattern index
    let ti = 0; // tool name index
    let starPi = -1; // last `*` position in the pattern (for backtracking)
    let starTi = -1; // tool name position when the last `*` was crossed

    while (ti < toolName.length) {
        if (pi < pattern.length) {
            const pc = pattern[pi];
            if (pc === '*') {
                // Record the backtrack anchor and advance past the `*`.
                starPi = pi;
                starTi = ti;
                pi++;
                continue;
            }
            if (pc === '?') {
                // `?` matches any single non-`/` character.
                if (toolName[ti] === '/') return false;
                pi++;
                ti++;
                continue;
            }
            if (pc === toolName[ti]) {
                pi++;
                ti++;
                continue;
            }
        }
        // Mismatch: if we've seen a `*`, backtrack and let it consume
        // one more character. This is the classic wildcard matcher.
        if (starPi !== -1) {
            if (toolName[starTi] === '/') return false; // `*` does not cross `/`
            pi = starPi + 1;
            starTi++;
            ti = starTi;
            continue;
        }
        return false;
    }

    // Tool name exhausted. The rest of the pattern must be all `*`s
    // (e.g. `foo*` matching `foo`, or `**` matching ``).
    while (pi < pattern.length && pattern[pi] === '*') {
        pi++;
    }
    return pi === pattern.length;
}

/**
 * Returns the list of namespaced tool names that the given tool is
 * allowed to dispatch. Used by the chat route to compute
 * `mcpApprovals` from the approval registry, and to validate
 * `/mcp list` outputs.
 */
export function getApprovedNamespacedNames(configured: Set<string>): string[] {
    return Array.from(configured).filter((name) => parseMCPToolName(name) !== null);
}
