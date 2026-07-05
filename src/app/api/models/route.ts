// GET /api/models
// Returns list of available models from Ollama
import { NextResponse } from 'next/server';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Config } from '../../../types/chatConfig';

import { configureLlmAdapterAndAuth, fetchLlmModelInfo, fetchLlmModels } from '../../../services/llm';

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
        { error: 'LLM base URL not configured. Please set up config first.' },
        { status: 400 }
      );
    }

    configureLlmAdapterAndAuth(config.provider, config.apiKey);

    const models = await fetchLlmModels(config.baseUrl);
    const modelsWithCapabilities = await Promise.all(
      models.map(async (model) => {
        try {
          const modelInfo = await fetchLlmModelInfo(config.baseUrl, model.name);
          return {
            ...model,
            capabilities: Array.isArray(modelInfo.capabilities)
              ? modelInfo.capabilities.map(String)
              : [],
          };
        } catch {
          return {
            ...model,
            capabilities: [],
          };
        }
      })
    );

    modelsWithCapabilities.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ models: modelsWithCapabilities });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to fetch models: ${message}` }, { status: 500 });
  }
}
