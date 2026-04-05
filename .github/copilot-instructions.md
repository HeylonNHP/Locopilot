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

Locopilot is a terminal-based chat client for Ollama, providing a lightweight, local-first AI assistant with no cloud dependency. Key design goals:

- **Local & Private**: All inference runs through a local Ollama instance; no data leaves the machine.
- **Persistent State**: Host, port, and model selections are persisted in `config.json`. Conversations are automatically saved to a local SQLite database (`locopilot.db`).
- **Safety First**: Commands requested by the AI require explicit user approval by default.
- **YOLO Mode**: A high-trust mode that skips command confirmation for automated workflows, enabled via startup prompt, `--yolo`/`-y` flag, or `YOLO=true` environment variable.
- **Session Management**: Resume recent chats, switch between multiple active sessions (`/sessions`), or delete old ones (`/delete`).
- **Slash Commands**: Specialized commands for utility tasks:
    - `/model`: Refresh and switch LLM models mid-conversation.
    - `/settings`: Change App and Session settings (replaces initial startup prompts).
    - `/compact`: Force conversation summarization to recover context.
    - `/sessions`: Switch between multiple persistent chat histories.
    - `/delete`: Remove a session from the local database.
    - `/nudge`: Manually inject a tool-use reminder if the AI is hesitant.
    - `/exit` / `/help`: Application control and documentation.

## Tool-calling / Command-execution

Feature summary:
- **`run_command`**: Request shell commands. Uses a process registry for tracking and `Ctrl+X` for interruption.
- **Process Registry**: Long-running commands are tracked by ID, allowing the AI to poll for output using a `check_process_output` tool if a command exceeds the initial 30s timeout.
- **Shell Precision**: On Windows, PowerShell is preferred. Commands are fed via `stdin` (e.g., `powershell -Command -`) to avoid quoting/tokenization issues across different shells. POSIX shell requests on Windows are automatically remapped to PowerShell with a warning.
- **Failure Analysis**: Non-zero exit codes trigger an AI-powered error summary ([errorSummary.ts](errorSummary.ts)) that distills technical `stderr` into a brief fix suggestion, which is then fed back into the history as a user-role nudge.
- **Interruption**: `Ctrl+X` interrupts the tool-call loop or kills the running process without exiting the application. `Ctrl+C` remains a global exit signal.

## Markdown rendering

Feature summary:
- **`streamAIResponse`**: Provides real-time "typing" effect chunk-by-chunk. Intentionally skips markdown formatting during streaming for performance and accuracy.
- **`printAIResponse`**: Renders full markdown (tables, code blocks, formatting) using `marked` and `marked-terminal` once the stream is complete or for static messages.
- **Viewport Recovery**: Uses a viewport-aware strategy to replace raw streamed text with formatted markdown if the response fits on screen; otherwise, appends the formatted version after a separator.
- **Normalization**: Automatically fixes accidental global indentation in model responses to prevent formatting breakages (like misidentified code blocks).

## Session & Token Management

Feature summary:
- **SQLite Storage**: Uses `better-sqlite3` in WAL mode for reliable, concurrent message persistence. 
- **Live Token Meter**: Displays a real-time status line ([statusLine.ts](statusLine.ts)) with a 10-frame spinner (`⠋⠙⠹...`), current phase, model, context usage (`used / limit`), and source tag (`estimated` vs `ollama`).
- **Authoritative Stats**: Reconciles estimated local token counts (`tiktoken`) with authoritative metrics from Ollama (`prompt_eval_count`, `eval_count`) at the end of each turn.
- **Token Calculation**: Estimated counts [tokenizer.ts](tokenizer.ts) add 4 tokens per message plus role, content, and tool call overhead to match OpenAI-style counting as a robust local approximation.
- **Conversation Compaction**: The `/compact` command [compact.ts](compact.ts) uses a high-context LLM pass to summarize everything (decisions, code, paths) into the third person, injecting a `[This conversation history has been compacted...]` preamble.
- **Auto-Compact**: When context usage reaches 92%, compaction is triggered automatically at the start of each tool-call loop iteration (covers both between-tool-call growth and end-of-turn growth). A yellow `⚡ Context at N% — auto-compacting...` line is printed. If compaction fails or is a no-op, a warning is shown but the loop continues uninterrupted.

