/**
 * A cached model → provider index: does this provider SERVE this model?
 *
 * WHY IT EXISTS. A selection is a (model, provider) PAIR, and the pair is
 * only coherent if the provider actually carries the model. `config.json`
 * cannot answer that question: it holds a provider's default model and
 * nothing else (the owner's `ollama-cloud` provider has no `model` field at
 * all), so a pair can name a REAL provider that does not serve the model —
 * and the request then 404s at the provider, with nothing to explain it.
 *
 * THE ANSWER ALREADY EXISTS. `GET /api/models` fetches every provider's
 * live model list and returns each model with its real `providerId`. The
 * server throws that answer away. This module keeps the lists in a
 * process-wide cache so the server can ask the question WITHOUT a network
 * call on the chat path.
 *
 * THREE RULES.
 *  1. The index is read SYNCHRONOUSLY. A cold cache answers "unknown", and
 *     unknown NEVER refuses: a dead or slow provider must not block a turn.
 *  2. A successful list is trusted for MODEL_LIST_TTL_MS (5 minutes) — a
 *     provider's catalogue changes slowly. A FAILED list is remembered for
 *     FAILED_LIST_TTL_MS (60 seconds) — a dead provider is retried quickly,
 *     but not on every turn.
 *  3. The index never BLOCKS. A refresh runs in the background; the turn
 *     that triggered it proceeds with what is already known.
 *
 * The key is (provider id, base URL), so a provider whose ADDRESS changed
 * has a different list and the old one is not mistaken for the new one.
 */

import type { Config, ProviderConfig } from '@/types/chatConfig';

import { buildLlmRequestContext, fetchLlmModels } from './llm';
import { getNormalizedProviders } from './providerResolver';

/** How long a provider's model list is trusted. */
const MODEL_LIST_TTL_MS = 5 * 60 * 1000;
/** How long a FAILED fetch is remembered, so a dead provider is not retried on every turn. */
const FAILED_LIST_TTL_MS = 60 * 1000;
/** The shortest gap between two background refresh sweeps. */
const REFRESH_INTERVAL_MS = 60 * 1000;

/**
 * The answer to "does this provider serve this model?".
 *
 * `'unknown'` is a real answer: the index cannot say. It never refuses.
 */
export type ModelServiceCheck = 'served' | 'not-served' | 'unknown';

/**
 * The background refresh's seams.
 *
 * The refresh is fire-and-forget, so a test cannot inject a dependency per
 * call the way the capability probe does — it needs a seam it can install
 * for the whole module, so a test run never reaches for a provider.
 */
export interface ModelIndexDeps {
  /** The provider's live model names. */
  fetchModels: (provider: ProviderConfig) => Promise<string[]>;
}

const defaultDeps: ModelIndexDeps = {
  fetchModels: async (provider) => {
    const models = await fetchLlmModels(
      buildLlmRequestContext({
        ...(provider.provider ? { provider: provider.provider } : {}),
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
        baseUrl: provider.baseUrl,
      })
    );
    return models.map((model) => model.name);
  },
};

let deps: ModelIndexDeps = defaultDeps;

/**
 * Replace the background refresh's dependencies, or restore the production
 * ones by passing `null`. Production never calls this.
 */
export function setModelIndexDeps(next: Partial<ModelIndexDeps> | null): void {
  deps = next === null ? defaultDeps : { ...deps, ...next };
}

interface ProviderListEntry {
  /**
   * The model names, as the provider listed them — or `null` when the last
   * fetch FAILED. A failed fetch is not an empty list: an empty list would
   * say "this provider serves nothing", which is a refusal, and that would
   * be a lie.
   */
  models: string[] | null;
  /** When the entry stops being trusted. */
  expiresAt: number;
  /** When the last refresh was ATTEMPTED, successful or not. */
  attemptedAt: number;
}

const entries = new Map<string, ProviderListEntry>();
/** One refresh per provider key at a time. */
const inflight = new Set<string>();
/** When the last background sweep was started. */
let lastSweepAt = 0;

function entryKey(providerId: string, baseUrl: string): string {
  // NUL separates the parts so a value containing another separator character
  // cannot collide with a different pair. NUL is valid in none of them.
  return `${providerId}\0${baseUrl}`;
}

/**
 * Does `model` name one of `models`?
 *
 * The same rule the Ollama adapter uses when it looks a model up in
 * `/api/ps`: a name matches a listed name when they are equal, or when the
 * listed name continues with `:` — so `llama3` names `llama3:latest` and
 * `llama3:8b`, and `llama3:8b` names `llama3:8b`.
 */
function listContainsModel(models: readonly string[], model: string): boolean {
  const wanted = model.trim();
  if (!wanted) return false;
  return models.some((candidate) => candidate === wanted || candidate.startsWith(`${wanted}:`));
}

