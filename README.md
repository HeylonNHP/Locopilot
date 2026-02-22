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

## Features

-   **Ollama Configuration**: On its first run, the tool will prompt for the Ollama host and port, which it saves to `config.json`.
-   **Model Selection**: Automatically fetches available models from your Ollama instance and lets you choose one.
-   **Chat**: Simple chat interface in the terminal. Type `exit` to quit.
 -   **Tool Calling (Terminal Commands)**: LLMs that support native tool/function calling can request to run terminal commands on the host via Ollama. When an LLM requests a command:
         - The user is always prompted to approve the command before it runs.
         - Short commands that finish within a timeout return their full stdout/stderr.
         - Long-running commands return partial output plus a `process_id`; the LLM (or user) can poll progress using `check_process_output(process_id)`.
         - All requests and results are shown in the terminal so you can verify actions.

### Tool Calling: safety and usage

- Every `run_command` request requires explicit user confirmation. If you decline, the command will not run and the LLM receives a safe rejection message.
- For long-running or sensitive commands, the LLM is encouraged to use `check_process_output` to poll progress instead of running blind commands.
- Tools available:
    - `run_command(command, shell?, timeout_seconds?)` — run a shell command (`bash`/`powershell`/`cmd` etc.).
    - `check_process_output(process_id)` — poll the current stdout/stderr and completion status for a previously started command.

Example interaction:

```text
You > list the contents of my home directory
AI  > (decides to call tool) run_command(command: "ls -la ~")
User is prompted: Allow this command to run? (y/N)
If approved: command runs and output is returned to the AI and displayed to the user.
```

Note: tool-calling is an advanced feature. Always review requested commands before approving them.

## Requirements

-   Node.js (v16+)
-   Ollama installed locally or reachable via network.
