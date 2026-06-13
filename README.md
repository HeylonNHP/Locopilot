# Locopilot

A terminal chat client for Ollama that lets you interact with local models, persist sessions, and safely run tool-enabled commands.

## Quick start

1. Install dependencies.
   ```bash
   npm install
   ```
2. Make sure Ollama is installed, running, and has at least one model available.
3. Start Locopilot.
   ```bash
   npm start
   ```
4. Follow the prompts to confirm the Ollama host and port, pick a model, and open a session.

Locopilot stores its local state in `config.json` and `locopilot.db` in the current working directory, so sessions stay tied to the folder you launch it from.

If you want to skip command approval in a trusted environment, use YOLO mode:

```bash
npm start -- --yolo
npm start -- -y
YOLO=true npm start
```

PowerShell:

```powershell
$env:YOLO="true"; npm start
```

## What it does

| Feature                    | What you get                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Local Ollama chat          | Streams responses from a local Ollama instance and renders them as terminal-friendly markdown.               |
| Persistent sessions        | Saves chats and settings locally so you can resume, switch, or delete sessions later.                        |
| Safe tool execution        | Supports `run_command` with approval by default, plus YOLO mode for trusted automation.                      |
| Developer-focused commands | Includes `/settings`, `/model`, `/compact`, `/dump`, `/sessions`, `/delete`, `/nudge`, `/help`, and `/exit`. |
| Web and file tools         | Offers `web_search`, `fetch_url`, `fetch_image`, `read_file`, and `write_file` for agentic workflows.        |
| Context management         | Compacts long conversations and clamps runtime context to the selected model's reported limit.               |

## Requirements

- Node.js v16+
- Ollama installed locally or reachable from the configured host/port
