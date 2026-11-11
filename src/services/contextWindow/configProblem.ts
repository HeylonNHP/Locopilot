/**
 * Why a request cannot run on the saved config, or `null` when it can.
 *
 * Checked before any model call, by the routes that send to a model (chat,
 * compact, title, dump). A fresh `config.json` has no provider and no model
 * until the owner chooses one in Settings; a config with no context size has
 * no window to plan with. Neither is assumed away: the request is refused with
 * the message below, which is what the owner sees.
 */

import type { Config } from '@/types/chatConfig';

import { resolveProvider } from '@/services/providerResolver';

import { pickRequestedNumCtx } from './resolveNumCtx';

export const MODEL_NOT_CHOSEN_MESSAGE =
  'No model is set up yet. Open Settings and choose a model to start chatting.';

export const CONTEXT_SIZE_NOT_SET_MESSAGE =
  'No context size is set. Open Settings and set Context Size, then try again.';

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
    return MODEL_NOT_CHOSEN_MESSAGE;
  }
  if (pickRequestedNumCtx(provider.numCtx, config.numCtx) === null) {
    return CONTEXT_SIZE_NOT_SET_MESSAGE;
  }
  return null;
}

/**
 * The same check for a route whose body fields are not typed yet (compact,
 * title and dump). A compaction provider named in the body is checked too,
 * since its window is the one the summarising calls are planned against.
 */
export function requestProblemFor(
  config: Config,
  body: {
    providerId?: unknown;
    model: string;
    compactionProviderId?: unknown;
    compactionModel?: unknown;
  }
): string | null {
  const providerId =
    typeof body.providerId === 'string' && body.providerId.trim()
      ? body.providerId.trim()
      : undefined;
  const mainProblem = configProblemFor(config, providerId, body.model);
  if (mainProblem !== null) {
    return mainProblem;
  }
  const compactionProviderId =
    typeof body.compactionProviderId === 'string' ? body.compactionProviderId.trim() : '';
  if (!compactionProviderId) {
    return null;
  }
  const compactionModel =
    typeof body.compactionModel === 'string' && body.compactionModel.trim()
      ? body.compactionModel.trim()
      : body.model;
  return configProblemFor(config, compactionProviderId, compactionModel);
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
