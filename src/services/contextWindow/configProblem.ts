/**
 * Why a request cannot run on the saved config, or `null` when it can.
 *
 * Checked before any model call, by the routes that send to a model (chat,
 * compact, title, dump). A fresh `config.json` has no provider and no model
 * until the owner chooses one in Settings; a config with no context size has
 * no window to plan with. Neither is assumed away: the request is refused with
 * the message below, which is what the owner sees.
 */

import type { Config, ProviderConfig } from '@/types/chatConfig';

import { resolveCompactionSelection } from '@/services/compactionSelection';
import {
  providerIdsServingModel,
  providerServesModel,
  refreshModelIndexInBackground,
} from '@/services/modelIndex';
import { getNormalizedProviders, resolveProvider } from '@/services/providerResolver';

import { pickRequestedNumCtx } from './resolveNumCtx';

export const MODEL_NOT_CHOSEN_MESSAGE =
  'No model is set up yet. Open Settings, add a provider if there is none, and choose a model to start chatting.';

export const CONTEXT_SIZE_NOT_SET_MESSAGE =
  'No context size is set. Open Settings and set Context Size, then try again.';

/**
 * The problem with a provider id that names no configured provider.
 *
 * This is NOT the "no model is set up yet" case: the model may be
 * perfectly fine, and the provider may simply have been renamed or removed
 * from `config.json` since the conversation was saved. The message names
 * the id, because the id is what the owner has to fix — and because a
 * request that cannot name its provider must not be sent somewhere else
 * quietly.
 */
export function providerNotConfiguredMessage(providerId: string): string {
  return `The provider "${providerId}" is not configured, so this request cannot run on it. Open Settings and pick a model and provider again.`;
}

/**
 * The problem with a pair whose provider does not serve the model.
 *
 * A pair is only coherent if the provider actually CARRIES the model.
 * `config.json` cannot answer that (it holds a provider's default model and
 * nothing else), so the answer comes from the cached model → provider index
 * (`src/services/modelIndex.ts`), which is built from the providers' LIVE
 * model lists. A pair that names a real provider which does not serve the
 * model is refused here instead of 404ing at the provider.
 *
 * The message names the provider that DOES serve the model, so the fix is
 * one pick in Settings rather than a hunt.
 */
export function providerDoesNotServeMessage(
  config: Config,
  provider: ProviderConfig,
  model: string
): string {
  const serving = providerIdsServingModel(config, model)
    .map((id) => getNormalizedProviders(config).find((p) => p.id === id)?.name)
    .filter((name): name is string => typeof name === 'string' && name !== provider.name);
  const hint =
    serving.length > 0
      ? ` The model "${model}" is served by ${serving.join(', ')} instead.`
      : ` No configured provider is known to serve it.`;
  return `The provider "${provider.name}" does not serve the model "${model}".${hint} Pick a model and a provider that belong together in Settings.`;
}

/**
 * The problem with running `model` through `providerId` on this config, or
 * `null`. The provider's own `numCtx` counts toward the window, so a provider
 * with its own window is fine even when the global setting is missing.
 */
export function configProblemFor(
  config: Config,
  providerId: string | undefined,
  model: string
): string | null {
  const provider = resolveProvider(config, providerId, model);
  if (!provider) {
    // An explicit id that names no configured provider is a DIFFERENT
    // problem from "no model is set up yet": the id is what has to be
    // fixed, so the message names it. Without an id there is nothing to
    // name, and the only thing left to say is that nothing is set up.
    return providerId ? providerNotConfiguredMessage(providerId) : MODEL_NOT_CHOSEN_MESSAGE;
  }
  // The pair itself: does this provider serve this model? The index answers
  // "unknown" when it cannot say, and unknown NEVER refuses.
  const service = providerServesModel(provider.id, provider.baseUrl, model);
  if (service === 'not-served') {
    return providerDoesNotServeMessage(config, provider, model);
  }
  if (service === 'unknown') {
    // The index cannot answer yet. Refresh it in the background, so the
    // NEXT turn can ask the question instead of guessing.
    refreshModelIndexInBackground(config);
  }
  if (pickRequestedNumCtx(provider.numCtx, config.numCtx) === null) {
    return CONTEXT_SIZE_NOT_SET_MESSAGE;
  }
  return null;
}

/**
 * The problem with running the COMPACTION on this config, or `null`.
 *
 * The compaction model and provider travel together: the conversation's own
 * pin, then the global pair (`config.compactionModel` with
 * `config.compactionProviderId`), then the conversation's main model on the
 * main provider. The rule itself lives in `src/services/compactionSelection.ts`
 * — this is only the refusal half of it.
 *
 * A compaction provider id that names no configured provider is a PROBLEM,
 * not a reason to fall back: the compaction would quietly run on the main
 * provider instead, which is the silent wrong endpoint that produced the
 * 404s.
 *
 * A compaction provider of its own also needs a window of its own: the
 * summarising calls are planned against that window, not the main one. The
 * main provider's window is the main check's business.
 */
export function compactionProblemFor(
  config: Config,
  input: {
    mainModel: string;
    compactionModel?: unknown;
    compactionProviderId?: unknown;
  }
): string | null {
  const selection = resolveCompactionSelection({
    config,
    mainModel: input.mainModel,
    sessionCompactionModel:
      typeof input.compactionModel === 'string' ? input.compactionModel : null,
    sessionCompactionProviderId:
      typeof input.compactionProviderId === 'string' ? input.compactionProviderId : null,
  });
  if (selection.problem !== null) {
    return selection.problem;
  }
  if (selection.providerId === null) {
    // The MAIN provider — the main check already covered its window.
    return null;
  }
  return configProblemFor(config, selection.providerId, selection.model);
}

/**
 * The same check for a route whose body fields are not typed yet (compact,
 * title and dump). The compaction half is checked too, since the compaction
 * provider's window is the one the summarising calls are planned against —
 * but a route that never compacts (the dump) can opt out of it.
 */
export function requestProblemFor(
  config: Config,
  body: {
    providerId?: unknown;
    model: string;
    compactionProviderId?: unknown;
    compactionModel?: unknown;
  },
  options?: { checkCompaction?: boolean }
): string | null {
  const providerId =
    typeof body.providerId === 'string' && body.providerId.trim()
      ? body.providerId.trim()
      : undefined;
  const mainProblem = configProblemFor(config, providerId, body.model);
  if (mainProblem !== null) {
    return mainProblem;
  }
  if (options?.checkCompaction === false) {
    return null;
  }
  return compactionProblemFor(config, {
    mainModel: body.model,
    compactionModel: body.compactionModel,
    compactionProviderId: body.compactionProviderId,
  });
}

/**
 * The window from a resolution, or an error when there is none. There is no
 * default to fall back on: the request is refused instead (Phase 3.3).
 */
export function requireWindow(effective: number | null): number {
  if (effective === null) {
    throw new Error(CONTEXT_SIZE_NOT_SET_MESSAGE);
  }
  return effective;
}