## Web search & Fetch tools

Feature summary:
- **`web_search`**: Multi-query DuckDuckGo search with automatic derivation of search intent and pagination support.
- **`fetch_url`**: Direct page retrieval for following links or deep-diving into specific documentation.
- **`fetch_image`**: Fetches an image from a URL or local file path and attaches it as base64 to the conversation message. Vision-only; only useful with models that have image understanding (e.g. llava, llama3.2-vision). Supports JPEG, PNG, GIF, WebP, and BMP up to 10 MB. The base64 is stored in the `images` field of the tool result message and is persisted to SQLite alongside other message fields.
- **Smart Extraction**: Uses `@mozilla/readability` and `cheerio` to extract clean text from HTML, ignoring navbars and boilerplate.
- **Configurable limits**: Timeouts and character limits are enforced to keep history manageable.

## LLM maintenance instruction (always keep up to date)

- PURPOSE: Document developer intent, UX constraints, and tool behaviors for contributors and automated agents.

- MANDATE:
  - Update this file whenever code, configuration, or tool behaviors change.
  - Keep entries concise: target file, summary of change, and rationale.
  - When adding tools, document their security profile and confirmation UX.
  - Ensure all new features align with the "Local, Private, Safe" philosophy.

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
- [x] **Preserve message history on error/interrupt**:
    - Files: `index.ts`
    - Summary: Removed the code that rolled back `messages.length` to `historyLengthBeforeTurn` when an AI turn was interrupted or failed due to an Ollama API error.
    - Intent: Ensure that when an error occurs mid-turn (e.g. after several successful tool calls), the previous context and already-executed tool output remain in the history. This allows the user to "try again" with the model seeing exactly where it left off, rather than losing the entire turn's progress.

## Change History

- 2026-03-12: Added `fetch_image` tool for vision models
  - Files: `tools/fetchImageTool.ts` (new), `tools.ts`, `ollamaApi.ts`, `history.ts`, `index.ts`, `package.json`
  - Summary: New tool that fetches an image from an HTTP/HTTPS URL or an absolute local file path, encodes it as base64, and attaches it to the tool result message via the `images` field on `ChatMessage`. `handleToolCall` return type changed from `string` to `ToolCallResult { content, images? }`. `history.ts` gained an `images` column on the messages table (migration-safe via `addColumnIfMissing`) so image data survives session reload. Supports JPEG, PNG, GIF, WebP, BMP, etc.; 10 MB limit. Image format is validated using the `image-type` library (magic bytes) to reject non-image resources (like HTML error pages masquerading as images) before processing.
  - Intent: Enable vision-capable models to inspect images safely and persistently.

- 2026-03-09: Fixed post-stream re-render using viewport-aware strategy
  - Files: [aiResponseRenderer.ts](aiResponseRenderer.ts)
  - Summary: Replaced the broken DSR/absolute-positioning attempt with a reliable short/long split: if `streamedLines < termHeight` the cursor steps back with `\x1B[{N}A` (safe because content never scrolled the viewport) and the raw text is replaced with formatted markdown; if content scrolled the terminal, the raw stream is left in scrollback and the formatted version is appended below a dim separator — avoiding the half-erase artefact caused by `\x1B[{N}A` being capped at the top of the visible screen. Also removed the non-functional `queryCursorRow` DSR helper.
  - Intent: Ensure formatted markdown is always visible and never partially overwrites raw streamed output. Simple, reliable, no stdin dependency.

