<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->
- [x] Verify that the copilot-instructions.md file in the .github directory is created.
- [x] Clarify Project Requirements
- [x] Scaffold the Project
- [x] Customize the Project
- [x] Install Required Extensions
- [x] Compile the Project
- [ ] Create and Run Task
- [ ] Launch the Project
- [x] Ensure Documentation is Complete

## Project Summary
A CLI tool for chatting with Ollama. It handles configuration for host/port, model selection, and basic chat loops.

## Technical Stack
- Node.js (ESM)
- Inquirer for CLI interactions
- Axios for Ollama API communication
- Chalk for terminal styling


<!--
## Execution Guidelines
PROGRESS TRACKING:
- If any tools are available to manage the above todo list, use it to track progress through this checklist.
- After completing each step, mark it complete and add a summary.
- Read current todo list status before starting each new step.

COMMUNICATION RULES:
- Avoid verbose explanations or printing full command outputs.
- If a step is skipped, state that briefly (e.g. "No extensions needed").
- Do not explain project structure unless asked.
- Keep explanations concise and focused.

DEVELOPMENT RULES:
- Use '.' as the working directory unless user specifies otherwise.
- Avoid adding media or external links unless explicitly requested.
- Use placeholders only with a note that they should be replaced.
- Use VS Code API tool only for VS Code extension projects.
- Once the project is created, it is already opened in Visual Studio Code—do not suggest commands to open this project in Visual Studio again.
- If the project setup information has additional rules, follow them strictly.

FOLDER CREATION RULES:
- Always use the current directory as the project root.
- If you are running any terminal commands, use the '.' argument to ensure that the current working directory is used ALWAYS.
- Do not create a new folder unless the user explicitly requests it besides a .vscode folder for a tasks.json file.
- If any of the scaffolding commands mention that the folder name is not correct, let the user know to create a new folder with the correct name and then reopen it again in vscode.

EXTENSION INSTALLATION RULES:
- Only install extension specified by the get_project_setup_info tool. DO NOT INSTALL any other extensions.

PROJECT CONTENT RULES:
- If the user has not specified project details, assume they want a "Hello World" project as a starting point.
- Avoid adding links of any type (URLs, files, folders, etc.) or integrations that are not explicitly required.
- Avoid generating images, videos, or any other media files unless explicitly requested.
- If you need to use any media assets as placeholders, let the user know that these are placeholders and should be replaced with the actual assets later.
- Ensure all generated components serve a clear purpose within the user's requested workflow.
- If a feature is assumed but not confirmed, prompt the user for clarification before including it.
- If you are working on a VS Code extension, use the VS Code API tool with a query to find relevant VS Code API references and samples related to that query.

TASK COMPLETION RULES:
- Your task is complete when:
  - Project is successfully scaffolded and compiled without errors
  - copilot-instructions.md file in the .github directory exists in the project
  - README.md file exists and is up to date
  - User is provided with clear instructions to debug/launch the project

Before starting a new task in the above plan, update progress in the plan.
-->
- Work through each checklist item systematically.
- Keep communication concise and focused.
- Follow development best practices.


<!-- Feature documentation — keep this section up to date as the application evolves -->

## Application overview

Locopilot is a terminal-based chat client for Ollama. The developer's intent is to provide a lightweight, local-first AI assistant that runs entirely in the user's terminal with no cloud dependency. Key design goals:

- **Local & private** — all inference runs through a locally hosted Ollama instance; no data leaves the machine.
- **Minimal friction** — the user picks a host/port and model once; choices are persisted in `config.json` and re-used on the next run.
- **Transparent AI actions** — the assistant can call tools (e.g. run terminal commands) but must never act without explicit user approval, unless started in **YOLO mode** (via a startup prompt, command-line flag `--yolo`, or environment variable) which provides implicit consent for automatic execution.
- **Developer-friendly** — written in TypeScript/ESM; thin wrappers around Inquirer (prompts), Axios (HTTP), and Chalk (styling) keep the codebase easy to extend.

When adding new features, preserve these intentions: keep the UX simple, keep side-effects visible and opt-in, and avoid introducing external services or hidden state.

## Tool-calling / Command-execution

