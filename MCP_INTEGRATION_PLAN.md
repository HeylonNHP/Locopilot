# MCP Server Integration — Implementation Plan for Locopilot

**Status:** Draft v1
**Target codebase:** Current web app under `app/`, `components/`, `services/`, `tools/` (not the legacy TUI in `dist/`)
**Author:** Investigation by Locopilot on 2026-06-03

---

## 1. Executive Summary

Adding MCP (Model Context Protocol) server support to Locopilot is a **medium-sized, well-scoped feature** that fits naturally into the existing architecture. The codebase already has all the structural ingredients needed:

- A `Map`-based `toolRegistry` that supports runtime `set()` (perfect for dynamic tool discovery)
- A static `TOOLS` array that will need to be **converted to a derived/computed list** to accommodate dynamic MCP tools
- A `RequestContext` interface threaded per-request (no module-level globals to fight with)
- A `checkToolAllowed()` gate that already supports `allowedTools` allowlists
- An existing approval registry (`app/lib/approvalRegistry.ts`) for `run_command` that can be generalised
- A web route at `app/api/chat/route.ts` that filters `TOOLS` by `disabledMainTools` per request
- An atomic config writer (`services/configManager.ts`) with a write queue
- Settings UI infrastructure (`components/SettingsModal/`, `app/api/config/route.ts`)

### Effort estimate

| Phase | Scope | Effort |
|---|---|---|
| **Phase 1 (MVP)** | stdio transport, config file, settings UI, basic tool registration, no hot-reload, no approval gate | 3–5 days |
| **Phase 2 (Standard)** | Streamable HTTP transport, tool namespacing, env var expansion, per-tool approval gate, `notifications/tools/list_changed` hot-reload, MCP slash command, error reporting | 4–6 days |
| **Phase 3 (Advanced)** | MCP Tool Search (lazy loading), OAuth flow for remote servers, per-server timeouts and lifecycle management UI, image content routing, `--additional-mcp-config` CLI flag parity | 5–8 days |

**Total: ~2–3 weeks for a thorough implementation that matches industry leaders.**

### Key design decisions (with rationale)

| Decision | Choice | Rationale |
|---|---|---|
| Namespacing scheme | `mcp__<server>__<tool>` | Matches Claude Code, Continue, Codex — the most common pattern. Survives server renames; enables wildcard approvals. |
| Config file format | `mcpServers` root key, identical to Claude/Cursor/Cline/Windsurf shape | Maximum portability; users can share configs across tools. Auto-translate `servers` → `mcpServers` for VS Code compat. |
| Connection lifecycle | Lazy (connect on first tool call, cache thereafter) + manual reload slash command | Avoids 30–50% context-window bloat from unused servers; matches the Python SDK example and Claude Code's `Tool Search` pattern. |
| Tool schema | Reuse existing `OllamaTool` interface directly; MCP's `inputSchema` is JSON Schema, 1:1 mappable to `parameters` | Zero schema-translation code needed. |
| Approval model | Default-prompt per tool call, with `autoApprove: string[]` per-server escape hatch | Matches the industry "safe by default" baseline (Claude, Cline, Roo). The existing `approvalRegistry` plumbing supports this. |
| Hot-reload | Watch `config.mcpServers` via `chokidar`-style file watcher; `list_changed` notifications for in-process tool updates | Matches Cline/Roo behaviour; user expectation. |
| Reconnection | Exponential backoff with jitter for HTTP/SSE; process respawn (max 3 in 5 min) for stdio | Industry consensus from Claude Code, DeployStack, mcp-cli. |
| OAuth | Defer to Phase 3 — out of scope for MVP | OAuth flow is non-trivial; no remote server use case yet. |
| Sandbox | Defer — Locopilot is a local terminal app; users already have OS-level control | Sandboxing is an opt-in concern (VS Code only supports it on macOS/Linux anyway). |
| Tool Search (lazy schemas) | Implement in Phase 3 when total tool count makes context bloat measurable | Phase 1+2 will surface the actual token cost. |

---

## 2. Architecture Overview

### 2.1 New file layout

```
services/
└── mcp/
    ├── index.ts                  # Public facade: connectMcpServer(), listMcpTools(), callMcpTool()
    ├── client.ts                 # MCP client wrapper (thin facade over @modelcontextprotocol/sdk Client)
    ├── transports/
    │   ├── stdio.ts              # StdioClientTransport config builder
    │   ├── http.ts               # StreamableHTTPClientTransport config builder
    │   └── sse.ts                # SSEClientTransport (legacy compatibility)
    ├── registry.ts               # Server registry: connection state, lifecycle, reconnection
    ├── toolAdapter.ts            # MCP Tool → OllamaTool conversion (inputSchema → parameters)
    ├── config.ts                 # Config parsing: env var expansion, validation
    ├── errors.ts                 # Error formatting for tool results
    └── types.ts                  # McpServerConfig, McpToolDefinition, etc.

tools/
└── impl/
    └── mcpTool.ts                # Single IToolCommand entry that routes mcp__<server>__<tool> to registry

app/
└── api/
    └── mcp/
        └── route.ts              # GET (list servers + tools + status), POST (add/remove/connect/disconnect)

components/
└── SettingsModal/
    ├── SettingsModal.tsx         # Add MCP section
    └── McpServerEditor.tsx       # (new) Per-server editor with stdio/HTTP/headers/env fields

types/
└── chatConfig.ts                 # Add `mcpServers?: Record<string, McpServerConfig>`

constants.ts                      # Add MCP-related defaults (timeout, max restart attempts)
```

### 2.2 Data flow