/**
 * The live entry for a provider, or `null` when there is none to trust:
 * never fetched, expired, or the last fetch failed.
 */
function liveEntry(providerId: string, baseUrl: string): ProviderListEntry | null {
  const key = entryKey(providerId, baseUrl);
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    entries.delete(key);
    return null;
  }
  return entry;
}

/**
 * Remember a provider's model list. Called by `GET /api/models`, which
 * already fetches every provider's live list.
 */
export function recordProviderModels(
  providerId: string,
  baseUrl: string,
  models: readonly string[]
): void {
  const now = Date.now();
  entries.set(entryKey(providerId, baseUrl), {
    models: [...models],
    expiresAt: now + MODEL_LIST_TTL_MS,
    attemptedAt: now,
  });
}

/**
 * Remember that a provider's list could NOT be fetched. The entry answers
 * "unknown" until it expires, so a dead provider is not retried on every
 * turn.
 */
export function recordProviderListFailure(providerId: string, baseUrl: string): void {
  const now = Date.now();
  entries.set(entryKey(providerId, baseUrl), {
    models: null,
    expiresAt: now + FAILED_LIST_TTL_MS,
    attemptedAt: now,
  });
}

/**
 * The provider's model names, or `null` when the index cannot say.
 */
export function peekProviderModels(providerId: string, baseUrl: string): string[] | null {
  const entry = liveEntry(providerId, baseUrl);
  return entry?.models ?? null;
}

/**
 * Does this provider serve this model?
 *
 * `'unknown'` means the index cannot answer — never fetched, the fetch
 * failed, or the list has expired. Unknown NEVER refuses; it only means the
 * question could not be asked. Call {@link refreshModelIndexInBackground}
 * when that happens, so the NEXT turn can ask it.
 */
export function providerServesModel(
  providerId: string,
  baseUrl: string,
  model: string
): ModelServiceCheck {
  const entry = liveEntry(providerId, baseUrl);
  // An EMPTY list is treated as unknown, not as "this provider serves
  // nothing": an empty answer is more often a provider that answered
  // oddly than a provider with no models, and refusing on it would break a
  // working conversation.
  if (entry === null || entry.models === null || entry.models.length === 0) {
    return 'unknown';
  }
  return listContainsModel(entry.models, model) ? 'served' : 'not-served';
}

/**
 * The configured providers that SERVE this model, by id.
 *
 * Used to name a provider that does serve the model when a pair is refused:
 * the fix is then one pick in Settings rather than a hunt.
 */
export function providerIdsServingModel(config: Config | null, model: string): string[] {
  const wanted = model.trim();
  if (!wanted) return [];
  const serving: string[] = [];
  for (const provider of getNormalizedProviders(config)) {
    const entry = liveEntry(provider.id, provider.baseUrl);
    if (entry?.models && listContainsModel(entry.models, wanted)) {
      serving.push(provider.id);
    }
  }
  return serving;
}

/**
 * Drop what is known about a provider (or about every provider).
 *
 * Called when a provider's model or address changes — the same moments that
 * invalidate the context-window and vision caches. The entry's key already
 * includes the address, so an address change leaves the old list behind
 * rather than answering for the new one; this clears it outright.
 */
export function invalidateModelIndex(providerId?: string): void {
  if (providerId === undefined) {
    entries.clear();
    return;
  }
  const prefix = `${providerId}\0`;
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) {
      entries.delete(key);
    }
  }
}

/**
 * Refresh every configured provider's list, in the background.
 *
 * The caller supplies the config: the refresh is fire-and-forget, so it
 * must not read `config.json` itself — the caller already has it, and a
 * background read would be a second copy of the truth.
 *
 * The sweep never blocks: it is started at most once per
 * {@link REFRESH_INTERVAL_MS}, and each provider is fetched at most once
 * per interval and one at a time.
 */
export function refreshModelIndexInBackground(config: Config | null): void {
  const now = Date.now();
  if (now - lastSweepAt < REFRESH_INTERVAL_MS) return;
  lastSweepAt = now;
  void sweep(config);
}

async function sweep(config: Config | null): Promise<void> {
  const providers = getNormalizedProviders(config);
  await Promise.all(providers.map((provider) => refreshProvider(provider)));
}

async function refreshProvider(provider: ProviderConfig): Promise<void> {
  const key = entryKey(provider.id, provider.baseUrl);
  if (inflight.has(key)) return;
  const existing = entries.get(key);
  const now = Date.now();
  if (existing && now - existing.attemptedAt < REFRESH_INTERVAL_MS) return;
  inflight.add(key);
  try {
    const models = await deps.fetchModels(provider);
    recordProviderModels(provider.id, provider.baseUrl, models);
  } catch {
    recordProviderListFailure(provider.id, provider.baseUrl);
  } finally {
    inflight.delete(key);
  }
}
