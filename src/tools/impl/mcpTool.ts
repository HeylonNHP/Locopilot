/**
 * Locopilot-side `mcp_call` tool. This is the single IToolCommand
 * entry the LLM uses to invoke any MCP server tool. The actual
 * dispatch (namespacing, client lookup, transport call) lives in
 * `mcp/schemaAdapter.ts`; this file only validates Locopilot-level
 * arguments and routes through the dispatcher.
 *
 * Phase 1 approval model:
 * - Per-server `autoApprove` allowlist: listed tool names are
 *   executed without prompting. Everything else requires a
 *   one-time approval (carried in the RequestContext).
 * - YOLO mode (`context.yoloMode === true`) auto-approves every
 *   call, matching the existing `run_command` behaviour.
 * - The `mcpApprovals?: Set<string>` field on RequestContext holds
 *   the names of pre-approved `mcp__<server>__<tool>` names for the
 *   current request. The chat route populates it from the
 *   approval registry when the user clicks "Approve" on a pending
 *   approval_request event.
 */

import type { RequestContext, ToolCallArguments, ToolCallResult } from '../../tools/toolRegistry';
import type { ToolSchema } from '../../tools/tools';

import {
  buildNamespacedName,
  dispatchMCPToolCall,
  type DispatchOptions,
  MCP_TOOL_NAMESPACE_PREFIX,
  MCP_TOOL_NAMESPACE_SEPARATOR,
} from '../../mcp';

const SERVER_NAME_REGEX = /^[\w-]+$/i;
const TOOL_NAME_REGEX = /^[\w.]+$/;

function validateServerName(name: string): string | null {
  if (typeof name !== 'string') {
    return '[Error: mcp_call: "server" is required and must be a string]';
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    return '[Error: mcp_call: "server" must be 1-64 characters long]';
  }
  if (!SERVER_NAME_REGEX.test(trimmed)) {
    return '[Error: mcp_call: "server" must be kebab-case (letters, digits, underscore, dash only)]';
  }
  if (trimmed.startsWith('.') || trimmed.startsWith('-') || trimmed.includes('..')) {
    return '[Error: mcp_call: "server" must not start with "." or "-" and must not contain ".."]';
  }
  return null;
}

function validateToolName(name: string): string | null {
  if (typeof name !== 'string') {
    return '[Error: mcp_call: "tool" is required and must be a string]';
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    return '[Error: mcp_call: "tool" must be 1-200 characters long]';
  }
  if (!TOOL_NAME_REGEX.test(trimmed)) {
    return '[Error: mcp_call: "tool" must be a valid MCP tool name (letters, digits, underscore, dot, dash)]';
  }
  // Guard against accidental name injection: reject anything that
  // contains the namespace separator (the model should pass the
  // bare tool name, not the full `mcp__<server>__<tool>` form).
  if (trimmed.includes(MCP_TOOL_NAMESPACE_SEPARATOR)) {
    return `[Error: mcp_call: "tool" must not contain "${MCP_TOOL_NAMESPACE_SEPARATOR}". Pass the bare tool name (e.g. "list_issues"), not the full namespace.]`;
  }
  if (trimmed.startsWith(MCP_TOOL_NAMESPACE_PREFIX)) {
    return `[Error: mcp_call: "tool" must not start with "${MCP_TOOL_NAMESPACE_PREFIX}". Pass the bare tool name and the server name separately.]`;
  }
  return null;
}

function validateArguments(args: unknown): string | null {
  if (args === undefined) return null;
  if (args === null) return null;
  if (typeof args !== 'object' || Array.isArray(args)) {
    return '[Error: mcp_call: "arguments" must be a JSON object (or omitted)]';
  }
  return null;
}

export const mcpCallToolSchema: ToolSchema = {
  name: 'mcp_call',
  description:
    'Invoke a tool exposed by a configured MCP (Model Context Protocol) server. ' +
    'Pass the server name and the bare tool name; the full namespaced name `mcp__<server>__<tool>` ' +
    'is what the LLM should use to register the call. Servers and their tools are listed via the ' +
    '`/mcp list` slash command and the `mcp__*` entries in the system tool list. ' +
    'Phase 1 default approval: each call requires explicit user approval unless the server ' +
    'declares the tool in its `autoApprove` list, or YOLO mode is on.',
  parameters: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description:
          'The name of the MCP server (the key from `mcpServers` in ~/.locopilot/mcp.json). Must be kebab-case, 1-64 characters.',
      },
      tool: {
        type: 'string',
        description:
          'The bare tool name as reported by the MCP server (e.g. "list_issues"). Do NOT include the `mcp__<server>__` prefix here; the system adds that automatically.',
      },
      arguments: {
        type: 'object',
        description:
          "Optional JSON object of arguments to pass to the MCP tool. Shape is server-defined; see the tool's schema in the system tool list.",
      },
    },
    required: ['server', 'tool'],
  },
};

