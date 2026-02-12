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

## Requirements

-   Node.js (v16+)
-   Ollama installed locally or reachable via network.
