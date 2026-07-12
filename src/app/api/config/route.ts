// GET /api/config - read current config
// PUT /api/config - update config
import { type NextRequest, NextResponse } from 'next/server';

import type { CompletionMode, Config, LlmProvider } from '../../../types/chatConfig';

import { DEFAULT_NUM_CTX, DEFAULT_OLLAMA_CHAT_TIMEOUT_MS } from '../../../constants';
import { invalidateCapCache, resolveEffectiveNumCtx } from '../../../services/capResolver';
import { loadConfig, saveConfig } from '../../../services/configManager';
import { buildLlmRequestContext } from '../../../services/llm';
import { invalidateVisionCache } from '../../../services/visionCache';

const KNOWN_TOP_KEYS: Set<string> = new Set([
  'provider',
  'apiKey',
  'baseUrl',
  'model',
  // Legacy alias accepted for backward compatibility with older
  // `config.json` files written before the `lastModel` → `model` rename.
  // New writes go out as `model`; `lastModel` is still accepted on input.
  'lastModel',
  'compactionModel',
  'numCtx',
  'chatTimeoutMs',
  'yolo',
  'thinkingEnabled',
  'promptTimestamps',
  'webSearch',
  'skills',
  'tools',
  'mcpToolSearch',
  'completionMode',
  'maxPromptLoopIterations',
]);

const KNOWN_WEB_SEARCH_KEYS: Set<string> = new Set([
  'maxQueries',
  'resultsPerQuery',
  'perPageCharLimit',
]);

const KNOWN_SKILLS_KEYS: Set<string> = new Set(['enabled', 'disabled']);

