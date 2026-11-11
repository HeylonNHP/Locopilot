/**
 * The context window for one (provider, model): the single computation the
 * server uses, and the single answer it reports to the page.
 *
 *     effective = min(requested, modelMax)    when the maximum is known
 *     effective = requested                   when it is not
 *
 * `requested` is the user's SETTING: the provider's own `numCtx` when the
 * provider has one, otherwise the global `numCtx`. A request body is never an
 * input: a page that sends a number cannot override a setting that was changed
 * in another tab, and an old retry cannot replay an old window.
 *
 * `modelMax` comes from `capResolver.ts` (probe, 400-learned limit, cache).
 */

import type { LlmRequestContext } from '@/services/llm';
import type { NumCtxResolution } from '@/types/numCtx';

import { type CapProbeDeps, resolveModelMax } from '@/services/capResolver';
import { parsePositiveInteger } from '@/services/llmContextLimit';

export type { NumCtxResolution } from '@/types/numCtx';

/** The setting that applies: the provider's own, else the global one. */
export function pickRequestedNumCtx(providerNumCtx: unknown, configNumCtx: unknown): number | null {
  return parsePositiveInteger(providerNumCtx) ?? parsePositiveInteger(configNumCtx);
}

/** `min(requested, modelMax)` when the maximum is known, otherwise `requested`. */
export function computeEffectiveNumCtx(
  requested: number | null,
  modelMax: number | null
): number | null {
  if (requested === null) {
    return null;
  }
  return modelMax === null ? requested : Math.min(requested, modelMax);
}

/**
 * Resolve the window for `model` on the endpoint `ctx` points at. Never
 * throws; a failed probe gives `known: false` and a `probeError`.
 */
export async function resolveNumCtx(
  input: {
    ctx: LlmRequestContext;
    model: string;
    /** `provider.numCtx` of the provider that serves the model, if it has one. */
    providerNumCtx?: number | undefined;
    /** The global `config.numCtx`. */
    configNumCtx?: number | undefined;
  },
  deps: Partial<CapProbeDeps> = {}
): Promise<NumCtxResolution> {
  const requested = pickRequestedNumCtx(input.providerNumCtx, input.configNumCtx);
  const { modelMax, source, probeError } = await resolveModelMax(input.ctx, input.model, deps);
  return {
    requested,
    modelMax,
    effective: computeEffectiveNumCtx(requested, modelMax),
    known: modelMax !== null,
    source,
    probeError,
  };
}
