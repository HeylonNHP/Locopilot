/**
 * Which model and which provider the COMPACTION calls run on — the SERVER's
 * answer, with the config lookup around the shared rule.
 *
 * The RULE itself lives in `src/services/compactionRule.ts` and has no
 * imports, because the browser needs it too (to show which model and
 * provider a conversation will actually compact with) and the server-side
 * composer pulls in the provider resolver, which pulls in the LLM adapters
 * and their HTTP client — far too heavy for a browser bundle. This module
 * adds the two things the rule deliberately leaves out:
 *
 *   1. the global half of the selection, read from the saved config
 *      (`config.compactionModel` with `config.compactionProviderId`);
 *   2. the REFUSAL — a provider id that names no configured provider is a
 *      problem, not a reason to fall back.
 *
 * A provider is resolved BY ID ONLY. Model-name matching is never used to
 * recover a compaction provider: a model name says nothing about which
 * endpoint serves it, and guessing is what produced the 404s.
 *
 * A provider id that does not name a configured provider is a PROBLEM, not a
 * reason to fall back. The caller refuses the request with the message here
 * (409) instead of quietly running the compaction on the main provider.
 */

import type { Config } from '@/types/chatConfig';

import {
  type CompactionModelSource,
  type CompactionProviderSource,
  resolveCompactionRule,
} from './compactionRule';
import { resolveProvider } from './providerResolver';
import { type CompactionSelection as CompactionSelectionState } from './sessionSelection';

export interface CompactionSelectionInput {
  /** The saved config. `null` when it could not be read. */
  config: Config | null;
  /** The conversation's main model — the fallback when nothing is pinned. */
  mainModel: string;
  /**
   * The conversation's own compaction selection — ONE value with THREE
   * states (`CompactionSelection`).
   *
   * The pair it stands for used to be two independent nullable fields, which
   * admitted a model without a provider. That state is unrepresentable now,
   * so the caller cannot hand one over: a request body that carries the old
   * flat pair is converted by `compactionSelectionFromPayload`
   * (`src/services/sessionSelection.ts`), which refuses a half-pair.
   */
  sessionCompaction?: CompactionSelectionState | null | undefined;
}

export interface CompactionSelection {
  /** The model the compaction calls run on. */
  model: string;
  /**
   * The provider that serves it, or `null` when the MAIN provider is used.
   *
   * `null` is a real answer ("the same provider the chat runs on"), not
   * "unknown": the caller resolves the main provider itself.
   */
  providerId: string | null;
  /** Where {@link model} came from. */
  modelSource: CompactionModelSource;
  /** Where {@link providerId} came from. */
  providerSource: CompactionProviderSource;
  /**
   * A reason the request must be REFUSED, or `null` when it can run.
   *
   * The only reason today is a compaction provider id that names no
   * configured provider. It is deliberately loud: the alternative — running
   * the compaction on the main provider — is a silent wrong endpoint.
   */
  problem: string | null;
}

/**
 * Resolve the compaction selection for one request.
 *
 * See `src/services/compactionRule.ts` for the rule and this module's
 * comment for what is added around it. This function is pure: it reads the
 * config and the conversation's pins and answers. It never probes a provider
 * and never falls back on its own.
 */
export function resolveCompactionSelection(
  input: CompactionSelectionInput
): CompactionSelection {
  const { config, mainModel } = input;
  // The conversation's own selection is ONE value with three states. A
  // request body that carries the OLD flat pair is converted by
  // `compactionSelectionFromPayload` before it gets here, and a half-pair in
  // that legacy shape is refused there — the state that sent a compaction
  // model to an endpoint that did not have it.
  const sessionCompaction = input.sessionCompaction ?? { kind: 'inherit-default' };

  const rule = resolveCompactionRule({
    mainModel,
    sessionCompaction,
    globalCompactionModel: config?.compactionModel,
    globalCompactionProviderId: config?.compactionProviderId,
  });

  // -- the one refusal -----------------------------------------------
  let problem: string | null = null;
  if (rule.providerId !== null && resolveProvider(config, rule.providerId) === null) {
    problem =
      rule.providerSource === 'session'
        ? `The compaction provider "${rule.providerId}" is not configured, so this conversation cannot compact. Open Settings and pick a compaction provider that exists.`
        : `The global compaction provider "${rule.providerId}" is not configured, so compaction cannot run. Fix "compactionProviderId" in config.json, or pick a compaction provider in Settings.`;
  }

  return {
    model: rule.model,
    providerId: rule.providerId,
    modelSource: rule.modelSource,
    providerSource: rule.providerSource,
    problem,
  };
}

export {type CompactionModelSource, type CompactionProviderSource} from './compactionRule';