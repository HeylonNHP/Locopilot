/**
 * Canonical names for every Locopilot tool.
 *
 * Each tool name appears in five different places — the implementation's
 * `name` field, the registry's permission lookup, the wire `TOOLS` array,
 * the `MCP_FORBIDDEN_SERVER_NAMES` mirror, and any comparison against the
 * name in a route / approval-modal / component. Previously each site typed
 * the literal string, with a hand-maintained mirror in `mcp/schemaAdapter.ts`
 * (the comment explicitly said so). Centralising the names here means a new
 * tool is one append + a registry entry, and a typo at a comparison site is
 * a compile-time error.
 */

/** Stable string-literal-union of every Locopilot tool name. */
export type ToolName =
  | 'run_command'
  | 'check_process_output'
  | 'web_search'
  | 'fetch_url'
  | 'fetch_image'
  | 'read_file'
  | 'patch_file'
  | 'write_file'
  | 'run_subagents'
  | 'load_skill'
  | 'create_skill'
  | 'read_pdf'
  | 'mcp_call'
  | 'search_mcp_tools'
  | 'render_mermaid';

/** `as const` tuple — used by `tools.ts`, the registry, and `MCP_FORBIDDEN_SERVER_NAMES`. */
export const TOOL_NAMES = [
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
  'search_mcp_tools',
  'render_mermaid',
] as const satisfies readonly ToolName[];

/** Fast O(1) membership check for tool-name validation. */
export const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES);

/**
 * Lower-case per-tool lookup helper. Returns the canonical `ToolName` or
 * `null` if the input doesn't match any registered tool.
 */
export function asToolName(value: string): ToolName | null {
  return TOOL_NAME_SET.has(value) ? (value as ToolName) : null;
}
