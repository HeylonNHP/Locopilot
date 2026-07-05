# Locopilot Tools Guide

This document explains how the tool system works in `c:\git\Locopilot-dev\tools` and how to safely modify or add tools.

## Architecture Overview

The tools system is split across three main layers:

1. `tools/tools.ts`
   - Public facade for the tools subsystem.
   - Exposes the tool schema list (`TOOLS`), system prompt builder (`getToolSystemPrompt()`), generic dispatcher (`handleToolCall()`), and helper exports such as `sanitize()` and `getToolUseNudge()`.
   - Does not contain the execution logic for individual tools.

2. `tools/toolRegistry.ts`
   - Implements the Command pattern.
   - Stores a `Map<string, IToolCommand>` called `toolRegistry`.
   - Each tool is represented as an object implementing `IToolCommand.execute(args, onProgress)`.
   - Encapsulates validation, parsing, and delegation to the tool implementation modules.

3. `tools/commandHelpers.ts`
   - Shared argument parsing utilities used by multiple tools.
   - Contains helpers such as `parsePositiveTimeoutMs()`, `parsePositiveInteger()`, and `parseQueriesInput()`.

### Tool implementation modules

The actual tool behavior is delegated to modules in `tools/impl/`:

- `tools/impl/webSearchTool.ts`
- `tools/impl/fetchUrlTool.ts`
- `tools/impl/fetchImageTool.ts`
- `tools/impl/readFileTool.ts`
- `tools/impl/readPdfTool.ts`
- `tools/impl/patchFileTool.ts`
- `tools/impl/writeFileTool.ts`

These modules implement the concrete runtime behavior for their respective operations.

## How a tool call flows

1. `handleToolCall(name, args, onProgress)` is invoked.
2. `tools.ts` looks up `toolRegistry.get(name)`.
3. The tool command object executes validation/parsing, then calls a concrete tool adapter.
4. The adapter creates the actual implementation object and invokes its `run()` method.
5. The result is returned as `ToolCallResult`.

This gives a clean separation between:

- the public tool contract,
- schema documentation,
- request validation, and
- actual implementation details.

## File responsibilities

- `tools/tools.ts`
  - Public exports and API surface.
  - Tool schema definitions used in the prompt and by the model.
  - Dispatcher entry point.

- `tools/toolRegistry.ts`
  - Tool command registry and shared state.
  - Per-tool validation, parsing, and execution logic.
  - Web search configuration and YOLO mode state.

- `tools/commandHelpers.ts`
  - Reusable parsing utilities.
  - Keeps validation code DRY across tool handlers.

- `tools/impl/*.ts`
  - Concrete implementations for external behaviors.
  - Each should expose a `run()` method and a `getToolPrompt()` helper.

- `tools/interruptManager.ts`
  - Interrupt coordination helpers unrelated to tool execution logic.

## Adding a new tool

To add a new tool, follow these steps:

1. Add a tool schema entry to `tools/tools.ts` inside the `TOOLS` array.
   - Match the `OllamaTool` structure.
   - Define name, description, parameters, and required arguments.

2. Add a new command object in `tools/toolRegistry.ts`.
   - Register it in `toolRegistry` using the tool name as the map key.
   - Implement `execute(args, onProgress)`.
   - Validate required arguments and return clear error content on invalid inputs.
   - Delegate runtime behavior to a concrete implementation in `tools/impl/` if appropriate.

3. Update `ToolCallArguments` in `tools/toolRegistry.ts`.
   - Add any new argument keys to the shared union.
   - Ensure the new args are typed correctly.

4. If you need shared parsing logic, add a helper to `tools/commandHelpers.ts`.
   - Avoid duplicating validation logic across multiple tools.

5. If the tool requires a new implementation module, add it under `tools/impl/`.
   - Export the runtime class and `getToolPrompt()`.
   - Keep the concrete implementation isolated from the dispatcher.

6. Update `getToolSystemPrompt()` in `tools/tools.ts` so the new `getToolPrompt()` is concatenated in the correct order and uses a unique sequential number.
7. Update this guide (`TOOL_GUIDE.md`) and the root `README.md` when adding new tools.

