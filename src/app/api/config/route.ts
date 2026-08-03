// GET /api/config - read current config
// PUT /api/config - update config
import { type NextRequest, NextResponse } from 'next/server';

import type { CompletionMode, Config, LlmProvider, ProviderConfig } from '@/types/chatConfig';

import { DEFAULT_NUM_CTX, DEFAULT_OLLAMA_CHAT_TIMEOUT_MS } from '@/constants';
import { invalidateCapCache, resolveEffectiveNumCtx } from '@/services/capResolver';
import {
  DEFAULT_ADAPTER_RETRY,
  DEFAULT_MAX_PROMPT_LOOP_ITERATIONS,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_RETRYABLE_STATUSES,
  DEFAULT_WEB_SEARCH_SETTINGS,
  MAX_RETRY_BASE_DELAY_MS,
  MAX_RETRY_MAX_DELAY_MS,
  PROVIDER_OLLAMA,
  PROVIDER_OPENAI_COMPATIBLE,
  RETRY_MAX_ATTEMPTS_LIMIT,
  RETRY_MAX_ATTEMPTS_MIN,
} from '@/services/configDefaults';
import { loadConfig, saveConfig } from '@/services/configManager';
import { buildLlmRequestContext } from '@/services/llm';
import { getNormalizedProviders, resolveProvider } from '@/services/providerResolver';
import { invalidateVisionCache } from '@/services/visionCache';

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
  'reasoningEffort',
  'promptTimestamps',
  'webSearch',
  'skills',
  'tools',
  'providers',
  'activeProviderId',
  'mcpToolSearch',
  'completionMode',
  'maxPromptLoopIterations',
  'retry',
]);

const KNOWN_WEB_SEARCH_KEYS: Set<string> = new Set([
  'maxQueries',
  'resultsPerQuery',
  'perPageCharLimit',
]);

const KNOWN_SKILLS_KEYS: Set<string> = new Set(['enabled', 'disabled']);

const KNOWN_TOOLS_KEYS: Set<string> = new Set(['disabledMain', 'disabledSubAgent']);

const KNOWN_RETRY_KEYS: Set<string> = new Set([
  'enabled',
  'maxAttempts',
  'baseDelayMs',
  'maxDelayMs',
  'retryableStatuses',
]);