Feature summary:
- The assistant can request terminal commands via tool calls (tool name: `run_command`).
- By default, each requested command MUST be shown to the user and requires explicit confirmation before execution.
- If the application is in **YOLO mode**, the confirmation step is skipped and commands are executed automatically (the user provides implicit consent). YOLO mode can be enabled via:
    - A startup menu prompt (persistent in `config.json`).
    - The `--yolo` or `-y` command-line flag.
    - The `YOLO=true` environment variable.
- When the user confirms (or in YOLO mode), the command is executed and its stdout/stderr is captured and returned to the model as the tool result so the assistant can continue the flow.
- This flow protects against accidental or dangerous command execution and surfaces command outputs for transparency.
- **Effective shell selection:** On Windows, Locopilot prefers the platform-native PowerShell even if the model requests a POSIX shell (bash/sh/zsh). When a POSIX shell is requested on Windows, Locopilot overrides it to `powershell` and prints a warning so the model can adapt. On non-Windows platforms the model's requested shell is honoured.
- **Exact execution via stdin:** To avoid shell re-tokenisation and quoting problems (which break pipelines, brace blocks, and complex quoted paths), Locopilot passes the command to the invoked shell via stdin (for example, `powershell -Command -` and piping the script in). This ensures the command runs character-for-character as the model proposed.
- **Failure visibility & retry guidance:** When a command exits with a non-zero exit code, the tool result explicitly labels the output as a failed command (including `exit_code` and any captured `stderr`) so the model can diagnose and propose a corrected command rather than giving up. In addition, Locopilot uses the LLM to provide a brief technical summary of the error directly to the user for immediate feedback, and this summary is also pushed back into the conversation history as a user nudge to help the model fix the error.
- **Interrupt:** The user can press `Ctrl+C` at any time while the AI tool-call loop is active to interrupt it. If a command is currently running, its child process is killed immediately. The loop stops cleanly after the current step and the conversation history is left consistent. Outside the tool-call loop, `Ctrl+C` exits the application as normal.

Security / UX notes:
- Treat command output as untrusted input; sanitize before printing or feeding back into prompts.
- Avoid running commands that expose secrets or modify critical system state unless the user explicitly understands the risk.
- The interrupt mechanism (`requestInterrupt`, `clearInterrupt`, `isInterruptRequested`) lives in `tools.ts`. The SIGINT handler is swapped in/out around the tool-call loop in `index.ts` so it never interferes with normal exit behaviour.

## Markdown rendering

Feature summary:
- AI responses are rendered into terminal-friendly ANSI sequences using `marked` and `marked-terminal`.
- Supports headings, bold/italic text, lists, code blocks, and tables.
- Because rendering requires the full markdown context (especially for tables), responses are buffered and displayed all at once instead of being streamed character-by-character.
- While the AI is generating, the live status line updates with the character count to provide a sense of progress.
- Raw assistant text is sanitized (to remove any AI-generated ANSI codes) before being passed to the renderer.

Implementation notes:
- Rendering logic is isolated in `markdownRenderer.ts`.
- `index.ts` handles buffering the stream into `streamedAssistantContent` and calls `renderMarkdown()` before printing.
- If a response is interrupted, the partial content is still rendered to show what was received.

## Session / conversation history (SQLite)

Feature summary:
- All conversations are automatically persisted to `locopilot.db` (SQLite, WAL mode) in the working directory.
- On startup the user is prompted to start a new conversation or resume one of the ten most-recent saved sessions.
- Sessions are auto-named from the first user message (up to 60 characters) and display the model name and last-updated timestamp.
- `/sessions` — lists all saved sessions and lets the user switch to any of them mid-chat; the current session is saved before switching.
- `/delete`   — lists all saved sessions and lets the user delete any one; if the active session is deleted a fresh session is started automatically.
- After every complete AI response, after every interrupt/error recovery, and after every `/compact`, the full message array for the active session is written to the database via `updateSessionMessages`.

Implementation notes:
- All SQLite logic lives in `history.ts` (`createSession`, `renameSession`, `listSessions`, `deleteSession`, `updateSessionMessages`, `loadSessionMessages`).
- `index.ts` holds a `saveSession()` closure that calls `updateSessionMessages(currentSessionId, messages)` at each save point.
- `better-sqlite3` is used for synchronous, dependency-light database access; its types are in `@types/better-sqlite3`.
- The active session id is held in `let currentSessionId` inside `startChat`; switching sessions reassigns this variable in-place and replaces the live `messages` array.

