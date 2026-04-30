// GET /api/models
// Returns list of available models from Ollama
import { NextResponse } from 'next/server';
import { fetchLlmModels } from '../../../services/llm';
import { access, readFile } from 'fs/promises';
import path from 'path';
import type { Config } from '../../../slashCommands';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

async function loadConfig(): Promise<Config | null> {
    try {
        await access(CONFIG_PATH);
        const data = await readFile(CONFIG_PATH, 'utf8');
        return JSON.parse(data) as Config;
    } catch {
        return null;
    }
}

export async function GET(): Promise<NextResponse> {
    try {
        const config = await loadConfig();
        if (!config?.baseUrl) {
            return NextResponse.json(
                { error: 'Ollama base URL not configured. Please set up config first.' },
                { status: 400 },
            );
        }

        const models = await fetchLlmModels(config.baseUrl);
        return NextResponse.json({ models });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
            { error: `Failed to fetch models: ${message}` },
            { status: 500 },
        );
    }
}
