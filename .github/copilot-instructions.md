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

## Conversation compaction (/compact)

Feature summary:
- The user can type `/compact` at any time during a chat session to shrink the conversation history.
- The currently selected model is asked to summarise the full history down to its most important parts (decisions, facts, commands, results, file paths, code). Conversational filler is discarded.
- A preamble is prepended to the summary so the model knows it is reading a condensed record rather than a live transcript.
- The summarised history replaces the live message array in-place; the original system prompt is always preserved verbatim.
- After compaction, stats are printed: old vs new message count, old vs new character count, and the percentage reduction.
- The new history is always expected to be smaller than the old one; if the model returns an empty summary, compaction is aborted with an error.

Implementation notes:
- All compaction logic lives in `compact.ts` (`compactHistory`, `printCompactStats`).
- `index.ts` handles the `/compact` slash command, calls `compactHistory`, and splices the result back into the live `messages` array.
- No tools are passed during the summarisation call (tools are not needed for this task).

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

## Change History

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

(End of maintenance instructions)