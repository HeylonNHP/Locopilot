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

### Server host and port

By default the server listens on **all interfaces** (`0.0.0.0`, so it is
reachable from your LAN) — this matches how `npm run dev` and `npm start` have
always behaved. To pin the port, set `PORT` in `.env` (default `3000`; if it is
busy the next free port is used automatically).

To restrict the bind address — for example on a shared or managed machine — set
`LOCOPILOT_HOST` in `.env`:

```bash
LOCOPILOT_HOST=127.0.0.1   # loopback only (IPv4)
LOCOPILOT_HOST=::1         # loopback only (IPv6)
```

Leaving `LOCOPILOT_HOST` unset (or empty) keeps the unrestricted default. IPv6
addresses must be unbracketed.

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

### Authentication (optional)

Local Ollama needs no authentication. For a remote or proxied Ollama
endpoint that requires a Bearer token, set `apiKey` on that provider in
`config.json`:

```json
{
  "providers": [
    {
      "id": "my-remote-ollama",
      "name": "Remote Ollama",
      "provider": "ollama",
      "baseUrl": "https://ollama.example.com",
      "apiKey": "your-secret-token",
      "model": "llama3.2"
    }
  ]
}
```

The key is sent as an `Authorization: Bearer <key>` header on every
request to that provider. Providers without an `apiKey` field behave
exactly as before.
