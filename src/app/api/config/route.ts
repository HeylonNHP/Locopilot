// GET /api/config - read current config
// PUT /api/config - update config
import { type NextRequest, NextResponse } from 'next/server';

import type { Config } from '../../../types/chatConfig';

import { DEFAULT_OLLAMA_CHAT_TIMEOUT_MS } from '../../../constants';
import { loadConfig, saveConfig } from '../../../services/configManager';

export async function GET(): Promise<NextResponse> {
  try {
    const config = await loadConfig();
    if (!config) {
      return NextResponse.json({ config: {} });
    }
    return NextResponse.json({ config });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to load config: ${message}` }, { status: 500 });
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as Partial<Config>;
    const currentConfig = await loadConfig();
    const base: Config = {
      baseUrl: '',
      lastModel: '',
      compactionModel: '',
      numCtx: 131072,
      chatTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
      yolo: false,
      thinkingEnabled: true,
      webSearch: {
        maxQueries: 3,
        resultsPerQuery: 3,
        perPageCharLimit: 5000,
      },
      completionMode: 'normal',
      maxPromptLoopIterations: 4,
      ...currentConfig,
    };

    // Merge webSearch if provided
    const updatedWebSearch = {
      maxQueries: 3,
      resultsPerQuery: 3,
      perPageCharLimit: 5000,
      ...base.webSearch,
      ...body.webSearch,
    };

    const updatedConfig: Config = {
      ...base,
      ...body,
      webSearch: updatedWebSearch,
    };

    // Scrub empty API-key strings so they don't get persisted.
    if (updatedConfig.apiKey !== undefined && updatedConfig.apiKey.trim() === '') {
      delete updatedConfig.apiKey;
    }

    await saveConfig(updatedConfig);
    return NextResponse.json({ config: updatedConfig });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to save config: ${message}` }, { status: 500 });
  }
}