```
[User config edit in SettingsModal]
        ↓ PUT /api/config { mcpServers: {...} }
[app/api/config/route.ts] → services/configManager.saveConfig()
        ↓
[services/mcp/registry.ts] receives config change notification
        ↓
[For each new/changed server]
   - spawn StdioClientTransport OR open StreamableHTTPClientTransport
   - new Client({...}).connect(transport)
   - await client.listTools()
   - for each tool:
       - convert to OllamaTool via services/mcp/toolAdapter.ts
       - toolRegistry.set(`mcp__<server>__<tool>`, mcpToolCommand)
       - schemaTools.push(ollamaTool)  // appended to dynamic TOOLS list
        ↓
[Next LLM turn]
   - app/api/chat/route.ts builds params.tools = [...nativeTOOLS, ...dynamicMcpTools]
   - LLM sees the merged tool list and can call any tool by its full name
   - handleToolCall('mcp__github__list_issues', {...}) → toolRegistry lookup → McpToolCommand.execute()
   - McpToolCommand.execute() → client.callTool({ name: 'list_issues', arguments }) → format result
```

---

## 3. Configuration Schema

### 3.1 TypeScript types (add to `types/chatConfig.ts`)

```typescript
export type McpTransportType = 'stdio' | 'sse' | 'http';

export interface McpStdioConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerTransportConfig = McpStdioConfig | McpHttpConfig;

export interface McpServerConfig {
  /** Free-form name; used in the namespaced tool name. e.g. "github" → mcp__github__* */
  name: string;
  /** Display description (optional, shown in Settings UI) */
  description?: string;
  /** Transport + connection details */
  transport: McpServerTransportConfig;
  /** Per-tool allowlist — tools NOT in this list will require user approval */
  autoApprove?: string[];
  /** Per-server timeout in seconds (default: 60) */
  timeoutSeconds?: number;
  /** Per-server tool blocklist */
  disabledTools?: string[];
  /** Manual override: server disabled without removing from config */
  disabled?: boolean;
}

export interface Config {
  // ... existing fields ...
  mcpServers?: Record<string, McpServerConfig>;
}
```

### 3.2 Example `config.json` snippet

```json
{
  "baseUrl": "http://localhost:11434",
  "mcpServers": {
    "filesystem": {
      "name": "filesystem",
      "description": "Local filesystem access (read-only mount)",
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "${HOME}/projects"],
        "env": { "LOG_LEVEL": "info" }
      },
      "autoApprove": ["list_directory", "read_file"],
      "timeoutSeconds": 30
    },
    "github": {
      "name": "github",
      "transport": {
        "type": "http",
        "url": "https://api.githubcopilot.com/mcp/",
        "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
      }
    },
    "legacy-jira": {
      "name": "legacy-jira",
      "transport": {
        "type": "sse",
        "url": "https://mcp-jira.internal.example.com/sse"
      },
      "disabledTools": ["delete_issue"]
    }
  }
}
```

### 3.3 Env var expansion