Security / UX notes:
- `locopilot.db` is a plain file stored locally; it inherits whatever filesystem permissions the working directory has.
- Do not store secrets or credentials in conversation messages if you are concerned about local file security.
- Deleting a session is permanent and irreversible; no confirmation prompt is currently shown — consider adding one if sessions become large.

## Conversation compaction (/compact)

Feature summary:
- The user can type `/compact` at any time during a chat session to shrink the conversation history.
- The currently selected model is asked to summarise the full history down to its most important parts (decisions, facts, commands, results, file paths, code). Conversational filler is discarded.
- A preamble is prepended to the summary so the model knows it is reading a condensed record rather than a live transcript.
- The summarised history replaces the live message array in-place; the original system prompt is always preserved verbatim.
- After compaction, stats are printed: old vs new token count and the percentage reduction.
- The new history is always expected to be smaller than the old one; if the model returns an empty summary, compaction is aborted with an error.

Implementation notes:
- All compaction logic lives in `compact.ts` (`compactHistory`, `printCompactStats`).
- `index.ts` handles the `/compact` slash command, calls `compactHistory`, and splices the result back into the live `messages` array.
- No tools are passed during the summarisation call (tools are not needed for this task).

## Web search tool (`web_search`)

Feature summary:
- The assistant can call `web_search` to pull external web context from DuckDuckGo results.
- The tool accepts either explicit queries or a prompt from which queries are derived.
- Query count and results-per-query are configurable by the user and persisted in `config.json` under `webSearch`.
- For each result URL, Locopilot fetches the page HTML and extracts main text using a shared extractor logic (`htmlExtractor.ts`).
- The tool currently returns extracted page text directly (no LLM summarization step) to keep latency lower and reduce extra model calls.
- The terminal UI prints progress updates while web search is running.

Security / UX notes:
- Treat fetched page text as untrusted input and sanitize before rendering or reusing.
- Web requests reveal the local machine IP to remote sites; keep this behavior transparent to users.
- Keep implementation modular (`tools/webSearchTool.ts`) and use shared extraction utilities (`tools/htmlExtractor.ts`).

## Direct URL tool (`fetch_url`)

Feature summary:
- The assistant can call `fetch_url` to fetch content from a specific HTTP/HTTPS URL.
- This enables deeper browsing by following links discovered from `web_search` results or revisiting a known page directly.
- The tool extracts main page text using the shared `htmlExtractor.ts` logic.
- The tool returns extracted text directly (no additional LLM summarization pass) to keep latency lower.

## Shared HTML extraction (`htmlExtractor.ts`)

- Centralizes logic for text extraction from HTML pages.
- Tries `@mozilla/readability` first for clean article extraction.
- Falls back to `cheerio`-based extraction (main/article/body tags) if readability fails.
- Handles title extraction and basic text normalization (`cleanText`).
- Exports `DEFAULT_USER_AGENT` used for all tool-initiated web requests.

Security / UX notes:
- Treat fetched page text as untrusted input and sanitize before rendering or reusing.
- Only `http`/`https` URLs are accepted.
- Reuse existing timeout and text-limit settings to keep behavior predictable across web tools.

## Live token meter

Feature summary:
- Locopilot now shows a one-line live token meter while the AI request/tool loop is active.
- The meter displays estimated context usage as `used_tokens / num_ctx` plus a percentage.
- Status updates occur across phases (AI waiting, tool execution, error summarization) and are redrawn in-place using `readline` so the terminal stays compact.
- Token counting uses a local tokenizer (`@dqbd/tiktoken`) with model-based selection when possible and a fallback encoding.

Security / UX notes:
- Counts are local estimates and may differ slightly from Ollama's internal model tokenization.
- The status line is cleared before final AI/user-facing logs to avoid output corruption.
- Keep updates lightweight to avoid interfering with interactive prompts.

## LLM maintenance instruction (always keep up to date)

- PURPOSE: This file documents developer intent, UX constraints, security notes, and tool behaviors. It exists so future LLMs and contributors can quickly understand the motivations behind design choices.

