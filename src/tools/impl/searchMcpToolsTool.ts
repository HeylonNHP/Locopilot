/**
 * Locopilot-side `search_mcp_tools` meta-tool.
 *
 * Phase 3 (MCP Tool Search) — companion to `mcp_call`. When the chat
 * route has Tool Search enabled, MCP tools are surfaced to the LLM
 * as *stubs* (name + truncated description, no `properties` map). The
 * model cannot call the stub directly — it must first look up the
 * full JSON Schema via this tool, then use `mcp_call` to actually
 * invoke the underlying server tool.
 *
 * This pattern saves a lot of tokens on requests that touch only one
 * or two MCP tools: instead of paying the cost of every server's full
 * schema on every turn, the LLM only pulls the schemas it needs.
 *
 * The tool is intentionally cheap to call and has no approval gate
 * — it cannot touch the filesystem, network, or any MCP server. It
 * is effectively a directory lookup.
 */

import type { ToolCallResult, ToolCallArguments, RequestContext } from '../../tools/toolRegistry';
import type { ToolSchema } from '../../tools/tools';
import {
    buildMCPToolStubs,
    getClientManager,
    parseMCPToolName,
    type MCPToolStub,
} from '../../mcp';
import type { MCPToolInfo } from '../../mcp';

// Match the full `mcp__<server>__<tool>` form. Mirrors the regex in
// `mcp/schemaAdapter.ts` (used by `parseMCPToolName`); duplicated here
// so the validator produces a clean error before any further work.
const NAMESPACE_REGEX = /^mcp__[a-z0-9_-]+__[a-zA-Z0-9_.\-]+$/;
const SERVER_NAME_REGEX = /^[a-z0-9_-]+$/i;
const TOOL_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;
const MAX_DESCRIPTION_CHARS = 100;

function isPlainString(value: unknown): value is string {
    return typeof value === 'string';
}

function validateNameArg(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
        return '[Error: search_mcp_tools: "name" must be a string (e.g. "mcp__github__list_issues")]';
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return '[Error: search_mcp_tools: "name" must be a non-empty string or omitted]';
    }
    if (!NAMESPACE_REGEX.test(trimmed)) {
        return '[Error: search_mcp_tools: "name" must be a valid mcp__<server>__<tool> name]';
    }
    // Re-parse to make sure both segments are individually sane (the
    // namespace regex above already enforces this, but a defensive
    // round-trip catches a future regex loosening).
    const parsed = parseMCPToolName(trimmed);
    if (!parsed) {
        return '[Error: search_mcp_tools: "name" must be a valid mcp__<server>__<tool> name]';
    }
    if (!SERVER_NAME_REGEX.test(parsed.serverName)) {
        return `[Error: search_mcp_tools: server segment "${parsed.serverName}" is not a valid server name]`;
    }
    if (!TOOL_NAME_REGEX.test(parsed.toolName)) {
        return `[Error: search_mcp_tools: tool segment "${parsed.toolName}" is not a valid tool name]`;
    }
    return null;
}

function validateServerArg(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
        return '[Error: search_mcp_tools: "server" must be a string (e.g. "github")]';
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return '[Error: search_mcp_tools: "server" must be a non-empty string or omitted]';
    }
    if (!SERVER_NAME_REGEX.test(trimmed)) {
        return '[Error: search_mcp_tools: "server" must be kebab-case (letters, digits, underscore, dash only)]';
    }
    return null;
}

export const searchMcpToolsToolSchema: ToolSchema = {
    name: 'search_mcp_tools',
    description:
        'Look up the full JSON Schema for one or more MCP tools. ' +
        'Use this before calling an MCP tool when only the tool name is available ' +
        '(the stub schemas from mcp__<server>__<tool> do not include the full parameter list). ' +
        'Pass either a single full name (e.g. "mcp__github__list_issues") or a server name to return all tools from that server. ' +
        'No approval is required — this tool only reads schema metadata, it does not invoke anything.',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description:
                    'Optional: full namespaced name of a single tool (mcp__<server>__<tool>). If provided, only that tool is returned.',
            },
            server: {
                type: 'string',
                description:
                    'Optional: server name. If provided (and "name" is not), every tool from that server is returned.',
            },
        },
        required: [],
    },
};

