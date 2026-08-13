// GET /api/models
// Returns aggregated list of available models from all configured providers.
import { NextResponse } from 'next/server';
import { access, readFile } from 'node:fs/promises';

import type { Config } from '@/types/chatConfig';

import { openaiCompatibleAdapter } from '@/services/adapters/openaiCompatibleAdapter';
import {
  buildLlmRequestContext,
  fetchLlmModelInfo,
  fetchLlmModels,
  getLlmModelVisionSupportAsync,
  type LlmModel,
  type LlmRequestContext,
} from '@/services/llm';
import { CONFIG_PATH } from '@/services/paths';
import { getNormalizedProviders } from '@/services/providerResolver';

async function loadConfig(): Promise<Config | null> {
  try {
    await access(CONFIG_PATH);
    const data = await readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(data) as Config;
  } catch {
    return null;
  }
}

interface ProviderModel extends LlmModel {
  providerId: string;
  providerName: string;
  provider: 'ollama' | 'openai-compatible';
}

export async function GET(): Promise<NextResponse> {
  try {
    const config = await loadConfig();
    const providers = getNormalizedProviders(config);
    if (providers.length === 0) {
      return NextResponse.json(
        { error: 'LLM base URL not configured. Please set up config first.' },
        { status: 400 }
      );
    }

    const allModels: ProviderModel[] = [];
    const errors: string[] = [];

    for (const provider of providers) {
      const llmRequestContext: LlmRequestContext = buildLlmRequestContext({
        ...(provider.provider ? { provider: provider.provider } : {}),
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
        baseUrl: provider.baseUrl,
      });

      try {
        const models = await fetchLlmModels(llmRequestContext);
        const modelsWithCapabilities = await Promise.all(
          models.map(async (model) => {
            // Start with the adapter's own capabilities (Ollama's /api/show
            // populates this; OpenAI-compatible leaves it empty).
            const caps = new Set<string>();
            let modelInfo;
            try {
              // OpenAI-compatible has no per-model info endpoint, so the
              // adapter looks up the model in the list already fetched above.
              // Ollama uses its authoritative /api/show capabilities probe.
              modelInfo =
                provider.provider === 'openai-compatible'
                  ? await openaiCompatibleAdapter.fetchModelInfo(
                      llmRequestContext,
                      model.name,
                      models
                    )
                  : await fetchLlmModelInfo(llmRequestContext, model.name);
              if (Array.isArray(modelInfo.capabilities)) {
                for (const cap of modelInfo.capabilities) {
                  caps.add(String(cap));
                }
              }
            } catch {
              // probe failure — fall through to the cache/default resolution
            }

            // Resolve vision through the same cache-aware facade used by chat.
            // Passing successful Ollama model info is important: it lets a
            // trusted /api/show probe refresh a prior weak default entry.
            try {
              const vision = await getLlmModelVisionSupportAsync(
                provider.baseUrl,
                model.name,
                provider.provider,
                modelInfo
              );
              if (vision.state === 'unsupported') {
                caps.delete('vision');
                caps.delete('multimodal');
                caps.delete('image');
              } else if (
                vision.state === 'supported' &&
                !caps.has('vision') &&
                !caps.has('multimodal') &&
                !caps.has('image')
              ) {
                // Optimistic default for openai-compatible: surface the
                // assumption as a Vision badge so the user sees the
                // predicted capability in the model selector without
                // waiting for a 400. `getCapabilityBadges` already
                // maps `'multimodal'` → `'Vision'`.
                caps.add('multimodal');
              }
            } catch {
              // vision-cache failure is non-fatal
            }
            return {
              ...model,
              providerId: provider.id,
              providerName: provider.name,
              provider: provider.provider,
              capabilities: [...caps],
            };
          })
        );
        allModels.push(...modelsWithCapabilities);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`${provider.name}: ${message}`);
      }
    }

    allModels.sort((a, b) => {
      const providerCompare = a.providerName.localeCompare(b.providerName);
      if (providerCompare !== 0) return providerCompare;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ models: allModels, errors: errors.length > 0 ? errors : undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to fetch models: ${message}` }, { status: 500 });
  }
}