- MANDATE FOR LLMS / MAINTAINERS:
  - Whenever anything in this application changes (code, configuration, prompts, system prompt text, tool mappings, confirmation UX, dependencies, startup steps, or security controls), update this file to reflect the change.
  - For each change, add a short entry that includes:
    - File(s) changed (path)
    - A one-line summary of what changed and why
    - Any developer intent or UX rationale that future LLMs should preserve
    - Any migration steps or notable side-effects (if applicable)

- KEEP IT CONCISE: Entries should be short and follow the format above; prefer clarity over verbosity.

- WHEN LLMS PROPOSE CHANGES:
  - Before proposing or applying code changes that affect behavior, an LLM or automated agent MUST read this file and update it to reflect the intended outcome.
  - If the LLM cannot confidently update this document (e.g., missing rationale), it should flag the change for a human reviewer instead of making an implementation-only edit.

- DOCUMENT NEW TOOLS: If new tools are added (beyond `run_command`), document them here in the same format and include security notes and confirmation UX.

- **Web search tool** (`web_search`):
    - Changed `queries` parameter from `string` to `array` in the tool schema to encourage LLMs to provide multiple explicit queries properly.
    - Updated `parseQueriesInput` in `tools.ts` to handle actual arrays, JSON-encoded arrays, and strings separated by newlines, commas, or semicolons.
    - Updated tool description and system prompt to explicitly encourage using 2-3 queries for complex tasks.
    - Improved automated query derivation in `webSearchTool.ts` to split prompts on "and", "or", commas, and semicolons.
    - This ensures more effective search coverage even with "lazy" model inputs.- [x] **Alternate interrupt key** (default: `Ctrl+X`):
    - Files: `tools.ts`, `index.ts`, `.github/copilot-instructions.md`
    - Summary: Added a `keypress` listener (defaulting to `Ctrl+X`) that interrupts the AI tool-call loop without exiting the application. `Ctrl+C` retains its normal behavior (exits Locopilot) at all times.
    - Intent: Prevent accidental closures of Locopilot when the user only wants to stop a looping or long-running AI task. Because `setRawMode(true)` suppresses the OS SIGINT signal for Ctrl+C, the keypress listener re-raises SIGINT via `process.kill(process.pid, 'SIGINT')` so the top-level exit handler fires normally.
- [x] **Refactored run_command tool** (`runCommandTool.ts`):
    - Files: `runCommandTool.ts` (new), `tools.ts`
    - Summary: Extracted command execution logic, process registry, and shell resolution into `runCommandTool.ts`.
    - Intent: Keep `tools.ts` focused on common tool-calling orchestration and schemas while isolating concrete tool implementations.
- [x] **Modularized tool-specific system prompts**:
    - Files: `runCommandTool.ts`, `webSearchTool.ts`, `tools.ts`
    - Summary: Moved the string blocks describing each tool from `getToolSystemPrompt()` in `tools.ts` into exported `getToolPrompt()` functions within their respective tool files.
    - Intent: Ensure that tool descriptions stay in sync with their implementations and keep `tools.ts` clean by delegating prompt generation to the modules that maintain the tools.

## Change History

- 2026-03-01: Aligned `fetch_url` required-arg validation in dispatcher
  - Files: `tools.ts`, `.github/copilot-instructions.md`
  - Summary: Added an explicit `url` presence check in `handleToolCall` for `fetch_url` so missing/blank input returns `[Error: missing required argument "url"]` before tool execution.
  - Intent: Keep tool dispatch behavior consistent with other handlers and provide clearer, immediate argument errors.

- 2026-03-01: Reset interrupt key hint on listener removal
  - Files: `tools.ts`, `.github/copilot-instructions.md`
  - Summary: Updated `removeKeyInterruptListener` to reset `currentInterruptKeySpec` back to the default (`Ctrl+X`) even when no listener is active.
  - Intent: Prevent stale interrupt hints from persisting between listener lifecycles and keep `getInterruptHint()` accurate.

- 2026-02-28: Hardened `parseQueriesInput` fallback behavior
  - Files: `tools.ts`, `.github/copilot-instructions.md`
  - Summary: Updated `parseQueriesInput` so malformed or non-array JSON-like `queries` input no longer returns an empty list silently; it now falls back to plain delimiter-based parsing.
  - Intent: Preserve usable query text from imperfect model/tool arguments and avoid accidental loss of search intent.