const KNOWN_TOOLS_KEYS: Set<string> = new Set(['disabledMain', 'disabledSubAgent']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

function validateConfig(
  input: unknown
): { ok: true; config: Partial<Config> } | { ok: false; error: string } {
  if (!isPlainObject(input)) {
    return { ok: false, error: 'Invalid config: body must be a JSON object' };
  }

  const unknownKeys = Object.keys(input).filter((k) => !KNOWN_TOP_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Unknown config keys: ${unknownKeys.join(', ')}` };
  }

  const out: Partial<Config> = {};

  if ('provider' in input) {
    const v = input.provider;
    if (typeof v !== 'string' || (v !== 'ollama' && v !== 'openai-compatible')) {
      return {
        ok: false,
        error: "Invalid config: 'provider' must be 'ollama' or 'openai-compatible'",
      };
    }
    out.provider = v as LlmProvider;
  }

  if ('apiKey' in input) {
    if (typeof input.apiKey !== 'string') {
      return { ok: false, error: "Invalid config: 'apiKey' must be a string" };
    }
    out.apiKey = input.apiKey;
  }

  if ('baseUrl' in input) {
    if (typeof input.baseUrl !== 'string') {
      return { ok: false, error: "Invalid config: 'baseUrl' must be a string" };
    }
    if (input.baseUrl !== '') {
      let parsed: URL;
      try {
        parsed = new URL(input.baseUrl);
      } catch {
        return { ok: false, error: "Invalid config: 'baseUrl' is not a valid URL" };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
          ok: false,
          error: "Invalid config: 'baseUrl' must use http: or https: scheme",
        };
      }
    }
    out.baseUrl = input.baseUrl;
  }

  if ('model' in input || 'lastModel' in input) {
    // `model` is the canonical key; `lastModel` is a legacy alias kept for
    // backward compatibility with older `config.json` files. If both are
    // present, `model` wins.
    const v = input.model ?? input.lastModel;
    if (typeof v !== 'string') {
      return { ok: false, error: "Invalid config: 'model' must be a string" };
    }
    out.model = v;
  }

  if ('compactionModel' in input) {
    if (typeof input.compactionModel !== 'string') {
      return { ok: false, error: "Invalid config: 'compactionModel' must be a string" };
    }
    out.compactionModel = input.compactionModel;
  }

  if ('numCtx' in input) {
    // No upper bound enforced server-side: Ollama caps the effective context
    // to the active model's `num_ctx` at runtime, and the UI surfaces that
    // as "capped by model limit". Arbitrary ceilings here only block valid
    // configurations for models with large context windows.
    if (!isFiniteInteger(input.numCtx) || input.numCtx <= 0) {
      return {
        ok: false,
        error: "Invalid config: 'numCtx' must be a positive integer",
      };
    }
    out.numCtx = input.numCtx;
  }

  if ('chatTimeoutMs' in input) {
    if (
      !isFiniteInteger(input.chatTimeoutMs) ||
      input.chatTimeoutMs <= 0 ||
      input.chatTimeoutMs > 86_400_000
    ) {
      return {
        ok: false,
        error: "Invalid config: 'chatTimeoutMs' must be a positive integer up to 86400000",
      };
    }
    out.chatTimeoutMs = input.chatTimeoutMs;
  }

  if ('yolo' in input) {
    if (typeof input.yolo !== 'boolean') {
      return { ok: false, error: "Invalid config: 'yolo' must be a boolean" };
    }
    out.yolo = input.yolo;
  }

  if ('thinkingEnabled' in input) {
    if (typeof input.thinkingEnabled !== 'boolean') {
      return { ok: false, error: "Invalid config: 'thinkingEnabled' must be a boolean" };
    }
    out.thinkingEnabled = input.thinkingEnabled;
  }

  if ('promptTimestamps' in input) {
    if (typeof input.promptTimestamps !== 'boolean') {
      return { ok: false, error: "Invalid config: 'promptTimestamps' must be a boolean" };
    }
    out.promptTimestamps = input.promptTimestamps;
  }

  if ('mcpToolSearch' in input) {
    if (typeof input.mcpToolSearch !== 'boolean') {
      return { ok: false, error: "Invalid config: 'mcpToolSearch' must be a boolean" };
    }
    out.mcpToolSearch = input.mcpToolSearch;
  }

  if ('completionMode' in input) {
    const v = input.completionMode;
    if (typeof v !== 'string' || (v !== 'normal' && v !== 'prompt-loop')) {
      return {
        ok: false,
        error: "Invalid config: 'completionMode' must be 'normal' or 'prompt-loop'",
      };
    }
    out.completionMode = v as CompletionMode;
  }

  if ('maxPromptLoopIterations' in input) {
    if (
      !isFiniteInteger(input.maxPromptLoopIterations) ||
      input.maxPromptLoopIterations < 0 ||
      input.maxPromptLoopIterations > 1000
    ) {
      return {
        ok: false,
        error:
          "Invalid config: 'maxPromptLoopIterations' must be a non-negative integer up to 1000",
      };
    }
    out.maxPromptLoopIterations = input.maxPromptLoopIterations;
  }

  if ('webSearch' in input) {
    if (!isPlainObject(input.webSearch)) {
      return { ok: false, error: "Invalid config: 'webSearch' must be an object" };
    }
    const wsUnknown = Object.keys(input.webSearch).filter((k) => !KNOWN_WEB_SEARCH_KEYS.has(k));
    if (wsUnknown.length > 0) {
      return {
        ok: false,
        error: `Unknown config keys (webSearch): ${wsUnknown.join(', ')}`,
      };
    }
    const webSearch: { maxQueries: number; resultsPerQuery: number; perPageCharLimit: number } = {
      maxQueries: 3,
      resultsPerQuery: 3,
      perPageCharLimit: 5000,
    };
    if ('maxQueries' in input.webSearch) {
      const v = input.webSearch.maxQueries;
      if (!isFiniteInteger(v) || v < 0 || v > 100) {
        return {
          ok: false,
          error: "Invalid config: 'webSearch.maxQueries' must be a non-negative integer up to 100",
        };
      }
      webSearch.maxQueries = v;
    }
    if ('resultsPerQuery' in input.webSearch) {
      const v = input.webSearch.resultsPerQuery;
      if (!isFiniteInteger(v) || v < 0 || v > 100) {
        return {
          ok: false,
          error:
            "Invalid config: 'webSearch.resultsPerQuery' must be a non-negative integer up to 100",
        };
      }
      webSearch.resultsPerQuery = v;
    }
    if ('perPageCharLimit' in input.webSearch) {
      const v = input.webSearch.perPageCharLimit;
      // No upper bound enforced server-side: downstream consumers (web fetch
      // + the chat model) will truncate at their own natural limits, and the
      // auto-compactor already manages the resulting token load.
      if (!isFiniteInteger(v) || v < 0) {
        return {
          ok: false,
          error: "Invalid config: 'webSearch.perPageCharLimit' must be a non-negative integer",
        };
      }
      webSearch.perPageCharLimit = v;
    }
    out.webSearch = webSearch;
  }

  if ('skills' in input) {
    if (!isPlainObject(input.skills)) {
      return { ok: false, error: "Invalid config: 'skills' must be an object" };
    }
    const skillsUnknown = Object.keys(input.skills).filter((k) => !KNOWN_SKILLS_KEYS.has(k));
    if (skillsUnknown.length > 0) {
      return {
        ok: false,
        error: `Unknown config keys (skills): ${skillsUnknown.join(', ')}`,
      };
    }
    const skills: { enabled: string[]; disabled: string[] } = { enabled: [], disabled: [] };
    if ('enabled' in input.skills) {
      const v = input.skills.enabled;
      if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
        return {
          ok: false,
          error: "Invalid config: 'skills.enabled' must be an array of strings",
        };
      }
      skills.enabled = v as string[];
    }
    if ('disabled' in input.skills) {
      const v = input.skills.disabled;
      if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
        return {
          ok: false,
          error: "Invalid config: 'skills.disabled' must be an array of strings",
        };
      }
      skills.disabled = v as string[];
    }
    out.skills = skills;
  }

  if ('tools' in input) {
    if (!isPlainObject(input.tools)) {
      return { ok: false, error: "Invalid config: 'tools' must be an object" };
    }
    const toolsUnknown = Object.keys(input.tools).filter((k) => !KNOWN_TOOLS_KEYS.has(k));
    if (toolsUnknown.length > 0) {
      return {
        ok: false,
        error: `Unknown config keys (tools): ${toolsUnknown.join(', ')}`,
      };
    }
    const tools: { disabledMain: string[]; disabledSubAgent: string[] } = {
      disabledMain: [],
      disabledSubAgent: [],
    };
    if ('disabledMain' in input.tools) {
      const v = input.tools.disabledMain;
      if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
        return {
          ok: false,
          error: "Invalid config: 'tools.disabledMain' must be an array of strings",
        };
      }
      tools.disabledMain = v as string[];
    }
    if ('disabledSubAgent' in input.tools) {
      const v = input.tools.disabledSubAgent;
      if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
        return {
          ok: false,
          error: "Invalid config: 'tools.disabledSubAgent' must be an array of strings",
        };
      }
      tools.disabledSubAgent = v as string[];
    }
    out.tools = tools;
  }

  return { ok: true, config: out };
}

export async function GET(): Promise<NextResponse> {
  try {
    const config = await loadConfig();
    if (!config) {
      return NextResponse.json({ config: {} });
    }
    // Resolve the model cap for the persisted default model so a
    // freshly-mounted tab can display the "capped by model limit"
    // hint without waiting for the first chat turn. The cap is
    // informational; the authoritative value comes back on every
    // chat turn's `status` event. If resolution fails (Ollama
    // unreachable, model not loaded, etc.) we silently omit the
    // field rather than 500ing the config read.
    let modelContextLimit: number | null = null;
    if (config.baseUrl && config.model) {
      try {
        const resolved = await resolveEffectiveNumCtx(
          buildLlmRequestContext({
            ...(config.provider ? { provider: config.provider } : {}),
            ...(config.apiKey ? { apiKey: config.apiKey } : {}),
            baseUrl: config.baseUrl,
          }),
          config.model,
          config.numCtx ?? DEFAULT_NUM_CTX
        );
        modelContextLimit = resolved.modelCap;
      } catch {
        // Resolver is best-effort on this read path.
      }
    }
    return NextResponse.json({ config, modelContextLimit });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to load config: ${message}` }, { status: 500 });
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const rawBody: unknown = await request.json();
    const validation = validateConfig(rawBody);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const body = validation.config;
    const currentConfig = await loadConfig();
    const base: Config = {
      baseUrl: '',
      model: '',
      compactionModel: '',
      numCtx: DEFAULT_NUM_CTX,
      chatTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
      yolo: false,
      thinkingEnabled: true,
      promptTimestamps: true,
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

    // `lastModel` is a legacy alias kept only for backward-compatible reads
    // of older `config.json` files. If we have a `model` (the canonical key),
    // drop the legacy duplicate from the persisted output so the file
    // migrates cleanly to the new key on the next save.
    if (updatedConfig.model !== undefined) {
      delete updatedConfig.lastModel;
    }

    // Invalidate the cap-resolver cache for any field that affects
    // which model we're talking to or how big a context we're asking
    // for. Without this, a stale entry from a previous model/runner
    // state would persist for up to 5 minutes after the user updates
    // the config.
    const baseUrlChanged = body.baseUrl !== undefined && body.baseUrl !== currentConfig?.baseUrl;
    const modelChanged = body.model !== undefined && body.model !== currentConfig?.model;
    if (baseUrlChanged || modelChanged) {
      // Invalidate both the old and new (baseUrl, model) pairs to
      // be safe in case the user swapped them in either order.
      invalidateCapCache(updatedConfig.baseUrl, updatedConfig.model);
      if (currentConfig?.baseUrl && currentConfig?.model) {
        invalidateCapCache(currentConfig.baseUrl, currentConfig.model);
      }
      // Mirror the same invalidation on the vision-support cache
      // (src/services/visionCache.ts). Vision support is keyed on
      // (baseUrl, modelName) for the same multi-tab reason as the
      // cap cache, and a model/baseUrl change should re-resolve
      // optimistic defaults on the next chat turn.
      invalidateVisionCache(updatedConfig.baseUrl, updatedConfig.model);
      if (currentConfig?.baseUrl && currentConfig?.model) {
        invalidateVisionCache(currentConfig.baseUrl, currentConfig.model);
      }
    } else if (
      body.numCtx !== undefined &&
      updatedConfig.numCtx !== currentConfig?.numCtx &&
      updatedConfig.baseUrl &&
      updatedConfig.model
    ) {
      // numCtx raised above the cached cap strongly suggests the
      // user reconfigured the runner / Modelfile. Re-probe.
      invalidateCapCache(updatedConfig.baseUrl, updatedConfig.model);
    }

    await saveConfig(updatedConfig);
    return NextResponse.json({ config: updatedConfig });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to save config: ${message}` }, { status: 500 });
  }
}