- 2026-03-09: Corrected bold/italic/code rendering fix in list items
  - Files: [markdownRenderer.ts](markdownRenderer.ts)
  - Summary: Replaced the earlier regex-based `listitem` monkey-patch with a targeted `text` renderer patch. Root cause: `marked-terminal`'s `text` renderer discards inline token children (`token.tokens`) and returns the raw markdown string, so `strong`/`em`/`codespan` renderers are never invoked for text inside list items. The fix overrides `renderer.text` to delegate to `renderer.parser.parseInline(token.tokens)` when token children are present, letting the real renderers run. Also primes the renderer with an empty `marked.parse('', { renderer })` call so `renderer.parser` is initialized before the patch runs.
  - Intent: Fix the issue correctly at the source (the `text` renderer, not `listitem`), removing fragile regex substitution and correctly routing through the configured Chalk styles.

- 2026-03-04: Implemented DuckDuckGo pagination for `web_search`
  - Files: `tools/webSearchTool.ts`, `.github/copilot-instructions.md`
  - Summary: `fetchSearchResults` now fetches additional pages via POST (using the `vqd` token and `s`/`dc` offset) until `resultsPerQuery` is satisfied or no more results are available. Result parsing was extracted into a `parseResultsFromPage` helper. Duplicate URLs across pages are deduplicated.
  - Intent: Honour the user-configured `resultsPerQuery` value (e.g. 15) rather than being silently capped at ~10 by the default DDG HTML page size.

- 2026-03-03: Switched token reporting to Ollama-authoritative final stats
  - Files: `ollamaApi.ts`, `aiResponseRenderer.ts`, `index.ts`, `statusLine.ts`, `compact.ts`, `history.ts`, `slashCommands.ts`, `README.md`, `.github/copilot-instructions.md`
  - Summary: Added support for `prompt_eval_count` / `eval_count` in chat responses, propagated final turn stats through the streaming renderer, reconciled the live token meter to authoritative values after each response, updated `/compact` token math to use Ollama-measured counts, and persisted latest turn token stats in session records.
  - Intent: Keep the responsive live meter UX while using model-native token accounting for final numbers and compaction decisions.

- 2026-03-02: Hardened markdown normalization heuristic for mixed indentation
  - Files: `markdownRenderer.ts`, `.github/copilot-instructions.md`
  - Summary: Updated normalization to count indentation in columns (spaces + tabs), strip indentation safely, and trigger dedent based on indented markdown-structure lines instead of all non-empty lines.
  - Intent: Ensure a single unindented line does not disable normalization and fix cases where tab-indented markdown was still rendered as an indented code block.

- 2026-03-02: Added markdown indentation normalization before terminal rendering
  - Files: `markdownRenderer.ts`, `.github/copilot-instructions.md`
  - Summary: Added a normalization pass that detects accidental global indentation in model responses and removes shared left padding (typically 4 spaces) before passing text to `marked`. The heuristic only applies when multiple markdown-structure lines are detected and avoids mutating fenced code blocks.
  - Intent: Prevent headings/lists/links from being misinterpreted as indented code blocks while preserving legitimate code-fence formatting.

- 2026-03-02: Moved to true streaming output in `aiResponseRenderer.ts`
  - Files: `aiResponseRenderer.ts`, `index.ts`, `.github/copilot-instructions.md`
  - Summary: `streamAIResponse` now owns the full turn lifecycle — it creates the `AbortController` and `sendOllamaChatStream` call internally. The caller only passes `(baseUrl, params, { onStatusUpdate })`. Text chunks are written to the terminal immediately as each NDJSON chunk arrives (no more buffering), giving a real-time "model is typing" effect. The `AI >` label is printed on the first chunk, and an inline `(interrupted)` suffix is appended if the stream is cut short. `printAIResponse` is kept for pre-built/fallback strings and still uses markdown rendering.
  - Intent: Eliminate the blank-wait before any output appears; make the call-site in `index.ts` as simple as possible by hiding all stream/abort plumbing inside the renderer where it belongs. Markdown rendering during live streaming is intentionally omitted (same trade-off as the Ollama CLI) since `marked` requires the full text for tables and code blocks.

