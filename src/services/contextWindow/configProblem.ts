/**
 * Why a request cannot run on the saved config, or `null` when it can.
 *
 * Checked before any model call, by the routes that send to a model (chat,
 * compact, title, dump). A fresh `config.json` has no provider and no model
 * until the owner chooses one in Settings; a config with no context size has
 * no window to plan with. Neither is assumed away: the request is refused with
 * the message below, which is what the owner sees.
 */

import type { CompactionSelection, SessionSelection } from '@/services/sessionSelection';
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
 * The names of the configured providers that SERVE `model`, other than
 * `provider` itself.
 *
 * Names, not ids: the name is what the owner reads in Settings. The
 * provider that does not serve the model is left out, because naming it
 * twice would only confuse.
 *
 * The offending provider is excluded by its ID, not by its name: two
 * providers may share a name, and excluding by name would drop the
 * serving one as well - the message would then say that nobody serves the
 * model when one of them does.
 */
function servingProviderNames(
  config: Config | null,
  provider: ProviderConfig,
  model: string
): string[] {
  return providerIdsServingModel(config, model)
    .filter((id) => id !== provider.id)
    .map((id) => getNormalizedProviders(config).find((p) => p.id === id)?.name)
    .filter((name): name is string => typeof name === 'string');
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
  const serving = servingProviderNames(config, provider, model);
  const hint =
    serving.length > 0
      ? ` The model "${model}" is served by ${serving.join(', ')} instead.`
      : ` No configured provider is known to serve it.`;
  return `The provider "${provider.name}" does not serve the model "${model}".${hint} Pick a model and a provider that belong together in Settings.`;
}

/**
 * Whose provider a refusal is talking about.
 *
 * `'current'` is the provider the conversation RUNS ON - the turn-start
 * case. `'switch-target'` is the provider a SWITCH would move it to, and a
 * switch that names an incoherent pair is REFUSED, so the conversation does
 * NOT end up on it. Saying "the provider this conversation uses" there
 * would name a provider the conversation is not on.
 */
export type MainProviderRole = 'current' | 'switch-target';

/**
 * The problem with a COMPACTION model that has no provider of its own, when
 * the provider it inherits - the one the CHAT runs on - does not serve it.
 *
 * The global compaction model with no global compaction provider runs on the
 * provider the conversation is chatting on. That is a legitimate meaning of
 * the global pair (C-029), and it is honoured whenever that provider serves
 * the model. When it does not, the compaction call would 404 at the provider
 * - the production failure this whole effort exists to end (CONFIRMATIONS
 * C-025: 221 failures in 14 minutes under one request id) - so the request
 * is refused here, with a message that names the cause AND the provider that
 * DOES serve the model.
 *
 * The message is its own, not `providerDoesNotServeMessage`'s: the MAIN pair
 * is perfectly coherent here, and telling the owner to "pick a model and a
 * provider that belong together" would send them to fix the wrong thing.
 */
export function compactionProviderDoesNotServeMessage(
  config: Config | null,
  provider: ProviderConfig,
  model: string,
  role: MainProviderRole = 'current'
): string {
  const serving = servingProviderNames(config, provider, model);
  const hint =
    serving.length > 0
      ? ` The model "${model}" is served by ${serving.join(', ')} instead.`
      : ` No configured provider is known to serve it.`;
  const whose =
    role === 'switch-target'
      ? `the provider the switch names ("${provider.name}")`
      : `the provider this conversation uses ("${provider.name}")`;
  return `The compaction model "${model}" has no provider of its own, so it runs on ${whose}, which does not serve it.${hint} Give the compaction model a provider that serves it - set "compactionProviderId" in config.json, or pick a compaction model and provider that belong together in Settings.`;
}