export function getToolPrompt(): string {
  const s = mcpCallToolSchema;
  const props = s.parameters.properties;
  const serverDesc = props.server?.description ?? '';
  const toolDesc = props.tool?.description ?? '';
  const argsDesc = props.arguments?.description ?? '';
  return (
    `13. ${s.name}(server, tool, arguments?)\n` +
    `   ${s.description}\n\n` +
    `   - server: ${serverDesc}\n` +
    `   - tool: ${toolDesc}\n` +
    `   - arguments: ${argsDesc}\n`
  );
}

export async function runMCPCall(
  args: ToolCallArguments,
  context?: RequestContext,
  signal?: AbortSignal
): Promise<ToolCallResult> {
  const serverErr = validateServerName(args.server as string);
  if (serverErr) return { content: serverErr };
  const toolErr = validateToolName(args.tool as string);
  if (toolErr) return { content: toolErr };
  const argsErr = validateArguments(args.arguments);
  if (argsErr) return { content: argsErr };

  const serverName = (args.server as string).trim();
  const toolName = (args.tool as string).trim();
  const namespacedName = buildNamespacedName(serverName, toolName);

  // Blocklist check: a user-disabled tool must never be reachable
  // through mcp_call, regardless of which path (main LLM, sub-agent,
  // YOLO mode, or autoApprove) initiated it. Without this guard a
  // tool the user explicitly disabled could still fire — see A3 in
  // the bug report.
  const disabledMain = context?.disabledMainTools ?? [];
  const disabledSubAgent =
    context?.subAgent &&
    Array.isArray((context.subAgent as { disabledTools?: string[] }).disabledTools)
      ? ((context.subAgent as { disabledTools?: string[] }).disabledTools ?? [])
      : [];
  // TODO(Phase 2): thread a per-sub-agent disabledSubAgent list into
  // RequestContext (the SubAgentConfig currently doesn't carry it).
  // For now we only enforce disabledMainTools; the sub-agent list
  // is plumbed when the SubAgentConfig grows a `disabledTools` field.
  if (
    disabledMain.includes(namespacedName) ||
    disabledMain.includes('mcp_call') ||
    disabledSubAgent.includes(namespacedName) ||
    disabledSubAgent.includes('mcp_call')
  ) {
    return {
      content: `[Error: MCP tool "${namespacedName}" is disabled in the user's settings]`,
    };
  }

  // Skill-based allowlist: if any active always-apply skill restricts
  // the available tool set, gate the call through the same check the
  // registry uses for native tools.
  if (
    context?.allowedTools &&
    context.allowedTools.length > 0 &&
    !context.allowedTools.includes(namespacedName) &&
    !context.allowedTools.includes('mcp_call')
  ) {
    return {
      content:
        `[Error: tool "${namespacedName}" is not allowed by the currently active skills. ` +
        `Allowed tools: ${context.allowedTools.join(', ')}]`,
    };
  }

  // Build the dispatcher options, layering in approval tokens.
  const approvedTools: Set<string> | undefined = context?.mcpApprovals
    ? new Set(context.mcpApprovals)
    : undefined;

  // YOLO mode is treated as an implicit global approval.
  if (context?.yoloMode) {
    const yoloSet = new Set<string>(approvedTools ?? []);
    yoloSet.add(namespacedName);
    const dispatchOptions: DispatchOptions = { approvedTools: yoloSet };
    if (signal !== undefined) dispatchOptions.signal = signal;
    return dispatchMCPToolCall(namespacedName, args.arguments ?? {}, dispatchOptions);
  }

  const dispatchOptions: DispatchOptions = {};
  if (signal !== undefined) dispatchOptions.signal = signal;
  if (approvedTools) dispatchOptions.approvedTools = approvedTools;
  return dispatchMCPToolCall(namespacedName, args.arguments ?? {}, dispatchOptions);
}