- 2026-03-02: Centralised AI response rendering into `aiResponseRenderer.ts`
  - Files: `aiResponseRenderer.ts` (new), `index.ts`, `.github/copilot-instructions.md`
  - Summary: Extracted all AI response printing logic from `index.ts` into two focused exports: `printAIResponse(content, opts?)` which clears the status line and renders markdown with the correct label, and `streamAIResponse(stream, opts)` which consumes an Ollama chat stream, manages the interrupt handler lifecycle, updates the live status, and delegates rendering to `printAIResponse`. Removed `sanitize`, `registerInterruptHandler`, `unregisterInterruptHandler` from `index.ts` imports, and removed the `renderMarkdown` import.
  - Intent: Eliminate repeated and fragmented stream/render code in `index.ts`, making it trivial to add future response sites (e.g. inline tool result summaries) by calling a single well-tested function. `printAIResponse` can also be called outside a streaming context (e.g. fallback messages) without duplicating label/markdown/newline boilerplate.

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
- 2026-03-24: Moved startup configuration prompts to a /settings menu
  - Files: `index.ts`, `slashCommands.ts`, `constants.ts`
  - Summary: Removed repetitive prompts for Execution Mode, max queries, and context length on startup. Added a `/settings` slash command to configure these mid-session.
  - Intent: Streamline app startup and improve UX by persisting previous configurations and relying on fallbacks.

- 2026-03-24: Replaced Inquirer `search` with standard `readline` for improved multi-line input
  - Files: `index.ts`
  - Summary: Replaced `@inquirer/prompts/search` component with a custom `getMultilineInput` node readline interface. It gracefully delays `30ms` upon encountering a newline to wait for potentially fast-arriving lines (pasting multi-line text) and supports `"""` syntax or trailing `\` to compose lines manually.
  - Intent: Allow the user to intuitively paste terminal outputs or Python blocks into the CLI without accidental early submissions caused by embedded `\r\n`. Autocomplete for `/slash` commands was retained via the native `readline` completer (`<Tab>`).

- 2026-04-04: Improved `/compact` with output budgeting and sliding-window preservation
  - Files: `compact.ts`, `.github/copilot-instructions.md`
  - Summary: Added three compaction upgrades: (1) explicit `num_predict` overrides for summarization/distillation to avoid backend defaults truncating around ~2k tokens, (2) dynamic budget signaling in the summarizer system prompt with target/min/max token guidance derived from `numCtx`, and (3) context-scaled sliding-window preservation of recent messages so only older history is summarized while newer turns remain verbatim.
  - Intent: Retain materially more useful context on large windows (e.g. 128k) while still reducing history size and preventing over-aggressive summarization.

- 2026-04-04: Tuned `/compact` to avoid no-op growth on short splits
  - Files: `compact.ts`, `.github/copilot-instructions.md`
  - Summary: Reduced preserved-recent aggressiveness (lower ratio/floor, capped preserved message count by minimum summary share) and added source-aware summary budget capping so summary targets scale down when only a small slice is being summarized.
  - Intent: Reduce failures where compaction preserved too much recent history and summary output grew enough to exceed original token count.

- 2026-04-04: Added automatic context compaction
  - Files: `index.ts`, `.github/copilot-instructions.md`
  - Summary: Added `autoCompactIfNeeded()` in `index.ts` that triggers compaction when estimated token usage reaches `AUTO_COMPACT_THRESHOLD_PCT` (92%). The function is called at the top of every tool-call loop iteration, covering both mid-turn (between tool calls) and end-of-turn growth. A yellow `⚡` status line informs the user; errors are caught and shown as non-fatal warnings so the loop always continues.
  - Intent: Prevent context-overflow hard stops by proactively compacting during long agentic runs without requiring user intervention.

- 2026-04-05: Integrated Ollama authoritative tokens for auto-compaction
  - Files: `index.ts`, `.github/copilot-instructions.md`
  - Summary: `getCurrentTokenEstimate()` now anchors the total context estimate to the last exact token count provided by Ollama (`lastAuthoritativeTokens`) and only uses the local Tiktoken approximation for the delta of added messages since that point.
  - Intent: Fix a bug where the local tokenizer heavily underestimated true token cost, causing the application to warn about 96% context usage but incorrectly failing to automatically compact because its internal calculation stayed under 92%.