/**
 * The problem with running `model` on `provider` as the COMPACTION model, or
 * `null` when there is none.
 *
 * The same three-valued question the MAIN pair asks, asked of a compaction
 * model that has no provider of its own: does this provider SERVE it?
 *
 * 'unknown' never refuses. A cold cache, a failed fetch and an empty list
 * all answer unknown, because a dead or slow provider must not block a turn.
 * The background refresh is kicked so the NEXT turn can ask the question
 * instead of guessing.
 */
export function compactionModelServiceProblem(
  config: Config | null,
  provider: ProviderConfig,
  model: string,
  role: MainProviderRole = 'current'
): string | null {
  const service = providerServesModel(provider.id, provider.baseUrl, model);
  if (service !== 'served') {
    // Refresh the index in the background so the NEXT ask is better
    // informed: for `unknown` the index cannot answer yet, and for
    // `not-served` the list may be up to MODEL_LIST_TTL_MS old (a model
    // pulled or added since), so a wrong refusal heals within a minute
    // instead of at the end of the TTL. The refresh is throttled and never
    // blocks this call.
    refreshModelIndexInBackground(config);
  }
  return service === 'not-served'
    ? compactionProviderDoesNotServeMessage(config, provider, model, role)
    : null;
}

/**
 * The problem with the (model, provider) PAIR alone, or `null`: the provider
 * must exist and must serve the model. It says nothing about the context
 * window.
 *
 * That is the half a WRITE of a selection is checked against. The window is
 * a property of the config, not of the selection, and the Settings modal
 * saves a conversation's model BEFORE the context size it sets in the same
 * Save - refusing the model for a missing window would make that one Save
 * impossible. A TURN is still refused for a missing window, by
 * {@link configProblemFor}.
 */