export function getToolPrompt(): string {
    const s = searchMcpToolsToolSchema;
    const props = s.parameters.properties;
    const nameDesc = props.name?.description ?? '';
    const serverDesc = props.server?.description ?? '';
    return (
        `14. ${s.name}(name?, server?)\n` +
        `   ${s.description}\n\n` +
        `   - name: ${nameDesc}\n` +
        `   - server: ${serverDesc}\n` +
        `   At least one of "name" or "server" is required.\n`
    );
}

interface FormattedToolBlock {
    namespacedName: string;
    text: string;
}

/**
 * Build the human-readable block for a single tool. The block is the
 * raw text the LLM sees as the tool result; we keep it plain (no
 * Markdown headers, no code fences around the JSON Schema) so the
 * model can parse it cleanly.
 */
function formatToolBlock(stub: MCPToolStub, tool: MCPToolInfo | undefined): FormattedToolBlock {
    const description = tool?.description ?? stub.description ?? '(no description provided by the server)';
    const truncatedDesc = description.length > 240
        ? description.slice(0, 240) + '…'
        : description;

    const params = tool?.inputSchema ?? { type: 'object' as const };
    let paramsText: string;
    try {
        paramsText = JSON.stringify(params, null, 2);
    } catch {
        paramsText = '(failed to stringify JSON Schema — non-serialisable schema)';
    }

    const text = [
        `Tool: ${stub.namespacedName}`,
        `Server: ${stub.server}`,
        `Description: ${truncatedDesc}`,
        `Parameters (JSON Schema):`,
        paramsText,
        '',
        'You can now call this tool with the full schema in mind. The mcp__' +
            `${stub.server}__${stub.name} tool is available in your current tool list as a stub; ` +
            'treat this result as the parameter specification. Use mcp_call(server="' +
            stub.server + '", tool="' + stub.name + '", arguments={...}) to actually invoke it.',
    ].join('\n');

    return { namespacedName: stub.namespacedName, text };
}

/**
 * Look up a connected handle's tool entry by name. Returns `undefined`
 * if the server is not connected OR the tool is not on it. We do NOT
 * trigger an auto-connect here: search_mcp_tools is supposed to be a
 * cheap, lazy lookup, and the whole point of Tool Search is to defer
 * work until the LLM actually decides to call a tool.
 */
function findToolOnHandle(serverName: string, toolName: string): { stub: MCPToolStub; tool: MCPToolInfo } | null {
    const manager = getClientManager();
    const handle = manager.get(serverName);
    if (!handle || handle.status !== 'connected') return null;
    const tool = handle.tools.find((t) => t.name === toolName);
    if (!tool) return null;
    const stub: MCPToolStub = {
        name: tool.name,
        server: handle.name,
        description: tool.description,
        namespacedName: `mcp__${handle.name}__${tool.name}`,
    };
    return { stub, tool };
}