const DEFAULT_RETRY_CONFIG: NonNullable<Config['retry']> = DEFAULT_ADAPTER_RETRY;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateProvider(value: unknown, index: number): ProviderConfig | string {
  if (!isPlainObject(value)) {
    return `providers[${index}] must be an object`;
  }
  if (!isNonEmptyString(value.id)) {
    return `providers[${index}].id must be a non-empty string`;
  }
  if (!isNonEmptyString(value.name)) {
    return `providers[${index}].name must be a non-empty string`;
  }
  if (
    typeof value.provider !== 'string' ||
    (value.provider !== PROVIDER_OLLAMA && value.provider !== PROVIDER_OPENAI_COMPATIBLE)
  ) {
    return `providers[${index}].provider must be '${PROVIDER_OLLAMA}' or '${PROVIDER_OPENAI_COMPATIBLE}'`;
  }
  if (typeof value.baseUrl !== 'string' || value.baseUrl.trim().length === 0) {
    return `providers[${index}].baseUrl must be a non-empty string`;
  }
  let parsed: URL;
  try {
    parsed = new URL(value.baseUrl);
  } catch {
    return `providers[${index}].baseUrl is not a valid URL`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `providers[${index}].baseUrl must use http: or https: scheme`;
  }
  const out: ProviderConfig = {
    id: value.id.trim(),
    name: value.name.trim(),
    provider: value.provider as LlmProvider,
    baseUrl: value.baseUrl.trim(),
  };
  if ('apiKey' in value) {
    if (typeof value.apiKey !== 'string') {
      return `providers[${index}].apiKey must be a string`;
    }
    if (value.apiKey.trim().length > 0) {
      out.apiKey = value.apiKey.trim();
    }
  }
  if ('model' in value) {
    if (typeof value.model !== 'string') {
      return `providers[${index}].model must be a string`;
    }
    if (value.model.trim().length > 0) {
      out.model = value.model.trim();
    }
  }
  if ('numCtx' in value) {
    if (!isFiniteInteger(value.numCtx) || value.numCtx <= 0) {
      return `providers[${index}].numCtx must be a positive integer`;
    }
    out.numCtx = value.numCtx;
  }
  return out;
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

  if ('providers' in input) {
    if (!Array.isArray(input.providers)) {
      return { ok: false, error: "Invalid config: 'providers' must be an array" };
    }
    const providers: ProviderConfig[] = [];
    for (const [index, item] of input.providers.entries()) {
      const validated = validateProvider(item, index);
      if (typeof validated === 'string') {
        return { ok: false, error: `Invalid config: ${validated}` };
      }
      providers.push(validated);
    }
    out.providers = providers;
  }

  if ('activeProviderId' in input) {
    if (input.activeProviderId !== null && typeof input.activeProviderId !== 'string') {
      return { ok: false, error: "Invalid config: 'activeProviderId' must be a string or null" };
    }
    if (typeof input.activeProviderId === 'string' && input.activeProviderId.trim().length > 0) {
      out.activeProviderId = input.activeProviderId.trim();
    }
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
      input.chatTimeoutMs > MAX_RETRY_BASE_DELAY_MS * 60 * 24
    ) {
      return {
        ok: false,
        error: `Invalid config: 'chatTimeoutMs' must be a positive integer up to ${MAX_RETRY_BASE_DELAY_MS * 60 * 24}`,
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

  if ('reasoningEffort' in input) {
    const v = input.reasoningEffort;
    const allowed: ReadonlyArray<Config['reasoningEffort']> = [
      'off',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ];
    if (typeof v !== 'string' || !allowed.includes(v as Config['reasoningEffort'])) {
      return {
        ok: false,
        error:
          "Invalid config: 'reasoningEffort' must be one of: off, none, minimal, low, medium, high, xhigh",
      };
    }
    out.reasoningEffort = v as NonNullable<Config['reasoningEffort']>;
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
      maxQueries: DEFAULT_WEB_SEARCH_SETTINGS.maxQueries,
      resultsPerQuery: DEFAULT_WEB_SEARCH_SETTINGS.resultsPerQuery,
      perPageCharLimit: DEFAULT_WEB_SEARCH_SETTINGS.perPageCharLimit,
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

  if ('retry' in input) {
    if (!isPlainObject(input.retry)) {
      return { ok: false, error: "Invalid config: 'retry' must be an object" };
    }
    const retryUnknown = Object.keys(input.retry).filter((k) => !KNOWN_RETRY_KEYS.has(k));
    if (retryUnknown.length > 0) {
      return {
        ok: false,
        error: `Unknown config keys (retry): ${retryUnknown.join(', ')}`,
      };
    }
    const retry: NonNullable<Config['retry']> = { ...DEFAULT_RETRY_CONFIG };
    if ('enabled' in input.retry) {
      if (typeof input.retry.enabled !== 'boolean') {
        return { ok: false, error: "Invalid config: 'retry.enabled' must be a boolean" };
      }
      retry.enabled = input.retry.enabled;
    }
    if ('maxAttempts' in input.retry) {
      const v = input.retry.maxAttempts;
      if (!isFiniteInteger(v) || v < RETRY_MAX_ATTEMPTS_MIN || v > RETRY_MAX_ATTEMPTS_LIMIT) {
        return {
          ok: false,
          error: `Invalid config: 'retry.maxAttempts' must be an integer between ${RETRY_MAX_ATTEMPTS_MIN} and ${RETRY_MAX_ATTEMPTS_LIMIT}`,
        };
      }
      retry.maxAttempts = v;
    }
    if ('baseDelayMs' in input.retry) {
      const v = input.retry.baseDelayMs;
      if (!isFiniteInteger(v) || v < 0 || v > MAX_RETRY_BASE_DELAY_MS) {
        return {
          ok: false,
          error: `Invalid config: 'retry.baseDelayMs' must be a non-negative integer up to ${MAX_RETRY_BASE_DELAY_MS}`,
        };
      }
      retry.baseDelayMs = v;
    }
    if ('maxDelayMs' in input.retry) {
      const v = input.retry.maxDelayMs;
      if (!isFiniteInteger(v) || v < 0 || v > MAX_RETRY_MAX_DELAY_MS) {
        return {
          ok: false,
          error: `Invalid config: 'retry.maxDelayMs' must be a non-negative integer up to ${MAX_RETRY_MAX_DELAY_MS}`,
        };
      }
      retry.maxDelayMs = v;
    }
    if ('retryableStatuses' in input.retry) {
      const v = input.retry.retryableStatuses;
      if (
        !Array.isArray(v) ||
        !v.every((s) => isFiniteInteger(s) && s >= 100 && s < 600) ||
        v.length === 0
      ) {
        return {
          ok: false,
          error: `Invalid config: 'retry.retryableStatuses' must be a non-empty array of HTTP status codes (100-599). Defaults: ${DEFAULT_RETRYABLE_STATUSES.join(', ')}`,
        };
      }
      retry.retryableStatuses = v;
    }
    out.retry = retry;
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
    // Pass `config.model` so a stale `activeProviderId` can still recover via
    // model match instead of silently resolving the first provider (which
    // would report a cap for the wrong model). Returns null when neither
    // resolves, in which case we omit the cap hint.
    const activeProvider = resolveProvider(config, config.activeProviderId, config.model);
    if (activeProvider?.baseUrl && activeProvider?.model) {
      try {
        const resolved = await resolveEffectiveNumCtx(
          buildLlmRequestContext({
            ...(activeProvider.provider ? { provider: activeProvider.provider } : {}),
            ...(activeProvider.apiKey ? { apiKey: activeProvider.apiKey } : {}),
            baseUrl: activeProvider.baseUrl,
          }),
          activeProvider.model,
          activeProvider.numCtx ?? config.numCtx ?? DEFAULT_NUM_CTX
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
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      model: '',
      compactionModel: '',
      numCtx: DEFAULT_NUM_CTX,
      chatTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
      yolo: false,
      thinkingEnabled: true,
      promptTimestamps: true,
      webSearch: { ...DEFAULT_WEB_SEARCH_SETTINGS },
      completionMode: 'normal',
      maxPromptLoopIterations: DEFAULT_MAX_PROMPT_LOOP_ITERATIONS,
      retry: { ...DEFAULT_RETRY_CONFIG },
      ...currentConfig,
    };

    // Merge webSearch if provided
    const updatedWebSearch = {
      ...DEFAULT_WEB_SEARCH_SETTINGS,
      ...base.webSearch,
      ...body.webSearch,
    };

    // Merge retry if provided (shallow `...body` would replace the whole
    // object and drop defaulted fields, mirroring the webSearch pattern).
    const updatedRetry = body.retry
      ? { ...DEFAULT_RETRY_CONFIG, ...base.retry, ...body.retry }
      : { ...DEFAULT_RETRY_CONFIG, ...base.retry };

    const updatedConfig: Config = {
      ...base,
      ...body,
      webSearch: updatedWebSearch,
      retry: updatedRetry,
    };

    // Scrub empty API-key strings so they don't get persisted.
    if (updatedConfig.apiKey !== undefined && updatedConfig.apiKey.trim() === '') {
      delete updatedConfig.apiKey;
    }

    // Scrub empty per-provider API keys.
    if (updatedConfig.providers) {
      for (const provider of updatedConfig.providers) {
        if (provider.apiKey !== undefined && provider.apiKey.trim() === '') {
          delete provider.apiKey;
        }
        if (provider.model !== undefined && provider.model.trim() === '') {
          delete provider.model;
        }
      }
    }

    // `lastModel` is a legacy alias kept only for backward-compatible reads
    // of older `config.json` files. If we have a `model` (the canonical key),
    // drop the legacy duplicate from the persisted output so the file
    // migrates cleanly to the new key on the next save.
    if (updatedConfig.model !== undefined) {
      delete updatedConfig.lastModel;
    }

    // Invalidate the cap-resolver and vision caches for any provider
    // whose identity (baseUrl/model) or context size changed, plus the
    // legacy top-level fields. Without this, stale entries from a
    // previous model/runner state would persist for up to 5 minutes.
    const currentProviders = getNormalizedProviders(currentConfig ?? null);
    const nextProviders = getNormalizedProviders(updatedConfig);
    const changedProviderIds = new Set<string>();
    for (const next of nextProviders) {
      const current = currentProviders.find((p) => p.id === next.id);
      if (
        !current ||
        current.provider !== next.provider ||
        current.baseUrl !== next.baseUrl ||
        current.model !== next.model ||
        current.numCtx !== next.numCtx
      ) {
        changedProviderIds.add(next.id);
      }
    }
    for (const current of currentProviders) {
      const next = nextProviders.find((p) => p.id === current.id);
      if (!next) {
        changedProviderIds.add(current.id);
      }
    }

    for (const id of changedProviderIds) {
      const current = currentProviders.find((p) => p.id === id);
      const next = nextProviders.find((p) => p.id === id);
      if (next?.baseUrl && next?.model) {
        invalidateCapCache(next.baseUrl, next.model);
        invalidateVisionCache(next.baseUrl, next.model, next.provider);
      }
      if (current?.baseUrl && current?.model) {
        invalidateCapCache(current.baseUrl, current.model);
        invalidateVisionCache(current.baseUrl, current.model, current.provider);
      }
    }

    // Switching the active provider (without editing provider entries)
    // changes which credentials/model we talk to next, so invalidate the
    // old and new active-provider caches as well.
    const currentActive = resolveProvider(currentConfig ?? null, currentConfig?.activeProviderId);
    const nextActive = resolveProvider(updatedConfig, updatedConfig.activeProviderId);
    if (
      currentActive?.baseUrl &&
      currentActive?.model &&
      (currentActive.id !== nextActive?.id || currentActive.model !== nextActive?.model)
    ) {
      invalidateCapCache(currentActive.baseUrl, currentActive.model);
      invalidateVisionCache(currentActive.baseUrl, currentActive.model, currentActive.provider);
    }
    if (nextActive?.baseUrl && nextActive?.model) {
      invalidateCapCache(nextActive.baseUrl, nextActive.model);
      invalidateVisionCache(nextActive.baseUrl, nextActive.model, nextActive.provider);
    }

    // Legacy top-level fields still participate in cache invalidation so
    // single-provider configs (or configs during migration) behave correctly.
    const baseUrlChanged = body.baseUrl !== undefined && body.baseUrl !== currentConfig?.baseUrl;
    const modelChanged = body.model !== undefined && body.model !== currentConfig?.model;
    if (baseUrlChanged || modelChanged) {
      if (updatedConfig.baseUrl && updatedConfig.model) {
        invalidateCapCache(updatedConfig.baseUrl, updatedConfig.model);
        invalidateVisionCache(updatedConfig.baseUrl, updatedConfig.model, updatedConfig.provider);
      }
      if (currentConfig?.baseUrl && currentConfig?.model) {
        invalidateCapCache(currentConfig.baseUrl, currentConfig.model);
        invalidateVisionCache(currentConfig.baseUrl, currentConfig.model, currentConfig.provider);
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
