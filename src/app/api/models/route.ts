// GET /api/models
// Returns aggregated list of available models from all configured providers.
import { NextResponse } from 'next/server';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Config } from '@/types/chatConfig';

import {
  buildLlmRequestContext,
  fetchLlmModelInfo,
  fetchLlmModels,
  type LlmModel,
  type LlmRequestContext,
} from '@/services/llm';
import { getNormalizedProviders } from '@/services/providerResolver';
import { resolveVisionSupport } from '@/services/visionCache';

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
            try {
              const modelInfo = await fetchLlmModelInfo(llmRequestContext, model.name);
              if (Array.isArray(modelInfo.capabilities)) {
                for (const cap of modelInfo.capabilities) {
                  caps.add(String(cap));
                }
              }
            } catch {
              // probe failure — fall through to the vision cache check below
            }
            // Merge in the vision-cache state. The vision cache is the
            // single backend source of truth for image-input support and
            // also folds in 400-driven discoveries, so it is authoritative
            // over the adapter's own probe when the two disagree (e.g. an
            // OpenAI-compatible endpoint whose provider had no
            // `capabilities` field but was found to reject image input).
            try {
              const vision = await resolveVisionSupport(
                provider.baseUrl,
                model.name,
                provider.provider
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