export async function runSearchMCPTools(
    args: ToolCallArguments,
    _context?: RequestContext,
    _signal?: AbortSignal,
): Promise<ToolCallResult> {
    // ── Argument validation ──────────────────────────────────────────
    // Pull the args as a plain object — the LLM may pass a JSON-string
    // form that the chat loop has already parsed, but defensive checks
    // are cheap.
    const raw = (args && typeof args === 'object' && !Array.isArray(args))
        ? (args as Record<string, unknown>)
        : {};

    const nameProvided = raw.name !== undefined && raw.name !== null;
    const serverProvided = raw.server !== undefined && raw.server !== null;
    if (!nameProvided && !serverProvided) {
        return {
            content: '[Error: search_mcp_tools: at least one of "name" or "server" is required]',
        };
    }

    const nameErr = validateNameArg(raw.name);
    if (nameErr) return { content: nameErr };
    const serverErr = validateServerArg(raw.server);
    if (serverErr) return { content: serverErr };

    // Re-pull as trimmed strings so downstream code can rely on the
    // shape (validate* only checks structure, not whether the trimmed
    // value is empty after slicing whitespace).
    const name = nameProvided ? (raw.name as string).trim() : undefined;
    const server = serverProvided ? (raw.server as string).trim() : undefined;

    // ── Single-tool lookup ──────────────────────────────────────────
    if (name) {
        const parsed = parseMCPToolName(name);
        if (!parsed) {
            // Should be unreachable thanks to validateNameArg, but
            // belt-and-braces: the regex in the schema is intentionally
            // permissive so we keep this check for defence in depth.
            return {
                content: `[Error: search_mcp_tools: "${name}" is not a valid mcp__<server>__<tool> name]`,
            };
        }
        const lookup = findToolOnHandle(parsed.serverName, parsed.toolName);
        if (!lookup) {
            const handle = getClientManager().get(parsed.serverName);
            if (!handle || handle.status !== 'connected') {
                return {
                    content: `[Error: search_mcp_tools: server "${parsed.serverName}" is not connected. Call mcp_call first or use the bare tool name. We do not auto-connect for searches.]`,
                };
            }
            // Server is connected but the named tool is not on it.
            // This usually means the server changed its tool set
            // (notifications/tools/list_changed) after we cached the
            // names. Suggest /mcp list to see what's available now.
            const liveToolNames = handle.tools.map((t) => t.name).join(', ');
            return {
                content: `[Error: search_mcp_tools: tool "${name}" not found on server "${parsed.serverName}". Available tools: ${liveToolNames || '(none)'}. Use /mcp list to refresh.]`,
            };
        }
        const block = formatToolBlock(lookup.stub, lookup.tool);
        return { content: block.text };
    }

    // ── Server-wide lookup ─────────────────────────────────────────
    // (We know `name` is undefined here; `server` is the only other
    // branch in the schema, and it was validated above.)
    if (!server || !isPlainString(server)) {
        return { content: '[Error: search_mcp_tools: "server" is required when "name" is omitted]' };
    }
    const handle = getClientManager().get(server);
    if (!handle || handle.status !== 'connected') {
        return {
            content: `[Error: search_mcp_tools: server "${server}" is not connected. Call mcp_call first or use the bare tool name. We do not auto-connect for searches.]`,
        };
    }

    // Pull stubs from the manager's single source of truth so the
    // stub descriptions stay consistent with the chat route's stub
    // tool definitions. Falls back to a per-handle build if the
    // global helper is empty (e.g. tests that bypass the manager
    // singleton).
    let stubsForServer = (await buildMCPToolStubs()).filter((s) => s.server === server);
    if (stubsForServer.length === 0) {
        stubsForServer = handle.tools.map((t) => ({
            name: t.name,
            server: handle.name,
            description: t.description,
            namespacedName: `mcp__${handle.name}__${t.name}`,
        }));
    }

    if (stubsForServer.length === 0) {
        return {
            content: `[search_mcp_tools: server "${server}" is connected but exposes no tools. Use /mcp list to confirm.]`,
        };
    }

    const blocks: string[] = stubsForServer.map((stub) => {
        const full = handle.tools.find((t) => t.name === stub.name);
        return formatToolBlock(stub, full).text;
    });

    return {
        content:
            `Found ${blocks.length} tool(s) on server "${server}".\n` +
            `Each tool below is a self-contained schema block; you can call any of them via mcp_call.\n\n` +
            blocks.join('\n---\n'),
    };
}

// Surface a couple of values for tests / introspection.
export const __INTERNAL__ = {
    MAX_DESCRIPTION_CHARS,
    NAMESPACE_REGEX,
    SERVER_NAME_REGEX,
    TOOL_NAME_REGEX,
} as const;