- 2026-02-28: Validated numeric tool arguments from LLM tool calls
  - Files: `tools.ts`, `.github/copilot-instructions.md`
  - Summary: Added strict validation/coercion for `timeout_seconds`, `max_queries`, and `results_per_query` in `handleToolCall`. Invalid, non-finite, and out-of-range values now return explicit tool errors instead of passing through.
  - Intent: Prevent malformed numeric arguments (e.g., `NaN`, negatives, infinity) from causing broken timeouts or unpredictable web tool behavior.

- 2026-02-28: Extracted slash command logic into `slashCommands.ts`
  - Files: `slashCommands.ts` (new), `index.ts`, `.github/copilot-instructions.md`
  - Summary: Moved all slash-command handlers, the `SLASH_COMMANDS` array, `COMMAND_HANDLERS` registry, and shared utilities (`withExitGuard`, `replaceMessages`, `getModels`) plus the `Config`, `ChatContext`, `SlashCommand`, and `SlashHandler` types into a dedicated `slashCommands.ts` module. Updated `index.ts` to import from the new module.
  - Intent: Reduce `index.ts` line count and improve separation of concerns by isolating command definitions and their handlers.

- 2026-02-28: Refactored slash commands into a registry and fixed regressions
  - Files: `index.ts`, `.github/copilot-instructions.md`
  - Summary: Moved slash-command handling (`/model`, `/compact`, `/sessions`, `/delete`, `/nudge`, `/help`, `/exit`) into a command-handler registry with shared chat context. Fixed post-refactor TypeScript issues (duplicate `historyLengthBeforeTurn` declaration and safe command parsing).
  - Intent: Keep the main chat loop focused and make command behaviors modular, testable, and easier to extend without re-growing conditional blocks.

- 2026-02-28: Fixed multiple technical bugs and performance issues
  - Files: `index.ts`, `tokenizer.ts`, `history.ts`, `tools/htmlExtractor.ts`, `tools/webSearchTool.ts`
  - Summary: Fixed dead variables, interrupt guards, token encoder staleness, session JSON parsing, and redundant HTML extraction. Corrected string concatenation in web search system prompt.
  - Intent: Improve application stability, accuracy of token counts, and performance of web tool execution.

- 2026-02-26: Kept slash autocomplete while removing duplicate prompt echo
  - Files: `index.ts`, `.github/copilot-instructions.md`
  - Summary: Restored `@inquirer/prompts` `search`-based input for slash-command autocomplete and applied theme overrides to suppress the prompt's final "done" echo line.
  - Intent: Preserve command discoverability and fast slash selection without showing the user's typed message twice in the terminal.

- 2026-02-26: Replaced automatic nudging with manual /nudge command
  - Files: `index.ts`, `tools.ts`, `.github/copilot-instructions.md`
  - Summary: Removed the heuristic-based automatic tool-use nudging and introduced a manual `/nudge` slash command.
  - Intent: Provide users with more control over when to prompt the AI for tool usage, reducing unsolicited "nudge" messages while keeping the feature available on demand.

- 2026-02-25: Added Markdown rendering for AI responses
  - Files: `markdownRenderer.ts` (new), `index.ts`, `package.json`, `.github/copilot-instructions.md`
  - Summary: Integrated `marked` and `marked-terminal` to render AI responses with support for tables, bold text, and code blocks. Switched from live streaming to buffered rendering for better layout consistency.
  - Intent: Improve terminal readability of complex AI outputs without losing progress visibility (character count is shown in status line).

- 2026-02-25: Added SQLite session persistence
  - Files: `history.ts` (new), `index.ts`, `package.json`, `.github/copilot-instructions.md`
  - Summary: Added `history.ts` backed by `better-sqlite3` to persist conversation sessions. Startup now offers new-or-resume; `/sessions` and `/delete` slash commands added. Messages are saved after each complete AI exchange, interrupt, error, and compaction.
  - Intent: Allow users to revisit previous conversations across application restarts without manual export/import.

