# Locopilot

A simple CLI tool to chat with a Large Language Model via Ollama.

## Setup

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Ollama**:
    Ensure you have [Ollama](https://ollama.com/) installed and running.

3.  **Run the Tool**:
    ```bash
    npm start
    ```
    To run in **YOLO mode** (automatic command execution without confirmation):
    ```bash
    # Using the startup prompt
    npm start
    # Then select "YOLO" from the menu

    # Using the full flag (skips the prompt)
    npm start -- --yolo

    # Using the shorthand (skips the prompt)
    npm start -- -y

    # Using an environment variable (skips the prompt)
    # On Windows (PowerShell): $env:YOLO="true"; npm start
    # On Linux/macOS: YOLO=true npm start
    ```

## Configuration

- **`config.json`**: This file is created automatically on the first run and is ignored by Git. It stores your Ollama connection details, the last model used, the default context length (`num_ctx`), your YOLO mode preference, and web-search defaults.
- **Context Length (`num_ctx`)**: The default context length is 65536. This setting is stored in your `config.json` and can be manually edited if needed.
- **Web Search Defaults**: You can configure max queries per web-search call and results per query at startup. These are persisted in `config.json`.

## Features

-   **Ollama Configuration**: On its first run, the tool will prompt for the Ollama host and port, which it saves to `config.json`.
-   **Model Selection**: Automatically fetches available models from your Ollama instance and lets you choose one.
-   **Execution Mode**: At startup, you can choose between **Standard** mode (where you must approve every command) and **YOLO** mode (where commands run automatically).
-   **Chat**: Simple chat interface in the terminal. Type `exit` to quit.
-   **Streaming AI Output**: Assistant text is rendered incrementally in the terminal as Ollama streams it, so long responses from slower models are visible while they are still generating.
-   **Live Token Meter**: While the AI is responding or running tools, a live status line shows estimated context usage (`tokens_used / num_ctx`) so you can see how close you are to the context limit.
 -   **Tool Calling (Terminal Commands)**: LLMs that support native tool/function calling can request to run terminal commands on the host via Ollama. When an LLM requests a command:
         - By default, the user is always prompted to approve the command before it runs.
         - In **YOLO mode**, commands run automatically with implicit consent.
         - Short commands that finish within a timeout return their full stdout/stderr.
         - Long-running commands return partial output plus a `process_id`; the LLM (or user) can poll progress using `check_process_output(process_id)`.
         - All requests and results are shown in the terminal so you can verify actions.
    -   **Tool Calling (Web Search)**: LLMs can call `web_search` to fetch external context from DuckDuckGo results.
        - The tool can derive search queries from a `prompt` or use explicit `queries` supplied by the model.
        - Per query, it fetches top results, downloads each page, and extracts readable text using `@mozilla/readability` with a `cheerio` fallback.
        - It returns extracted text snippets (not LLM-generated summaries) to reduce latency and avoid extra context overhead.
        - Progress is printed in the terminal while web search is running.

### Tool Calling: safety and usage

- By default, every `run_command` request requires explicit user confirmation. If you decline, the command will not run and the LLM receives a safe rejection message.
- **YOLO mode**: if you enable YOLO mode (via startup prompt or flags), the confirmation prompt is skipped. Use this mode only for trusted models and safe environments.
- For long-running or sensitive commands, the LLM is encouraged to use `check_process_output` to poll progress instead of running blind commands.
- Tools available:
    - `run_command(command, shell?, timeout_seconds?)` — run a shell command (`bash`/`powershell`/`cmd` etc.).
    - `check_process_output(process_id)` — poll the current stdout/stderr and completion status for a previously started command.
    - `web_search(prompt?, queries?, max_queries?, results_per_query?)` — search DuckDuckGo and return extracted page text from fetched results.

Example interaction:

```text
You > list the contents of my home directory
AI  > (decides to call tool) run_command(command: "ls -la ~")
User is prompted: Allow this command to run? (y/N)
If approved: command runs and output is returned to the AI and displayed to the user.
```

Note: tool-calling is an advanced feature. Always review requested commands before approving them.

### Web search notes

- `web_search` currently returns extracted page text directly, without AI summarization.
- This behavior keeps runtime lighter for local models and helps conserve context budget.
- The implementation is modular (`webSearchTool.ts`) so future updates can swap full-page text for summaries if desired.

## Requirements

-   Node.js (v16+)
-   Ollama installed locally or reachable via network.
