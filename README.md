# Locopilot

A terminal chat client for Ollama that lets you interact with local models, persist sessions, and safely run tool-enabled commands.

## Install

1. Install dependencies:
    ```bash
    npm install
    ```
2. Make sure Ollama is installed and running.

## Run

```bash
npm start
```

Use YOLO mode to skip command approval in trusted sessions:

```bash
npm start -- --yolo
npm start -- -y
```

Or set the environment variable before launch:

PowerShell:
```powershell
$env:YOLO="true"; npm start
```

## What it does

- Connects to a local Ollama instance and lets you choose a model.
- Saves connection settings and chat history locally in `config.json` and SQLite.
- Automatically caps the live context window to a model's reported maximum when your saved setting is larger, then restores the saved preference when you switch to a model that supports it.
- Renders AI replies as terminal-friendly markdown.
- Supports safe command execution via `run_command` with optional YOLO approval.
- Provides web helpers like `web_search` and `fetch_url` for additional context, with a configurable compaction model and per-page character limit in `/settings` (`0` means unlimited). If a site needs a logged-in session, you can set `LOCOPILOT_WEB_COOKIE` to pass a `Cookie` header through the web fetch layer.
- Exports the current conversation as a markdown debug snapshot with `/dump`, including the system prompt and tool calls/results.

## Requirements

- Node.js v16+
- Ollama installed locally or reachable from the configured host/port