export function pairProblemFor(
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
    // Refreshed too (see compactionModelServiceProblem): a stale list must
    // not keep refusing a model the provider serves now.
    refreshModelIndexInBackground(config);
    return providerDoesNotServeMessage(config, provider, model);
  }
  if (service === 'unknown') {
    // The index cannot answer yet. Refresh it in the background, so the
    // NEXT turn can ask the question instead of guessing.
    refreshModelIndexInBackground(config);
  }
  return null;
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
  const pairProblem = pairProblemFor(config, providerId, model);
  if (pairProblem !== null) {
    return pairProblem;
  }
  // `pairProblemFor` found a provider, so this cannot be null.
  const provider = resolveProvider(config, providerId, model);
  if (provider && pickRequestedNumCtx(provider.numCtx, config.numCtx) === null) {
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
 *
 * THE INHERITED GLOBAL PAIR. A compaction model with no provider of its own
 * - the global compaction model with no global compaction provider - runs on
 * the provider the CHAT runs on. The main check covered the main MODEL's
 * window, not whether that provider serves the COMPACTION model, so the pair
 * is asked here: with a warm index, a main provider that does not serve the
 * compaction model is refused with a message that names the cause.
 */
export function compactionProblemFor(
  config: Config,
  input: {
    mainModel: string;
    /**
     * The provider the CHAT runs on - the provider the compaction inherits
     * when it has no provider of its own.
     *
     * The RESOLVED provider, and it must be the one the turn really uses:
     * the chat route resolves it from the request's own provider id
     * (`resolveProvider(config, providerId, model)`). A compaction checked
     * against a DIFFERENT provider would refuse a working turn - a chat
     * pinned to a provider with no default model would be checked against
     * `providers[0]`, which is often not the provider the turn runs on.
     *
     * `null` when no provider could be resolved: there is nothing to check
     * the pair against, so the pair is trusted. The main check has already
     * refused a turn with no provider.
     */
    mainProvider: ProviderConfig | null;
    /**
     * How the main provider is described when the refusal names it.
     * `'current'` (the default) is the provider the chat runs on;
     * `'switch-target'` is the provider a switch would move it to - and a
     * switch that names an incoherent pair is REFUSED, so the conversation
     * does not end up on it.
     */
    mainProviderRole?: MainProviderRole;
    /**
     * The conversation's own compaction selection — ONE value, so it cannot
     * be a model without the provider that serves it.
     */
    compaction?: CompactionSelection | null | undefined;
  }
): string | null {
  const selection = resolveCompactionSelection({
    config,
    mainModel: input.mainModel,
    sessionCompaction: input.compaction,
  });
  if (selection.problem !== null) {
    return selection.problem;
  }
  if (selection.providerId === null) {
    // The MAIN provider - the main check already covered its window.
    if (selection.model === input.mainModel || input.mainProvider === null) {
      // The compaction model IS the main model, on the main provider: the
      // main pair check already answered "does this provider serve it?".
      return null;
    }
    // A compaction model of its OWN with no provider of its own: the global
    // compaction model with no global compaction provider. It runs on the
    // provider the chat runs on, so THAT provider has to serve it. This is
    // the case that sent "beam" to NVIDIA (CONFIRMATIONS C-025).
    return compactionModelServiceProblem(
      config,
      input.mainProvider,
      selection.model,
      input.mainProviderRole ?? 'current'
    );
  }
  return configProblemFor(config, selection.providerId, selection.model);
}

/**
 * The same check for a route whose body fields are not typed yet (compact and
 * title). The compaction half is checked too, since the compaction provider's
 * window is the one the summarising calls are planned against.
 *
 * `/dump` does NOT use this: it makes no model call, so it has nothing to
 * refuse (see `src/app/api/dump/route.ts`).
 */
export function requestProblemFor(
  config: Config,
  body: {
    providerId?: unknown;
    model: string;
    /**
     * The conversation's own compaction selection, already parsed by the
     * route. The route refuses an incoherent one itself (400) — this is the
     * "can it actually run" half.
     */
    compaction?: CompactionSelection | null | undefined;
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
  return compactionProblemFor(config, {
    mainModel: body.model,
    // The provider the request runs on - resolved exactly as the main check
    // resolved it, so the compaction is checked against the provider the
    // call really uses.
    mainProvider: resolveProvider(config, providerId, body.model),
    compaction: body.compaction,
  });
}

/**
 * The problem with the COMPACTION pair of a selection that is being WRITTEN,
 * or `null`. Pair only (no window), and only what the selection itself
 * decides:
 *
 * - `explicit`: the named provider must exist and serve the named model.
 * - `same-as-main`: the main pair, which the caller checks.
 * - `inherit-default`: the global pair is the owner's configuration, not this
 *   write's doing, so a problem in it is not reported here. The one thing a
 *   write CAN cause is moving the conversation onto a provider that does not
 *   serve a global compaction model that has no provider of its own, because
 *   that model is then sent to the provider the chat runs on (C-025).
 */
function compactionPairProblemFor(
  config: Config,
  input: {
    mainModel: string;
    mainProvider: ProviderConfig | null;
    compaction: CompactionSelection;
  }
): string | null {
  const selection = resolveCompactionSelection({
    config,
    mainModel: input.mainModel,
    sessionCompaction: input.compaction,
  });
  if (selection.problem !== null) {
    return input.compaction.kind === 'explicit' ? selection.problem : null;
  }
  if (selection.providerId === null) {
    if (selection.model === input.mainModel || input.mainProvider === null) {
      return null;
    }
    return compactionModelServiceProblem(config, input.mainProvider, selection.model);
  }
  return input.compaction.kind === 'explicit'
    ? pairProblemFor(config, selection.providerId, selection.model)
    : null;
}

/** Which halves of a selection a write has to answer for. */
export interface SelectionWriteScope {
  /** The main (model, provider) pair. */
  main: boolean;
  /** The compaction pair. */
  compaction: boolean;
}

/**
 * Why a selection may not be WRITTEN to a conversation, or `null`.
 *
 * The write paths used to check the SHAPE of the pair and nothing else, so a
 * conversation could be saved pointing at a provider that does not exist (or
 * does not serve the model) and was then refused at its first turn: a
 * conversation the server accepted and then would not run (bug hunt BUG 5).
 * The pair checks a turn makes are made here too, so the write is refused
 * where the cause can still be named.
 *
 * `scope` says what the write ITSELF changes. A half the write did not touch
 * is not re-checked: a conversation already broken by a removed provider must
 * stay editable, or the fix for one half would be refused because of the
 * other and the conversation could never be repaired. For the same reason
 * only the PAIR is checked here and never the context window (see
 * {@link pairProblemFor}).
 *
 * Same three-valued index as the turn's checks: `unknown` never refuses.
 * `null` config (unreadable) is not this write's problem and is not refused.
 */
export function selectionWriteProblem(
  config: Config | null,
  selection: SessionSelection,
  scope: SelectionWriteScope
): string | null {
  if (config === null) {
    return null;
  }
  const model = selection.model.trim();
  const providerId = selection.providerId?.trim() || undefined;
  if (scope.main && model !== '') {
    const mainProblem = pairProblemFor(config, providerId, model);
    if (mainProblem !== null) {
      return mainProblem;
    }
  }
  if (scope.compaction) {
    return compactionPairProblemFor(config, {
      mainModel: model,
      mainProvider: resolveProvider(config, providerId, model),
      compaction: selection.compaction,
    });
  }
  return null;
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

/**
 * The problem with a provider id that names no configured provider, in a
 * MODEL SWITCH.
 *
 * Its own wording, not `providerNotConfiguredMessage`'s: that one is about a
 * REQUEST that cannot run on the provider, and this one is about a SWITCH
 * that cannot use it.
 */
export function switchProviderNotConfiguredMessage(providerId: string): string {
  return `The provider "${providerId}" is not configured, so the model switch cannot use it. Open Settings and pick a model and provider again.`;
}

/** What a switch would move the turn to. */
export interface ModelSwitchTarget {
  /** The model the turn would run on. */
  model: string;
  /** The provider the turn would run on. */
  provider: ProviderConfig;
  /** The compaction selection the turn would use. */
  compaction: CompactionSelection;
}

/** What a mid-turn model switch would do, and whether it can be done. */
export type ModelSwitchPlan =
  | { ok: true; target: ModelSwitchTarget }
  | { ok: false; problem: string };

/** What a switch asks for, and what the turn runs on right now. */
export interface ModelSwitchInput {
  /** The model the turn runs on right now. */
  currentModel: string;
  /**
   * The id of the provider the turn runs on right now, or `null` when it
   * has none.
   */
  currentProviderId: string | null;
  /** The switch's new main model, or `undefined` when it does not change it. */
  model?: string | undefined;
  /** The switch's new provider id, or `undefined` when it does not change it. */
  providerId?: string | undefined;
  /**
   * The switch's new compaction selection, or `undefined` when the switch
   * leaves the compaction alone.
   */
  compaction?: CompactionSelection | undefined;
  /** The compaction selection the turn runs on right now. */
  currentCompaction: CompactionSelection;
}

/**
 * What a mid-turn model switch would do, and whether it can be done.
 *
 * A switch names a MODEL, a PROVIDER and a COMPACTION selection, and each of
 * them forms a (model, provider) PAIR. The pair is only coherent if the
 * provider actually carries the model, so the switch is put through exactly
 * the checks a new turn is put through: the main pair through
 * {@link configProblemFor} and the compaction pair through
 * {@link compactionProblemFor} - both against the pair the switch WOULD
 * form, not the one the turn has now.
 *
 * THE WHOLE SWITCH IS REFUSED when any of its pairs is incoherent. A
 * half-applied switch is the ambiguity this rule exists to avoid: the turn
 * would run on one model and compact with another, and neither would match
 * what the user asked for. The refusal keeps the turn alive - a running
 * turn must not die (CONFIRMATIONS C-027) - by leaving the turn exactly as
 * it was.
 *
 * THE TARGET PROVIDER. The provider the switch names, resolved BY ID ONLY -
 * a model name must never cross-wire another provider's endpoint and apiKey
 * into this turn; otherwise the provider the turn ALREADY runs on, because
 * a switch that names no provider moves the MODEL, not the endpoint;
 * otherwise, with no provider at all, the model name is the only hint there
 * is.
 *
 * WHY THE TURN DECIDES AND NOT THE ROUTE. The turn knows what it runs on
 * RIGHT NOW - the model, the provider and the compaction selection it is
 * actually using - and only the turn can say whether an `inherit-default`
 * compaction would inherit the provider the switch moves it to. The route
 * (`/api/chat/switch-model`) only has the request, so a route-side check
 * would have to guess the live pair: a false refusal, or a missed one. This
 * is the same decision C-027 already makes in the turn (a switch onto an
 * unresolvable provider is refused there, not in the route).
 *
 * `unknown` from the model index NEVER refuses: a cold cache, a failed
 * fetch and an empty list all let the switch through, because a dead or
 * slow provider must not block a turn. The checks themselves kick the
 * background refresh, so the NEXT switch can ask the question.
 */
export function planModelSwitch(config: Config | null, input: ModelSwitchInput): ModelSwitchPlan {
  if (config === null) {
    return {
      ok: false,
      problem:
        'The saved configuration could not be read, so there is no provider to switch to. Check config.json and try again.',
    };
  }

  // The MODEL the switch would run on. An empty model means "the model the
  // turn already runs on" (the route drops an empty one).
  const requestedModel = typeof input.model === 'string' ? input.model.trim() : '';
  const targetModel = requestedModel === '' ? input.currentModel : requestedModel;

  // The COMPACTION selection the switch would use: the switch replaces it
  // WHOLE, and a switch that names none leaves the current one alone.
  const targetCompaction = input.compaction ?? input.currentCompaction;

  // The PROVIDER the switch would run on. A blank id is "no id": the route
  // drops one, and `resolveProvider` treats `''` as falsy and falls through
  // to the MODEL-NAME step - the cross-wire C-027 removed everywhere else.
  const requestedProviderId = typeof input.providerId === 'string' ? input.providerId.trim() : '';
  const targetProviderId =
    requestedProviderId === '' ? input.currentProviderId : requestedProviderId;
  const provider =
    targetProviderId !== null && targetProviderId !== undefined
      ? resolveProvider(config, targetProviderId)
      : resolveProvider(config, undefined, targetModel);
  if (provider === null) {
    return {
      ok: false,
      problem:
        targetProviderId !== null && targetProviderId !== undefined
          ? switchProviderNotConfiguredMessage(targetProviderId)
          : MODEL_NOT_CHOSEN_MESSAGE,
    };
  }

  // The MAIN pair: the model the turn would run on, on the provider it
  // would run on. The same check a new turn is put through.
  const mainProblem = configProblemFor(config, provider.id, targetModel);
  if (mainProblem !== null) {
    return { ok: false, problem: mainProblem };
  }

  // The COMPACTION pair, checked against the pair the switch WOULD form: an
  // explicit selection against its own provider, "same as main" against the
  // new main pair, and an inherited global pair against the global provider
  // - or, when there is none, against the provider the turn would run on.
  // That last case is the one that sent "beam" to NVIDIA (CONFIRMATIONS
  // C-025: 221 failures in 14 minutes).
  const compactionProblem = compactionProblemFor(config, {
    mainModel: targetModel,
    mainProvider: provider,
    // The provider is the one the switch WOULD move the turn to, and the
    // switch is refused, so the message must not call it the one the
    // conversation uses.
    mainProviderRole: 'switch-target',
    compaction: targetCompaction,
  });
  if (compactionProblem !== null) {
    return { ok: false, problem: compactionProblem };
  }

  return {
    ok: true,
    target: { model: targetModel, provider, compaction: targetCompaction },
  };
}
