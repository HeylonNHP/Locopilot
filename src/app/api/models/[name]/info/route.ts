// GET /api/models/[name]/info
// Returns model info and context limit for a specific model
import { NextRequest, NextResponse } from 'next/server';
import { fetchLlmModelInfo, getLlmModelContextLimit } from '../../../../../services/llm';
import type { LlmModelInfo } from '../../../../../services/llm';
import { access, readFile } from 'fs/promises';
import path from 'path';
import type { Config } from '../../../../../types/chatConfig';

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

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
    try {
        const { name } = await params;

        const config = await loadConfig();
        if (!config?.baseUrl) {
            return NextResponse.json(
                { error: 'Ollama base URL not configured. Please set up config first.' },
                { status: 400 },
            );
        }

        const modelInfo: LlmModelInfo = await fetchLlmModelInfo(config.baseUrl, name);
        const contextLimit = getLlmModelContextLimit(modelInfo);

        return NextResponse.json({ contextLimit, modelInfo });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
            { error: `Failed to fetch model info: ${message}` },
            { status: 500 },
        );
    }
}
