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
 *   1. The conversation's own pin wins (`sessionCompactionModel` +
 *      `sessionCompactionProviderId`, which travel together).
 *   2. Otherwise the global default applies: the global compaction model
 *      with the global compaction provider.
 *   3. Otherwise the conversation's own main model, on the MAIN provider.
 *
 * The PROVIDER follows the MODEL's source, with one exception: the
 * conversation's OWN provider pin always wins.
 *   - a conversation pinned "the main model" (`''`) runs on the main provider
 *     — the same model AND the same provider as the chat;
 *   - a conversation that pinned a compaction provider runs there, whatever
 *     model it ends up with (that is what the pin is for);
 *   - a conversation that inherits the global model runs on the global
 *     provider;
 *   - a conversation that pinned a model of its own but no provider runs on
 *     the global provider only when the global provider serves that very same
 *     model, and on the main provider otherwise;
 *   - a conversation with no compaction model at all runs on the main
 *     provider.
 *
 * The one rule this never breaks: a model is never handed to a provider that
 * was pinned for a DIFFERENT model. A global compaction model served by
 * provider A must not become "model A at provider B" (a 404), which is how
 * the compaction calls ended up at NVIDIA in the first place.
 *
 * WHY this file has NO imports: the rule is needed in two places with
 * incompatible module graphs. The server needs it with the saved config and
 * the provider list (`src/services/compactionSelection.ts`); the browser
 * needs it to show which model and provider a conversation will actually
 * compact with (`ModelSelector`, `ReasoningEffortSelector`, `StatusBar`).
 * The server-side composer imports the provider resolver, which pulls in the
 * LLM adapters and their HTTP client — far too heavy for a browser bundle.
 * So the RULE lives here, dependency-free, and both sides call it. There is
 * still exactly one copy of the rule; only the config lookup around it is
 * server-side.
 */

/** Where the compaction MODEL came from. */
export type CompactionModelSource =
  /** The conversation pinned a compaction model. */
  | 'session'
  /** The conversation pinned "the conversation's own main model" (`''`). */
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
   * The conversation's own compaction model.
   *
   * - `null` / `undefined` — inherit the global default.
   * - `''` — the conversation's own main model.
   * - a name — that model.
   *
   * The value is TRIMMED, so a whitespace-only pin trims into the empty pin
   * ("same as the conversation's own main model"). That is the safe
   * direction: an empty pin can never send a model to an endpoint that does
   * not serve it.
   */
  sessionCompactionModel?: string | null | undefined;
  /**
   * The conversation's own compaction provider. `null` / `undefined` means
   * "not pinned".
   */
  sessionCompactionProviderId?: string | null | undefined;
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
    sessionCompactionModel: sessionModelRaw,
    sessionCompactionProviderId: sessionProviderIdRaw,
    globalCompactionModel: globalModelRaw,
    globalCompactionProviderId: globalProviderIdRaw,
  } = input;
  const sessionModel = typeof sessionModelRaw === 'string' ? sessionModelRaw.trim() : null;
  const sessionProviderId = trimmedOrEmpty(sessionProviderIdRaw);
  const globalModel = trimmedOrEmpty(globalModelRaw);
  const globalProviderId = trimmedOrEmpty(globalProviderIdRaw);

  // -- the model -----------------------------------------------------
  let model: string;
  let modelSource: CompactionModelSource;
  if (sessionModel === '') {
    // "The conversation's own main model". Deliberately NOT the global
    // default: an explicit "same as main" outranks the global default.
    model = mainModel;
    modelSource = 'session-main';
  } else if (sessionModel !== null) {
    model = sessionModel;
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
  // that was pinned for a different one. The conversation's own pin wins
  // outright: it is a deliberate per-conversation choice, and it is what
  // the chat route has always honoured.
  let providerId: string | null = null;
  let providerSource: CompactionProviderSource = 'main';
  if (modelSource === 'session-main') {
    // "Same as the conversation's own main model" means the same MODEL *and*
    // the same PROVIDER. The UI writes this pair as one choice, so a
    // provider pinned alongside it does not exist.
    providerId = null;
    providerSource = 'main';
  } else if (sessionProviderId !== '') {
    providerId = sessionProviderId;
    providerSource = 'session';
  } else if (modelSource === 'global') {
    // The global pair travels together: the global model runs on the global
    // provider, and on the main provider when no global provider is set.
    if (globalProviderId !== '') {
      providerId = globalProviderId;
      providerSource = 'global';
    }
  } else if (modelSource === 'session' && // The conversation pinned a model but no provider of its own. The global
    // pair's provider may only be used when it serves THIS model.
    globalProviderId !== '' && globalModel !== '' && model === globalModel) {
      providerId = globalProviderId;
      providerSource = 'global';
    }

  return { model, providerId, modelSource, providerSource };
}