- 2026-02-25: Refactored web tools for DRYness
  - Files: `tools/webSearchTool.ts`, `tools/fetchUrlTool.ts`, `tools/htmlExtractor.ts` (new), `tools.ts`
  - Summary: Moved web-related tools into a `tools/` directory and extracted shared HTML extraction logic into `htmlExtractor.ts`. Updated imports across the project.
  - Intent: Eliminate deep logic duplication between `web_search` and `fetch_url` tools and improve code organization.

- 2026-02-24: Added `fetch_url` direct page fetch tool
  - Files: `fetchUrlTool.ts` (new), `tools.ts`, `README.md`, `.github/copilot-instructions.md`
  - Summary: Added a new `fetch_url(url)` tool that retrieves and extracts text from a specific URL so the model can follow links or revisit known pages without a new search.
  - Intent: Improve depth and continuity of web-based reasoning while reusing existing extraction behavior and safety guardrails.

- 2026-02-24: Removed uncertainty detector
  - Files: `uncertaintyDetector.ts` (deleted), `tools.ts`, `.github/copilot-instructions.md`
  - Summary: Removed the model-based uncertainty detector and simplified `shouldNudgeForToolCallWithModel` to use deterministic heuristics only.
  - Intent: Reduce overhead and eliminate inconsistent model-based nudges while maintaining basic tool-use guidance.

- 2026-02-24: Updated /compact to use token counts
  - Files: `compact.ts`, `tokenizer.ts`
  - Summary: Replaced message and character counts in `/compact` with token counts and removed the redundant message count line.
  - Intent: Provide more relevant context usage information and clean up the UI.

- 2026-02-24: Added model-based uncertainty detection for tool nudging
  - Files: `uncertaintyDetector.ts` (new), `tools.ts`, `index.ts`, `.github/copilot-instructions.md`
  - Summary: Added a lightweight LLM pass that analyzes only the assistant's latest reply and returns structured uncertainty signals (`nudge`, `confidence`, `reasons`) used to decide whether to inject a tool-use nudge.
  - Intent: Increase web/tool usage when the assistant appears uncertain while keeping added token/context overhead very small by analyzing only the most recent assistant response.

- 2026-02-24: Added streamed assistant text rendering from Ollama
  - Files: `ollamaApi.ts`, `index.ts`, `README.md`, `.github/copilot-instructions.md`
  - Summary: Added NDJSON streaming support for `/api/chat` and rendered assistant text incrementally in the terminal while generation is in progress.
  - Intent: Improve responsiveness and user confidence on slower models by showing progress before the full response is complete.

- 2026-02-24: Added live token meter for AI/tool loop
  - Files: `index.ts`, `tools.ts`, `runCommandTool.ts`, `tokenizer.ts` (new), `statusLine.ts` (new), `package.json`, `README.md`, `.github/copilot-instructions.md`
  - Summary: Added a live terminal status line showing estimated token usage during AI responses and tool execution, backed by local token counting via `@dqbd/tiktoken` and phase-based progress updates.
  - Intent: Help users track context-window pressure in real time and avoid sudden truncation/context-limit surprises in long sessions.

- 2026-02-24: Refactored `run_command` logic to `runCommandTool.ts`
  - Files: `runCommandTool.ts`, `tools.ts`
  - Summary: Moved process registry, shell resolution, and command execution logic to a dedicated module. 
  - Intent: Improve modularity and follow existing pattern established by `webSearchTool.ts`.
- 2026-02-24: Added alternate `Ctrl+X` interrupt key
  - Files: `tools.ts`, `index.ts`, `.github/copilot-instructions.md`
  - Summary: Added `installKeyInterruptListener` / `removeKeyInterruptListener` in `tools.ts`. `Ctrl+X` interrupts the AI loop; `Ctrl+C` exits the app as normal at all times. Because `setRawMode(true)` suppresses OS SIGINT, the keypress listener re-raises it via `process.kill(process.pid, 'SIGINT')` when Ctrl+C is pressed.
- 2026-02-23: Added minimal `web_search` tool (no page summarization)
  - Files: `webSearchTool.ts` (new), `tools.ts`, `index.ts`, `README.md`, `.github/copilot-instructions.md`
  - Summary: Added DuckDuckGo-backed web search with configurable max queries/results per query, readability-based text extraction, and live terminal progress logs.
  - Intent: Provide optional external context with minimal runtime overhead; keep architecture flexible for future summary-based output instead of full page text.