Implement in `services/mcp/config.ts` (parity with Claude Code's `${VAR}` and `${VAR:-default}`):

```typescript
export function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/gi, (_, name, def) => {
    return process.env[name] ?? def ?? '';
  });
}

// Recursively expand in any object/array structure
export function expandConfigEnv<T>(value: T): T { /* ... */ }
```

### 3.4 Validation

- `name` must be unique, match `/^[a-z0-9_-]+$/i`, ≤ 64 chars
- For `stdio`: `command` must be non-empty; `args` items must be strings
- For `http`/`sse`: `url` must be a valid URL with `http(s):` scheme
- `autoApprove` items must be valid MCP tool names (validated against `listTools` response after connect)

---

## 4. Server Lifecycle Management (`services/mcp/registry.ts`)

### 4.1 State machine

```
[disconnected] → connect() → [connecting] → handshake OK → [connected]
                                              ↓ handshake fails
                                          [error] → schedule reconnect with backoff
```

### 4.2 Connection manager shape

```typescript
interface McpServerState {
  config: McpServerConfig;
  client: Client | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  lastError?: string;
  lastConnectedAt?: number;
  tools: McpTool[];            // populated by listTools()
  restartAttempts: number;      // for stdio crash recovery
  abortController?: AbortController;
}

class McpRegistry {
  private servers = new Map<string, McpServerState>();
  private fileWatcher?: FSWatcher;

  /** Initialise from config; called at app startup */
  async init(config: Config): Promise<void>;
  /** Connect a single server; resolves on handshake or rejects on error */
  async connect(name: string): Promise<void>;
  /** Disconnect a single server; kills subprocess for stdio, closes SSE for HTTP */
  async disconnect(name: string): Promise<void>;
  /** Get tool schemas in OllamaTool format */
  getAllTools(): OllamaTool[];
  /** Route a tool call to the correct server */
  async callTool(serverName: string, toolName: string, args: unknown): Promise<CallToolResult>;
  /** Watch config.mcpServers for hot-reload */
  watchConfig(onChange: (newConfig: McpServerConfig[]) => void): void;
  /** Cleanup all servers (SIGTERM) */
  async shutdown(): Promise<void>;
}

// Module-level singleton
export const mcpRegistry = new McpRegistry();
```

### 4.3 Reconnection logic

```typescript
// Per-server reconnect
async function scheduleReconnect(name: string) {
  const state = this.servers.get(name);
  if (state.restartAttempts >= 3 && withinLast5Min(state.lastConnectedAt)) {
    state.status = 'error';
    return; // give up
  }
  const delay = Math.min(1000 * 2 ** state.restartAttempts, 60000);
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  await sleep(delay + jitter);
  state.restartAttempts++;
  await this.connect(name);
}
```

### 4.4 Hot-reload behaviour

On `PUT /api/config` with new `mcpServers`:
1. Compute diff (added / removed / modified / transport-changed)
2. For removed: disconnect + delete from registry
3. For transport-changed (e.g. command changed): disconnect old, connect new
4. For other field changes (timeout, autoApprove): hot-update in place
5. For added: connect and `listTools` before returning

This matches Cline/Roo behaviour and avoids surprising the user with broken state.

### 4.5 Stderr handling for stdio

Stderr from MCP servers is logging only (per spec). Route to the existing `console.error` prefixed with `[mcp:<server-name>]` so it appears in server logs and the in-app log panel without being confused with tool output.

---

## 5. Tool Registration & Dispatch

### 5.1 Schema conversion (`services/mcp/toolAdapter.ts`)

MCP's `Tool.inputSchema` is JSON Schema, structurally identical to Ollama's `parameters` field. Conversion is 1:1:

```typescript
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { OllamaTool } from '../../tools/tools.js';

export function mcpToolToOllamaTool(serverName: string, mcpTool: McpTool): OllamaTool {
  return {
    type: 'function',
    function: {
      name: `mcp__${serverName}__${mcpTool.name}`,
      description: `[MCP:${serverName}] ${mcpTool.description ?? mcpTool.name}`,
      parameters: mcpTool.inputSchema as OllamaTool['function']['parameters'],
    },
  };
}
```

The `[MCP:server]` prefix in the description gives the LLM provenance context.

### 5.2 Dynamic TOOLS list (`tools/tools.ts`)

Currently `TOOLS` is a hard-coded `const` array. Convert to a derived list:

```typescript
// Before:
export const TOOLS: OllamaTool[] = [ /* 12 hardcoded entries */ ];

// After:
export const NATIVE_TOOLS: OllamaTool[] = [ /* 12 hardcoded entries */ ];
export function getAllTools(): OllamaTool[] {
  return [...NATIVE_TOOLS, ...mcpRegistry.getAllTools()];
}
```

All call sites that currently use `TOOLS` need updating:
- `app/api/chat/route.ts:435` — `getAllTools().filter(...)`
- `app/api/chat/route.ts:293` (sub-agent) — same
- The system prompt generator — keep the numbered list using `NATIVE_TOOLS` (MCP tool descriptions appear in the JSON schema list sent to the LLM, not in the human-readable system prompt)

### 5.3 Dispatcher entry (`tools/impl/mcpTool.ts`)

A single `IToolCommand` per MCP tool, registered at connect time:

```typescript
import type { IToolCommand, ToolCallResult, RequestContext } from '../toolRegistry.js';
import { checkToolAllowed } from '../toolRegistry.js';
import { mcpRegistry } from '../../services/mcp/registry.js';
import { formatMcpToolResult } from '../../services/mcp/toolAdapter.js';

export class McpToolCommand implements IToolCommand {
  constructor(
    private readonly serverName: string,
    private readonly toolName: string,
    private readonly serverConfig: McpServerConfig
  ) {}

  async execute(
    args: ToolCallArguments,
    onProgress?: (msg: string) => void,
    output?: ToolOutputSink,
    context?: RequestContext,
    signal?: AbortSignal
  ): Promise<ToolCallResult> {
    // 1. Allowlist check
    const permErr = checkToolAllowed(`mcp__${this.serverName}__${this.toolName}`, context);
    if (permErr) return { content: permErr };

    // 2. Per-server disabled-tool check
    if (this.serverConfig.disabledTools?.includes(this.toolName)) {
      return { content: `[Error: tool "${this.toolName}" is disabled on server "${this.serverName}"]` };
    }

    // 3. Status check
    const status = mcpRegistry.getStatus(this.serverName);
    if (status !== 'connected') {
      return { content: `[Error: MCP server "${this.serverName}" is not connected (status: ${status})]` };
    }

    // 4. Call MCP
    try {
      const result = await mcpRegistry.callTool(
        this.serverName,
        this.toolName,
        args,
        { signal, timeoutMs: (this.serverConfig.timeoutSeconds ?? 60) * 1000 }
      );
      return formatMcpToolResult(result);
    } catch (err) {
      return { content: `[Error: MCP call failed: ${(err as Error).message}]` };
    }
  }
}
```

### 5.4 Result formatting (`services/mcp/toolAdapter.ts`)

```typescript
export function formatMcpToolResult(result: CallToolResult): ToolCallResult {
  const textBlocks: string[] = [];
  const images: string[] = [];

  for (const block of result.content) {
    switch (block.type) {
      case 'text':
        textBlocks.push(block.text);
        break;
      case 'image':
        images.push(block.data); // base64 → routed to ChatMessage.images
        textBlocks.push(`[image: ${block.mimeType}, ${Math.round(block.data.length * 0.75)} bytes]`);
        break;
      case 'audio':
        // Drop audio in MVP (no audio support in ChatMessage). Log warning.
        textBlocks.push(`[audio block dropped: ${block.mimeType}]`);
        break;
      case 'resource':
        textBlocks.push(`[embedded resource: ${block.resource.uri}]`);
        break;
    }
  }

  return {
    content: result.isError
      ? `[MCP returned isError=true]\n${textBlocks.join('\n')}`
      : textBlocks.join('\n') || '(empty result)',
    images: images.length > 0 ? images : undefined,
  };
}
```

---

## 6. Web UI Integration

### 6.1 `app/api/mcp/route.ts`

```typescript
// GET /api/mcp → list servers + tools + status
// POST /api/mcp → { action: 'connect' | 'disconnect' | 'reload', serverName: string }

export async function GET() {
  const servers = mcpRegistry.listServers();
  return NextResponse.json({
    servers: servers.map(s => ({
      name: s.config.name,
      description: s.config.description,
      transport: s.config.transport.type,
      status: s.status,
      lastError: s.lastError,
      toolCount: s.tools.length,
      tools: s.tools.map(t => ({
        name: t.name,
        fullName: `mcp__${s.config.name}__${t.name}`,
        description: t.description,
        autoApprove: s.config.autoApprove?.includes(t.name) ?? false,
        disabled: s.config.disabledTools?.includes(t.name) ?? false,
      })),
    })),
  });
}
```

### 6.2 Settings UI (`components/SettingsModal/McpServerEditor.tsx`)

A new collapsible section in the existing SettingsModal:

- **Server list** with name, transport type, status badge (green/yellow/red), tool count
- **Add server** button → modal with form fields:
  - Name (text)
  - Transport: radio (stdio | http | sse)
  - Stdio fields: command, args (chip list), env (key/value pairs), cwd
  - HTTP/SSE fields: url, headers (key/value pairs)
  - Auto-approve: multi-select from `tools/list` result (populated on Test Connection)
  - Timeout seconds
  - Disabled toggle
- **Per-server actions**: Test Connection, Disconnect, Remove
- **Hot-reload**: every change triggers a debounced `PUT /api/config` → `mcpRegistry.applyConfigDiff()`

### 6.3 Slash command

Add `/mcp` to:
- `components/ChatInput/ChatInput.tsx` `COMMANDS` array
- `app/hooks/useSlashCommands.ts` `handleSlashCommand` switch
- New `app/api/mcp/route.ts` GET already exists, so the command can `fetch('/api/mcp')` and render the result inline

Behaviours:
- `/mcp` — list servers + status
- `/mcp reload` — force reconnect all servers
- `/mcp test <name>` — test a single server
- `/mcp tools <name>` — list tools from a server

---

## 7. Approval & Safety

### 7.1 Extend the existing approval registry

`app/lib/approvalRegistry.ts` already handles `run_command`. Generalise to handle any tool by name:

```typescript
// Before: hard-coded for run_command
// After: keyed by tool name
export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  args: unknown;          // displayed in the approval dialog
  serverName?: string;    // for MCP: which server
  description?: string;
}
```

The `approval_request` SSE event already exists in `app/api/chat/route.ts:497-525`. Extend it to fire for any tool not in its server's `autoApprove` list.

### 7.2 YOLO mode interaction

YOLO mode (`context.yoloMode === true`) auto-approves all tool calls. Document this in the safety section of `copilot-instructions.md` and in the README — running `locopilot --yolo` with an MCP server that exposes a `run_command`/`execute_shell` tool is equivalent to giving that server full shell access.

### 7.3 Per-server disabled toggle

A `disabled: true` flag in `McpServerConfig` causes the server to be skipped during tool discovery; existing `mcp__<server>__*` tools are unregistered but kept in `disabledMain` so the LLM isn't shown them.

---

## 8. Concurrency: Per-Request vs Module-Level

The codebase already has precedent for both patterns. Decide per concern:

| Concern | Scope | Rationale |
|---|---|---|
| **Server connections** | Module-level singleton (`mcpRegistry`) | MCP servers are long-lived processes/SSE streams; per-request spawn would be catastrophic for performance and reliability. |
| **Tool list** | Module-level (rebuilt on registry changes) | Same reasoning; rebuilt on config change notifications. |
| **Tool call dispatch** | Module-level client, per-request `AbortSignal` | The MCP client call accepts `signal`; abort propagates through the SDK. |
| **Error reporting back to user** | Per-request through `RequestContext.output` | Reuse existing pattern from `runCommandTool`. |
| **Approval gate** | Per-request (already a Map keyed by `requestId`) | Existing `approvalRegistry` already per-request. |

The `enterRequestScope()` AsyncLocalStorage pattern (used for the command process registry) is **not** needed for MCP — the SDK clients themselves are async and stateless across requests (you just pass different signals). Reserve AsyncLocalStorage for genuinely per-request state.

---

## 9. Implementation Phases

### Phase 1 — MVP (3–5 days)

**Goal:** A user can add one stdio MCP server via Settings and have its tools appear in the LLM's tool list.

1. **Day 1: Skeleton & schema**
   - Add `McpServerConfig` types to `types/chatConfig.ts`
   - Add MCP defaults to `constants.ts` (`MCP_DEFAULT_TIMEOUT_S = 60`, etc.)
   - `services/mcp/config.ts` — env var expansion + validation
   - `services/mcp/registry.ts` — `McpRegistry` class skeleton (no real connections yet)
   - `services/mcp/toolAdapter.ts` — `mcpToolToOllamaTool()` and `formatMcpToolResult()`

2. **Day 2: Client & lifecycle**
   - `services/mcp/client.ts` — `connectStdio()`, `connectHttp()` factory functions
   - `services/mcp/transports/stdio.ts` + `http.ts` — thin config builders
   - Implement `connect()`, `disconnect()`, `callTool()`, `getAllTools()` in registry
   - Implement reconnection with backoff for stdio
   - Implement SIGTERM handler in `mcpRegistry.shutdown()` and wire to `process.on('SIGTERM')`

3. **Day 3: Tool registration**
   - `tools/impl/mcpTool.ts` — `McpToolCommand` class
   - Modify `tools/tools.ts` — convert `TOOLS` → `NATIVE_TOOLS` + `getAllTools()`
   - Modify `tools/toolRegistry.ts` — no structural change (still a `Map`)
   - Add hot-reload from config (no chokidar yet; reload on next request after PUT)

4. **Day 4: API & settings UI**
   - `app/api/mcp/route.ts` — GET (list) + POST (connect/disconnect)
   - `app/api/config/route.ts` — already supports partial-merge PUT; no change needed beyond ensuring `mcpServers` survives the merge
   - `components/SettingsModal/McpServerEditor.tsx` — basic add/remove UI for stdio servers
   - Test connection button

5. **Day 5: Slash command & docs**
   - Add `/mcp` to `COMMANDS` array and `useSlashCommands.ts`
   - Update README and `.github/copilot-instructions.md` with the new feature entry
   - Smoke test with the official `@modelcontextprotocol/server-filesystem`

**Exit criteria:** User can `npx @modelcontextprotocol/server-filesystem /tmp` via Settings, see `mcp__filesystem__*` tools in the LLM, and the LLM successfully reads a file.

### Phase 2 — Standardisation (4–6 days)

1. **HTTP/SSE transports** (1 day)
   - `services/mcp/transports/http.ts` + `sse.ts`
   - Add transport selector to `connect()`
   - Reconnection logic for HTTP (different from stdio)

2. **Tool namespacing verification** (0.5 day)
   - Audit the entire tool dispatch path for name collisions
   - Update `checkToolAllowed` to support wildcards (`mcp__github__*`)

3. **Per-tool approval gate** (2 days)
   - Generalise `app/lib/approvalRegistry.ts` to accept any tool name
   - Update `app/api/chat/route.ts` approval branch to fire for non-`autoApprove` MCP tools
   - Add `approval_request` SSE event with `serverName`, `toolName`, `args`
   - Add client-side approval dialog (or reuse existing one)

4. **Hot-reload via config watcher** (1 day)
   - Use `chokidar` (already a transitive dep, but add explicitly) or `fs.watch` to watch `config.json`
   - Debounce, compute diff, apply changes
   - Handle the case where the user is in the middle of a tool call when config changes (queue or warn)

5. **`notifications/tools/list_changed` handling** (1 day)
   - Register the notification handler on each `Client`
   - On notification: re-`listTools`, re-register any new/changed tools
   - This handles MCP servers that change their tool set at runtime

6. **Documentation & error polish** (0.5 day)
   - Better error messages for common failure modes (server won't start, handshake timeout, schema validation failure)
   - Add MCP section to README

**Exit criteria:** User can use both stdio and HTTP/SSE servers, get a clear approval prompt for risky tools, and have config changes applied without restart.

### Phase 3 — Advanced (5–8 days)

1. **MCP Tool Search (lazy loading)** (2 days)
   - When total tool token cost > 10% of `numCtx`, replace full schemas with names + descriptions
   - Add a `search_mcp_tools` meta-tool that fetches the full schema on demand
   - Cache for session duration

2. **Image content routing** (0.5 day)
   - Already handled in `formatMcpToolResult()`; add an integration test for vision-capable models

3. **OAuth for remote servers** (2–3 days)
   - OAuth 2.1 + PKCE flow for servers that advertise `authorization_servers` in their `InitializeResult`
   - Token storage in `~/.locopilot/mcp-tokens.json` with restrictive file permissions
   - Re-authentication flow on 401

4. **Per-server timeouts and concurrency limits** (0.5 day)
   - Enforce `timeoutSeconds` on every call
   - Optional `maxConcurrentCalls` to prevent one chatty server from saturating the LLM

5. **Server status panel** (1 day)
   - Expand `/mcp` slash command to show per-server uptime, call counts, last error
   - Optional sidebar widget showing connected server count

6. **Sandbox hint** (0.5 day, optional)
   - Add a `sandbox: { filesystem?: {...}, network?: {...} }` config section
   - Implementation: route stdio subprocess through a wrapper that enforces filesystem + network rules
   - **Defer to a separate effort** if VS Code's `sandboxEnabled` model proves too complex; most local users won't need it

**Exit criteria:** A user with 10+ MCP servers gets acceptable context utilisation, OAuth servers authenticate seamlessly, and a power user can monitor per-server health.

---

## 10. Testing Strategy

### 10.1 Unit tests (`tests/services/mcp/`)

- `config.test.ts` — env var expansion edge cases (`${VAR:-default}`, missing vars, recursive expansion)
- `toolAdapter.test.ts` — MCP Tool → OllamaTool conversion (text/image/audio/resource content blocks)
- `registry.test.ts` — connect/disconnect lifecycle, reconnection backoff calculation, tool re-registration on `list_changed`

### 10.2 Integration tests (`tests/integration/mcp/`)

- Spawn a mock stdio MCP server (a simple Node script that implements the protocol) and verify the full handshake
- Spawn a mock HTTP/SSE server (e.g. `nock` or a local Express app) and verify reconnection on `ECONNRESET`
- Verify tool name collision handling (two servers with same-named tools)

### 10.3 Manual test plan

1. Add `@modelcontextprotocol/server-filesystem` via Settings
2. Verify the LLM can read a file
3. Add a second server (e.g. `@modelcontextprotocol/server-git`)
4. Verify the LLM can use both, and tool names are namespaced correctly
5. Test config edit (change `args`) while a session is active — server should reconnect, no error to user
6. Test approval gate: add a server with no `autoApprove`, verify the approval dialog appears
7. Test YOLO mode: `--yolo` skips approval — verify this works and document the security implications
8. Test sub-agent isolation: sub-agents should see only the filtered MCP tool list (not `mcp__X__destructive_tool` if `disabledSubAgent` includes it)

---

## 11. Documentation Updates

### 11.1 Files to update

- `README.md` — Add "MCP Servers" section with example config
- `.github/copilot-instructions.md` — Add MCP to the "Application overview" and a "Tool-calling" subsection
- New: `MCP.md` (top-level) — full feature documentation, config schema, security model
- New: `docs/adding-mcp-server.md` — for users who want to add a server

### 11.2 Maintenance instructions (append to `copilot-instructions.md`)

```
- 2026-06-XX: Added MCP (Model Context Protocol) server support
  - Files: services/mcp/** (new), tools/impl/mcpTool.ts (new), app/api/mcp/route.ts (new),
           components/SettingsModal/McpServerEditor.tsx (new), types/chatConfig.ts,
           tools/tools.ts, app/api/chat/route.ts, app/hooks/useSlashCommands.ts,
           components/ChatInput/ChatInput.tsx
  - Summary: Locopilot can now connect to MCP servers declared in config.mcpServers
    and expose their tools to the LLM as mcp__<server>__<tool>.
  - Intent: Allow users to extend Locopilot with arbitrary external tools (filesystem,
    GitHub, databases, custom APIs) without modifying Locopilot source.
  - Security: Default-approval model; per-server autoApprove allowlist; YOLO mode
    bypasses approval (same as native run_command).
  - Transport support: stdio, streamable-http, sse (legacy).
```

---

## 12. Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "chokidar": "^3.6.0"
  }
}
```

**Note:** `@modelcontextprotocol/sdk` requires Node 18+ (uses `fetch`, `ReadableStream`). Verify the project's `engines.node` field covers this.

---

## 13. Risks & Open Questions

### Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| MCP server crashes mid-conversation | High | Medium | Reconnection with backoff; surface error to LLM as tool result; show red badge in settings |
| Context window overflow from many tools | High | High | Phase 3 Tool Search implementation; consider raising the system prompt's tool list to mention "use sparingly" |
| Tool name collision between servers and native | Low | High | Namespacing (`mcp__*__*` prefix) + audit before launch |
| User adds malicious MCP server (stdio = arbitrary code execution) | Medium | High | Document security model prominently; default-approval; future sandbox work |
| Long-running tool calls blocking the chat | Medium | Medium | Per-server `timeoutSeconds`; `AbortSignal` propagation |
| `Ollama` model returns malformed tool_call with non-existent MCP tool | Low | Low | `toolRegistry.get()` already returns `[Unknown tool: ...]` for missing tools |

### Open questions for the user

1. **Where should the config file live?** Plan assumes `config.json` (existing). An alternative is a separate `.mcp.json` for cleaner separation (matches Claude Code, Cursor). Recommendation: **start with `config.json`**, factor out later if the section grows.
2. **Should `/mcp` accept JSON config inline (like Claude Code's `add-json`)?** Phase 1 ships a form-based editor; this can be added in Phase 2 if users ask for it.
3. **Do you want a "trust this server" master toggle that auto-approves everything from a known server?** Some tools have this; it trades safety for convenience.
4. **Is a separate `.github/MCP.md` documentation file preferred, or fold everything into `README.md` + `copilot-instructions.md`?**
5. **Windows-specific concerns?** Stdio transport uses `cmd /c` wrapper (Cline pattern) for npx-style commands. Need a smoke test on Windows before merge.
6. **Should we ship a sample config or a CLI helper to install popular MCP servers (similar to `claude mcp add`)?** Out of scope for MVP but worth considering.

---

## 14. Summary of File Changes

### New files
- `services/mcp/index.ts`
- `services/mcp/client.ts`
- `services/mcp/registry.ts`
- `services/mcp/config.ts`
- `services/mcp/errors.ts`
- `services/mcp/toolAdapter.ts`
- `services/mcp/types.ts`
- `services/mcp/transports/stdio.ts`
- `services/mcp/transports/http.ts`
- `services/mcp/transports/sse.ts`
- `tools/impl/mcpTool.ts`
- `app/api/mcp/route.ts`
- `components/SettingsModal/McpServerEditor.tsx`
- `MCP.md`
- `tests/services/mcp/*.test.ts` (multiple)
- `tests/integration/mcp/*.test.ts` (multiple)

### Modified files
- `types/chatConfig.ts` — add `McpServerConfig`, `McpTransport*` types
- `constants.ts` — add MCP defaults
- `tools/tools.ts` — `TOOLS` → `NATIVE_TOOLS` + `getAllTools()`; update system prompt generator
- `app/api/chat/route.ts` — use `getAllTools()`; generalise approval branch
- `app/api/config/route.ts` — verify `mcpServers` partial-merge works (likely no change)
- `app/lib/approvalRegistry.ts` — generalise to any tool name
- `app/hooks/useSlashCommands.ts` — add `/mcp` handler
- `components/ChatInput/ChatInput.tsx` — add `/mcp` to `COMMANDS` array
- `components/SettingsModal/SettingsModal.tsx` — add MCP section
- `package.json` — add `@modelcontextprotocol/sdk`, `chokidar`
- `README.md` — document MCP
- `.github/copilot-instructions.md` — feature entry + maintenance note

### Estimated LOC
- New: ~1,200 lines
- Modified: ~200 lines
- Tests: ~600 lines

---

## Phase 1 Implementation Notes (added 2026-06-04)

Phase 1 (MVP) was implemented as a single-pass refactor. Below is a record
of what was built, what was intentionally left for Phase 2/3, and any
deviations from the original plan.

### What was built

- `mcp/types.ts` — `MCPServerConfig`, `MCPRootConfig`, `MCPTransportConfig`
  (stdio/http/sse variants), runtime `MCPClientHandle` + `MCPToolInfo`, and
  `MCPConfigError` / `MCPConnectionError` / `MCPProtocolError` error classes.
- `mcp/configLoader.ts` — reads `~/.locopilot/mcp.json` (or the
  VS-Code-style `servers` key, normalised to `mcpServers`), validates
  server names and stdio transport fields, returns an empty config on
  any failure (missing file / malformed JSON / validation error).
- `mcp/clientManager.ts` — process-global `MCPClientManager` singleton
  with `connect()`, `disconnect()`, `closeAll()`, `get()`, and
  `getTimeoutMs()`. Lazy connect on first call; one `Client` per
  server name. Wires `SIGTERM` / `SIGINT` / `beforeExit` to `closeAll()`.
- `mcp/schemaAdapter.ts` — converts `MCPToolInfo` → `ToolDefinition` with
  the `mcp__<server>__<tool>` namespace; `dispatchMCPToolCall` parses
  the namespaced name, lazy-connects, enforces the `disabledTools`
  blocklist, applies the per-call `autoApprove`/`approvedTools` gate,
  and races the call against `AbortSignal` + the server timeout. Image
  content is forwarded to `ToolCallResult.images`; audio is dropped
  (Phase 3+ when Locopilot adds audio support).
- `mcp/index.ts` — public facade re-exporting the rest, plus
  `listMCPServersWithStatus()`, `reloadMCP()`, and the
  `getMergedMCPToolDefinitions()` helper used by the chat route.
- `tools/impl/mcpTool.ts` — the `mcp_call` `IToolCommand` entry. Takes
  `server` + `tool` + `arguments` and delegates to
  `dispatchMCPToolCall`. Validates names (kebab-case for server, MCP
  tool name regex for tool, rejects namespace separator leakage) before
  dispatching.
- `tools/toolRegistry.ts` — `mcp_call` is added to the `toolRegistry`
  Map. `ToolCallArguments` grows `server`/`tool`/`arguments`. The
  `RequestContext` interface gains a `mcpApprovals?: string[]` slot
  for the per-request set of pre-approved `mcp__<server>__<tool>` names.
- `tools/tools.ts` — `mcpCallToolSchema` is appended to the `TOOLS`
  array; `getMCPCallPrompt()` is added to `getToolSystemPrompt()` as
  tool #13.
- `app/api/chat/route.ts` — imports `getMergedMCPToolDefinitions` and
  builds a per-request `mergedTools` list (static `TOOLS` + dynamic
  MCP tool defs) that's used for the main LLM call. An inline approval
  gate fires an `approval_request` SSE event for `mcp_call`; on
  approval the namespaced target is added to a per-request
  `mcpApprovals` set that flows into `RequestContext` for subsequent
  calls in the same request.
- `app/api/mcp/route.ts` — `GET` lists configured servers and their
  tools (lazy-connects a single server when `?connect=<name>` is
  passed); `POST` with `{ action: "reload" }` closes all clients and
  re-reads the config.
- `app/hooks/useSlashCommands.ts` — adds the `/mcp` slash command
  with `list` (default) and `reload` subcommands.
- `components/ChatInput/ChatInput.tsx` — `/mcp` is added to the
  autocomplete `COMMANDS` array.
- `tools/TOOL_GUIDE.md` — `mcp_call` is added to the tool list and a
  short "MCP tools" subsection is appended.
- `package.json` — adds `@modelcontextprotocol/sdk@^1.29.0` (current
  installed version is 1.29.0).

### Deviations from the plan

1. **Single tool, not per-MCP-tool registry entries.** The plan's
   §5.3 sketched one `McpToolCommand` per MCP tool, registered at
   connect time. Phase 1 ships a single `mcp_call` command that takes
   the server + tool names as args and delegates to
   `dispatchMCPToolCall`. The LLM sees one tool, not N. This matches
   the explicit Phase 1 deliverable list in the prompt
   ("ONE tool named `mcp_call`"). The schema list sent to the LLM
   still includes the namespaced `mcp__<server>__<tool>` schemas
   (built by `getMergedMCPToolDefinitions`) for visibility, but the
   `toolRegistry` only contains `mcp_call` — the dispatcher is the
   single chokepoint for namespacing. Phase 3 can revisit per-tool
   entries if we want the model to call `mcp__github__list_issues`
   directly without going through `mcp_call`.

2. **No `Service` parent directory rename.** The plan's §2.1 file
   layout puts everything under `services/mcp/`, but the project's
   existing convention is to keep directories at the root level for
   top-level subsystems (alongside `tools/`, `components/`, etc.).
   Phase 1 uses `mcp/` at the project root. This keeps the imports
   shorter (`from '../../mcp'`) and matches `skills/` and similar
   top-level modules.

3. **Inline approval gate, not generalised registry.** The plan's §7.1
   asks for the `approvalRegistry` to be generalised to any tool name.
   Phase 1 reuses the existing `approvalRequest` /
   `waitForApproval` flow for `mcp_call` by adding a second inline
   gate in the chat route (alongside the `run_command` one). The
   registry is not modified. There is an explicit TODO in the chat
   route marking this as Phase 2 work.

4. **Sub-agent tool list stays static.** The sub-agent `tools` array
   still filters the static `TOOLS` list and does NOT include dynamic
   MCP tool defs. Sub-agents can still call `mcp_call` (it's in the
   static list), so MCP capability is reachable, but the schema-level
   discoverability of `mcp__<server>__<tool>` names is only on the
   main LLM. Phase 2 should merge dynamic defs into the sub-agent
   tool list too.

5. **`mcp.json` lives at `~/.locopilot/mcp.json`** as the plan's
   "Open Questions" default recommended. No changes to
   `services/configManager.ts` were made.

### TODOs intentionally left for Phase 2

- Generalise the approval registry to accept any tool name (Phase 2
  item 3 in the plan). Until then, `mcp_call` has a parallel inline
  gate in the chat route.
- Hot-reload of `mcp.json` (Phase 2 item 4). Phase 1 requires the
  user to run `/mcp reload` (or restart) after editing the file.
- `notifications/tools/list_changed` handling (Phase 2 item 5).
- HTTP / SSE transports (Phase 2 item 1). Phase 1 explicitly rejects
  them at config-load time.
- Audio content block support in `formatMCPResult` (deferred with
  Locopilot's general audio support).
- Wildcard approval matching (`mcp__github__*`) — currently the
  approval set is exact-name only.
- Thread a `disabledSubAgent` list into the `SubAgentConfig` so the
  sub-agent tool list can be filtered the same way the main LLM's
  is. Phase 1 only honours `disabledMainTools` in `runMCPCall`;
  a TODO comment marks the spot.

### Known Phase 1 limitations (defects fixed post-review)

The post-review pass (2026-06-04) addressed the following issues
called out by an independent bug-hunt subagent. Each entry links
to the issue ID from the bug report and notes whether the fix is
considered complete for Phase 1 or whether the proper resolution
is deferred to a later phase.

- **A1 — Stdio child-process leak when `closeAll` races an in-flight
  `connect` (CRITICAL).** Fixed for Phase 1. The client manager now
  keeps an in-flight promise map and an `AbortController` per
  connecting handle, so `disconnect()` / `closeAll()` always tears
  down the spawned transport even if `client.connect()` never
  returns. See `mcp/clientManager.ts`.
- **A2 — `AbortSignal` not propagated to `client.callTool` (CRITICAL).
  ** Fixed for Phase 1. The dispatcher now passes the per-request
  signal through the SDK's `options.signal` on both `client.connect`
  and `client.callTool`. The `Promise.race` wrapper is kept as a
  belt-and-braces safety net in case the SDK ever fails to honour
  the signal. See `mcp/schemaAdapter.ts`.
- **A3 — `disabledMainTools` bypassed via `mcp_call` (HIGH).** Fixed
  for Phase 1. `runMCPCall` now rejects with a clear error if the
  namespaced target is in `disabledMainTools`. The sub-agent list
  is left as a TODO since `SubAgentConfig` doesn't yet carry it.
- **A4 — First-time UX: LLM never sees MCP tool schemas (HIGH).**
  Fixed for Phase 1. New `connectAllEnabled(timeoutMs)` helper
  eagerly connects to every enabled server (with a 5s backstop)
  before the tool list is built, so the LLM sees the schemas on
  the first request. Used by `getMergedMCPToolDefinitions` and
  `listMCPServersWithStatus`.
- **A5 — `autoApprove` does not skip the per-call prompt (MEDIUM).
  ** Fixed for Phase 1. New `getMCPServerConfig(name)` helper plus
  inline `autoApprove` check in the chat-route gate. The TODO
  comment has been removed.
- **A6 — Second `mcp_call` in the same turn re-prompts (MEDIUM).**
  Fixed for Phase 1. The chat-route gate now short-circuits when
  the namespaced target is already in `mcpApprovalsSet`.
- **A8 — In-flight call survives `reloadMCP` (MEDIUM).** Subsumed
  by A1 + A2. The aborted signal reaches the SDK call, which
  rejects, which trips the disconnect path.
- **A9 — `connect()` polling loop has no timeout (MEDIUM).**
  Subsumed by A1. The polling loop is gone (the in-flight promise
  map replaces it); the connect is bounded by the SDK's own
  handshake and by the per-request AbortSignal.
- **B1 — `env` in `mcp.json` can override `PATH` / `LD_PRELOAD` /
  `NODE_OPTIONS` / `IFS` (MEDIUM).** Fixed for Phase 1. A
  `DANGEROUS_ENV_KEYS` blocklist (plus the `BASH_FUNC_*` wildcard
  for exported bash functions) rejects risky keys at config-load
  time with an actionable error. See `mcp/configLoader.ts`.
- **B4 — Tool name spoofing via server named `run_command` (LOW).
  ** Fixed for Phase 1. `MCP_FORBIDDEN_SERVER_NAMES` set in
  `mcp/schemaAdapter.ts` blocks server names that collide with
  native tool names; the config loader enforces the same rule
  up front.
- **C1 — `mcp_call` approval modal shows the wrong thing (MEDIUM).
  ** Fixed for Phase 1. The chat route already sent `toolCallName`;
  the client now plumbs it through to the approval modal, which
  renders a friendlier header (`Allow MCP tool mcp__x__y?`) plus a
  key/value argument list for `mcp_call` while preserving the
  existing raw-JSON view for `run_command`.
- **C3 — `/mcp list` shows disconnected servers (MEDIUM).** Fixed
  for Phase 1. `listMCPServersWithStatus` now also uses
  `connectAllEnabled`, so the listing reflects the live tool set.
- **C4 — `/mcp foo` shows usage with broken command syntax (LOW).
  ** Fixed for Phase 1. The usage string now includes the `/mcp`
  prefix on each example.
- **C5 — `mcp.json` with BOM is silently dropped (LOW).** Fixed
  for Phase 1. A leading UTF-8 BOM is stripped before `JSON.parse`.
- **D1 — `RequestContext.mcpApprovals` docstring says `Set<string>`
  but type is `string[]` (LOW).** Fixed for Phase 1. Docstring
  now matches the type and notes the consumer-side wrapping.
- **D2 — Two `null as unknown as Client` casts (LOW).** Subsumed
  by A1. The connecting placeholder is now a typed `ConnectingHandle`
  rather than a coerced `MCPClientHandle`.
- **E1 — `mcpCallToolSchema` style doesn't match the rest (LOW).
  ** Fixed for Phase 1. Realigned colons and indentation to match
  `runCommandToolSchema`.
- **E2 — `import type { ToolSchema }` mid-file (LOW).** Fixed for
  Phase 1. Moved to the top of `tools/impl/mcpTool.ts` and grouped
  with the other type imports.
- **F2 — `TOOL_GUIDE.md` missing the `disabledMainTools` caveat
  (LOW).** Fixed for Phase 1. Added a paragraph to the MCP tools
  section.

### Things the plan didn't anticipate

- The MCP SDK's `StdioServerParameters` type uses
  `exactOptionalPropertyTypes`-style typing, so we can't pass
  `env: undefined` directly. `clientManager.ts` builds the parameters
  object conditionally.
- The SDK's `CallToolResult` is a discriminated union of
  `{ content: [...] }` and `{ toolResult: unknown }` shapes (the
  latter is for tools that declare an `outputSchema`). TypeScript's
  narrowing of the union doesn't survive the `Promise.race` wrapper
  in `dispatchMCPToolCall`, so `formatMCPResult` does a runtime
  presence check plus a local type assertion.
- The `getDefaultEnvironment` from the SDK only carries a small set
  of "safe" env vars when no `env` is provided — Phase 1 doesn't
  call it because the config loader always sets `env` to either the
  user-provided map or `undefined`. If a user wants to inherit
  everything, they need to set `env: { ...process.env }` explicitly
  (or we add a Phase 2 convenience).
- The `npm install` of the SDK pulled in 73 new packages and
  bumped the lockfile by ~200KB. No conflicts with the existing
  dependency tree were observed.
