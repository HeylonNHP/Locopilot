/**
 * Which model and which provider the COMPACTION calls run on — the rule
 * itself, with no dependencies.
 *
 * WHY this file exists: compaction used to be resolved in four places (the
 * chat route's preflight, the chat route's runtime, the compact route and the
 * title route) and the four did not agree. Two of them resolved the
 * compaction provider by ID *and* by model name, so a provider id that no
 * longer existed silently became "whatever provider owns that model name" —
 * with that provider's API key. The other two resolved by ID only, so the
 * same stale id silently became "the main chat provider". Both wrong
 * answers were invisible: the compaction call went somewhere the model does
 * not exist and came back 404, and the caller carried on.
 *
 * The rule now lives here, once:
 *
 *   1. The conversation's own selection wins — and it is ONE value with
 *      THREE states (`CompactionSelection`), so a model can never be pinned
 *      without the provider that serves it.
 *   2. Otherwise the global default applies: the global compaction model
 *      with the global compaction provider.
 *   3. Otherwise the conversation's own main model, on the MAIN provider.
 *
 * The PROVIDER follows the MODEL's source:
 *   - "the conversation's own main model" (`same-as-main`) runs on the main
 *     provider — the same model AND the same provider as the chat;
 *   - an EXPLICIT selection runs on the provider it names;
 *   - a conversation that inherits the global model runs on the global
 *     provider, or on the main provider when no global provider is set.
 *
 * The one rule this never breaks: a model is never handed to a provider that
 * was pinned for a DIFFERENT model. A global compaction model served by
 * provider A must not become "model A at provider B" (a 404), which is how
 * the compaction calls ended up at NVIDIA in the first place. The
 * conversation's own selection cannot break it either, because its model and
 * its provider are one value.
 *
 * WHY this file has (almost) no imports: the rule is needed in two places
 * with incompatible module graphs. The server needs it with the saved config
 * and the provider list (`src/services/compactionSelection.ts`); the browser
 * needs it to show which model and provider a conversation will actually
 * compact with (`ModelSelector`, `ReasoningEffortSelector`, `StatusBar`).
 * The server-side composer imports the provider resolver, which pulls in the
 * LLM adapters and their HTTP client — far too heavy for a browser bundle.
 * So the RULE lives here, runtime-dependency-free, and both sides call it.
 * There is still exactly one copy of the rule; only the config lookup around
 * it is server-side. The ONE import is a TYPE (`import type`), which the
 * compiler erases, so it costs the browser bundle nothing.
 */

import type { CompactionSelection } from './sessionSelection';

/** Where the compaction MODEL came from. */
export type CompactionModelSource =
  /** The conversation pinned a compaction model. */
  | 'session'
  /** The conversation pinned "the conversation's own main model" (`same-as-main`). */
  | 'session-main'
  /** The global default compaction model. */
  | 'global'
  /** Nothing was pinned: the conversation's own main model. */
  | 'main';

/** Where the compaction PROVIDER came from. */
export type CompactionProviderSource =
  /** The conversation pinned a compaction provider. */
  | 'session'
  /** The global default compaction provider. */
  | 'global'
  /** The main chat provider. */
  | 'main';

export interface CompactionRuleInput {
  /** The conversation's main model — the fallback when nothing is pinned. */
  mainModel: string;
  /**
   * The conversation's own compaction selection.
   *
   * ONE value with THREE states — see `CompactionSelection` in
   * `src/services/sessionSelection.ts`:
   * - `inherit-default` — use the global default pair;
   * - `same-as-main` — the conversation's own main model, on the main
   *   provider;
   * - `explicit` — a named model on a named provider.
   *
   * Absent or `null` means `inherit-default`.
   */
  sessionCompaction?: CompactionSelection | null | undefined;
  /**
   * The global default compaction model. `''` means "the conversation's own
   * main model", which is the same thing as no global default at all.
   */
  globalCompactionModel?: string | null | undefined;
  /**
   * The global default compaction provider — the provider that serves
   * {@link globalCompactionModel}. `null` / `undefined` means "the main chat
   * provider".
   */
  globalCompactionProviderId?: string | null | undefined;
}

export interface CompactionRuleResult {
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
}

function trimmedOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve the compaction selection from the pins alone.
 *
 * See the module comment for the rule. This function is pure: it reads the
 * pins and answers. It never probes a provider, never consults a provider
 * list and never falls back on its own — whether a pinned provider id names
 * a configured provider is a question only the server can answer, and it
 * lives in `src/services/compactionSelection.ts`.
 */
export function resolveCompactionRule(input: CompactionRuleInput): CompactionRuleResult {
  const {
    mainModel,
    sessionCompaction,
    globalCompactionModel: globalModelRaw,
    globalCompactionProviderId: globalProviderIdRaw,
  } = input;
  const session = sessionCompaction ?? { kind: 'inherit-default' };
  const globalModel = trimmedOrEmpty(globalModelRaw);
  const globalProviderId = trimmedOrEmpty(globalProviderIdRaw);

  // -- the model -----------------------------------------------------
  let model: string;
  let modelSource: CompactionModelSource;
  if (session.kind === 'same-as-main') {
    // "The conversation's own main model". Deliberately NOT the global
    // default: an explicit "same as main" outranks the global default.
    model = mainModel;
    modelSource = 'session-main';
  } else if (session.kind === 'explicit') {
    model = session.model;
    modelSource = 'session';
  } else if (globalModel === '') {
    model = mainModel;
    modelSource = 'main';
  } else {
    model = globalModel;
    modelSource = 'global';
  }

  // -- the provider --------------------------------------------------
  //
  // The provider is chosen so that a model is never handed to an endpoint
  // that was pinned for a different one. The conversation's own selection
  // wins outright: it is a deliberate per-conversation choice, and it names
  // the model AND the provider that serves it.
  let providerId: string | null = null;
  let providerSource: CompactionProviderSource = 'main';
  if (session.kind === 'same-as-main') {
    // "Same as the conversation's own main model" means the same MODEL *and*
    // the same PROVIDER. The selection carries no provider of its own.
    providerId = null;
    providerSource = 'main';
  } else if (session.kind === 'explicit') {
    providerId = session.providerId;
    providerSource = 'session';
  } else if (modelSource === 'global' && globalProviderId !== '') {
    // The global pair travels together: the global model runs on the global
    // provider, and on the main provider when no global provider is set.
    providerId = globalProviderId;
    providerSource = 'global';
  }

  return { model, providerId, modelSource, providerSource };
}