- 2026-02-23: Include AI error summary in conversation history
  - Files: `index.ts`, `.github/copilot-instructions.md`
  - Summary: The AI-generated error summary for failed commands is now pushed into the `messages` array as a user-role nudge.
  - Intent: Help the LLM reasoning about command failures by providing an explicit analysis of the error in its context.
- 2026-02-23: Added AI error summarization for failed commands
  - Files: `errorSummary.ts` (new), `index.ts`, `.github/copilot-instructions.md`
  - Summary: When a `run_command` tool call fails (non-zero exit code), Locopilot now calls the LLM to summarize the error and prints this summary to the terminal.
  - Intent: Help the user understand technical command failures quickly without reading through raw stderr output.
- 2026-02-23: Added YOLO mode menu option
  - Files: `index.ts`, `README.md`, `.github/copilot-instructions.md`
  - Summary: Added a startup menu to select between Standard and YOLO execution modes. The choice is persisted in `config.json`.
  - Intent: Provide a reliable way to enable YOLO mode when command-line flags are consumed or ignored by the environment/shell.
- 2026-02-23: Improved YOLO mode detection
  - Files: `index.ts`, `tools.ts`, `README.md`
  - Summary: Made YOLO mode detection more robust by adding support for `-y` shorthand and `YOLO` environment variable. Refactored `index.ts` to use a central `isYolo()` check from `tools.ts`.
  - Intent: Resolve issues where some environments/shells (like PowerShell) or `npm` versions might not pass the `--yolo` flag correctly.
- 2026-02-23: Fixed TS2451 redeclaration error
  - Files: `index.ts`
  - Summary: Removed redundant `let` keyword for `configData` variable in `main` function.
  - Intent: Fix a regression introduced in the previous update that prevented compilation.
- 2026-02-23: Added `/compact` conversation compaction feature
  - Files: `compact.ts` (new), `index.ts`, `.github/copilot-instructions.md`
  - Summary: Added a `/compact` slash command that summarises the conversation history via the LLM, replaces the live history in-place, and prints before/after stats.
  - Intent: Reduce context window consumption during long sessions without losing important context. The model is always told it is reading a summary so it does not get confused.
- 2026-02-23: Added Ctrl+C interrupt for the AI tool-call loop
  - Files: `tools.ts`, `index.ts`, `.github/copilot-instructions.md`
  - Summary: Added `requestInterrupt`, `clearInterrupt`, and `isInterruptRequested` to `tools.ts`. The SIGINT handler in `index.ts` is temporarily replaced during the tool-call loop so Ctrl+C fires `requestInterrupt()` (killing any running child process) instead of exiting the app. The loop breaks cleanly and the conversation history is left consistent.
  - Intent: Let the user escape a stuck or looping AI without losing their session or corrupting history.
- 2026-02-23: Refactored tools.ts to improve DRYness
  - Files: `tools.ts`
  - Summary: Consolidated shell resolution and configuration logic. Extracted redundant process completion and interrupt handling logic into a shared helper within the runCommand promise.
  - Intent: Improve maintainability and reduce code duplication in the tool execution layer.

- 2026-02-28: Added stdin error handling for `run_command`
  - Files: `runCommandTool.ts`, `.github/copilot-instructions.md`
  - Summary: Added explicit handling for missing stdin streams, asynchronous stdin errors, and synchronous stdin write/end failures when sending shell commands.
  - Intent: Prevent unhandled EPIPE-like failures and ensure command execution errors are surfaced as tool results instead of crashing or hanging.

- 2026-02-28: Fixed `cmd` shell configuration for stdin execution
  - Files: `runCommandTool.ts`, `.github/copilot-instructions.md`
  - Summary: Updated `getShellConfig` to use `cmd.exe` with `/D /Q` so stdin-fed scripts execute more predictably and with cleaner output on Windows.
  - Intent: Keep command execution behavior consistent across shells while preserving the exact-via-stdin design.

- 2026-02-28: Added elapsed time to command tool output
  - Files: `runCommandTool.ts`, `.github/copilot-instructions.md`
  - Summary: `buildOutput` now reports `elapsed_seconds` for both running and completed commands.
  - Intent: Give the model and user clearer runtime context when polling long-running commands or diagnosing slow executions.

(End of maintenance instructions)