## Modifying an existing tool

When changing an existing tool:

- Confirm whether the public schema in `tools/tools.ts` needs to change.
- Keep parameter names stable unless the model prompt or external callers also change.
- Update validation inside the corresponding `IToolCommand` in `tools/toolRegistry.ts`.
- If runtime behavior changes, do so in the implementation module under `tools/impl/`.
- Preserve the tool contract: `handleToolCall()` should still return `ToolCallResult` with `content` and optional `images`.

## Conventions and best practices

- Use `toolRegistry` for all tool execution paths.
- Keep `tools.ts` lean: it is the public facade, not a logic container.
- Tool args should be normalized and validated before runtime delegation.
- Use descriptive error strings of the form `\[Error: ...\]` for invalid input.
- Prefer `onProgress` logging only for long-running or external fetch steps.
- Keep tool schema documentation aligned with implementation.
- `getToolSystemPrompt()` should always include the latest tool prompts by composing `getToolPrompt()` helpers.

## Important details

- `handleToolCall()` currently returns an `Unknown tool` message when the name is not registered.
- `getToolUseNudge()` references `isYolo()` and should remain consistent with YOLO mode state.
- `toolRegistry` currently contains the following tool names:
  - `run_command`
  - `check_process_output`
  - `web_search`
  - `fetch_url`
  - `fetch_image`
  - `read_file`
  - `read_pdf`
  - `patch_file`
  - `write_file`
  - `run_subagents`
  - `load_skill`
  - `create_skill`
  - `mcp_call` (Phase 1: delegates to MCP servers in `~/.locopilot/mcp.json`)

- `check_process_output` accepts optional `poll_interval_seconds` so the model can intentionally slow down polling for long-running commands.
- `patch_file` is the preferred way to make small targeted edits to an existing file because it preserves the rest of the file and rejects mismatched patches atomically.

## MCP tools (Phase 1)

`mcp_call` is a thin meta-tool that delegates to MCP (Model Context
Protocol) servers configured in `~/.locopilot/mcp.json`. The tool itself
takes a server name, a tool name, and an optional arguments object; the
actual call goes through `mcp/schemaAdapter.ts` which connects to the
named server on first use, namespaces the call as
`mcp__<server>__<tool>`, and forwards the result back as a normal
`ToolCallResult`.

Phase 1 only ships stdio transport (one `Client` per server, process-global,
lazy-connect on first call). The `mcp__<server>__<tool>` schemas from
already-connected servers are merged into the LLM's tool list by
`app/api/chat/route.ts` at the start of each chat request.

The `/mcp` slash command (and `GET /api/mcp`) lists configured servers
and their tool counts. `/mcp reload` re-reads the on-disk config and
re-initialises all clients (no hot-reload, no file watcher in Phase 1).

User-disabled tools (`tools.disabledMain` in the Locopilot config, exposed
to tools as `RequestContext.disabledMainTools`) are enforced inside
`runMCPCall` itself: any `mcp_call` whose namespaced target appears in the
list returns an error before the dispatcher is reached, regardless of
which path (main LLM, sub-agent, YOLO mode, or the server's own
`autoApprove` list) initiated the call. The namespaced form
(`mcp__<server>__<tool>`) and the bare `mcp_call` token are both checked.

See `MCP_INTEGRATION_PLAN.md` for the full design.

## Validation checklist before committing

- `npx tsc --noEmit` passes.
- New tool names are added to both `TOOLS` and `toolRegistry`.
- Shared args appear in `ToolCallArguments`.
- `getToolSystemPrompt()` still composes the correct prompt strings, with each `getToolPrompt()` using a unique sequential number.
- No behaviour changes are introduced by the refactor.

## Recommended future improvements

- Consider splitting `toolRegistry.ts` into one file per tool if tool count grows significantly.
- Consider adding a test harness for `toolRegistry` command validation.
- Consider documenting tool behavior in the root `README.md` when new tools are added.
