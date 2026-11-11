/**
 * tokenCalibration.ts
 *
 * An IN-MEMORY correction factor between the token count Locopilot ESTIMATES
 * and the token count the PROVIDER reports for the same request.
 *
 * WHY THIS EXISTS
 *
 * Locopilot counts tokens with tiktoken (`src/services/tokenizer.ts`).
 * `encoding_for_model(model)` THROWS for a model name tiktoken does not know
 * (verified for `llama3` and `qwen3:8b`), and the tokenizer then falls back to
 * `cl100k_base`. That fallback measures roughly 4.5 characters per token on
 * English prose, while the Llama and Qwen tokenizers are denser (roughly
 * 3–3.5 characters per token) — so the SAME TEXT is worth 10–20 % MORE tokens
 * to the model than the estimate says. At a 1M-token context window that is a
 * 100 000–200 000-token blind spot in the compaction trigger, the acceptance
 * check, the overflow warning, the receipt and the chunker: the app believes it
 * has room it does not have, and the request 400s (or the reply overflows)
 * exactly where the window is supposed to be safe.
 *
 * WHAT THE FACTOR IS — AND WHAT IT IS NOT
 *
 * The factor is an EMPIRICAL REQUEST-SIZE RATIO: "how many tokens did the
 * provider count for the request we sent, divided by how many tokens we
 * counted for it". It is NOT a tokenizer ratio and NOT a vocabulary ratio: the
 * provider counts the system prompt, the tool schemas, its own chat-template
 * framing and its per-message framing, and the ratio absorbs all of that
 * because that is exactly what the app needs to know — how big the request
 * will actually be.
 *
 * THE FACTOR IS NEVER ALLOWED BELOW 1, AND THAT IS THE WHOLE POINT.
 *
 * A factor below 1 says "the request was CHEAPER than we counted", which
 * makes the app believe it has MORE room than it has — the one direction that
 * turns a mis-estimate into an overflow, a 400, or a silent loss of the
 * compaction. So the floor is 1, not something below it:
 *
 *   - a sample whose ratio is below 1 is REJECTED outright (we only ever
 *     learn "we under-counted");
 *   - the factor itself is clamped to `[1, 3]`, so no sequence of samples
 *     can push it below 1 either.
 *
 * Over-counting is the safe direction: Locopilot may think the window is
 * fuller than it is (it compacts early, it warns early), but it will never
 * think it has room it does not have.
 *
 * WHY THE TOOL SCHEMAS ARE NOT SUBTRACTED FROM THE PROVIDER'S COUNT
 *
 * The provider's prompt count INCLUDES the tool schemas; our count of the
 * messages does not. Subtracting OUR cl100k estimate of the schemas from the
 * provider's number used to make the ratio a "like for like" comparison — but
 * our estimate of the schemas is a guess (the provider may count them
 * differently, or not count them at all), and a guess that is too large
 * shrinks the numerator until the ratio falls below 1 — the dangerous
 * direction, through the back door. So the subtraction is GONE: the tool
 * schemas inflate the numerator instead, the ratio is ≥ 1 by construction, and
 * the learned factor is CONSERVATIVE (it over-states the cost of a
 * conversation, because it also carries the cost of the tool list).
 *
 * WHY THE CACHE IS KEYED BY PROVIDER + MODEL + REQUEST CLASS
 *
 * The vocabulary belongs to the MODEL: two providers that serve the same model
 * run the same tokenizer. But the FRAMING does not: a request's cost is its
 * text PLUS its per-message framing, and the framing is a function of the
 * request's SHAPE. Our own per-message charge is 4 tokens plus the role name;
 * the provider's chat template charges roughly 8–10 per message. A chatty
 * request (many short messages) therefore has a much bigger framing share
 * than a request that is one big blob (the summariser's input, the
 * distiller's input), and a single per-model factor drifts between ≈1.2 and
 * ≈1.6 depending on which shape was sampled last. One number cannot be right
 * for both.
 *
 * So the key is `providerId|model|class`:
 *
 *   - the PROVIDER, because Ollama's Modelfile and llama.cpp's template put
 *     different framing around the same model, and both report prompt counts;
 *   - the MODEL, because the vocabulary is the model's;
 *   - the CLASS, because the framing belongs to the request's shape.
 *
 * The user's requirement — a per-model cache — is satisfied and sharpened:
 * the vocabulary is per model, the framing is per request class. A chat
 * sample and a summarise sample for the same model teach two different
 * numbers, and neither can contaminate the other.
 *
 * WHEN THE PROVIDER CHANGES
 *
 * A factor measured against one provider's chat template says nothing about
 * another's. So the (model, class) slot keeps ONE live provider at a time: a
 * sample from a different provider DROPS the previous provider's entry instead
 * of blending the two, and the new provider's factor is learned from scratch.
 *
 * WHY IN MEMORY
 *
 * The cache is IN MEMORY and never persisted: a calibration is only
 * meaningful for the running process (a provider's accounting can change
 * under a deployment), and a persisted factor would outlive the model it was
 * measured against.
 *
 * COLD START IS BIT-IDENTICAL TO BEFORE
 *
 * With no samples the factor is 1, so every count is exactly what the
 * tokenizer said. The calibration can only ever move a count once a real
 * request has been measured, and a hostile or unrepresentative sample can
 * never move it more than the clamp allows — and never below 1.
 *
 * PINNING
 *
 * While a model is pinned, {@link recordTokenCalibrationSample} QUEUES its
 * samples instead of applying them, and the factor does not move.
 * {@link unpinTokenCalibration} applies the queued samples in order. This is
 * what makes "did the history shrink?" reproducible: the compaction compares a
 * BEFORE count with an AFTER count, and a second tab that happened to finish a
 * request in between must not be able to change the factor between them.
 *
 * THIS MODULE DOES NOT IMPORT THE TOKENIZER. The dependency is one-way
 * (`tokenizer.ts` imports this module) so that the sampler can ask for the RAW
 * count of exactly what was sent without a cycle.
 */

/**
 * The shape of the request a sample was taken from.
 *
 * The class is part of the cache key because the provider's framing cost per
 * request depends on the request's SHAPE, not only on its text.
 */
export type TokenCalibrationClass = 'chat' | 'summarise' | 'distill';

/** Every request class, in the order they are listed in the docs. */
export const TOKEN_CALIBRATION_CLASSES: readonly TokenCalibrationClass[] = [
  'chat',
  'summarise',
  'distill',
];

/**
 * The class a sample is filed under when it does not declare one.
 *
 * WHY a one-blob request is the default: a request whose shape we cannot
 * classify must not be allowed to contaminate the `chat` class, whose factor
 * is the one the window checks depend on. A single-blob request (a system
 * prompt and one big user message) has the SMALLEST framing share of any
 * request shape, so its ratio is the closest to the pure vocabulary ratio —
 * the `distill` class is exactly that shape, and filing an unclassified
 * sample there keeps it out of the class that matters.
 */
export const TOKEN_CALIBRATION_DEFAULT_CLASS: TokenCalibrationClass = 'distill';

/**
 * The provider id used when a sample arrives without one.
 *
 * It is a real key like any other, so a sample with no provider simply
 * shares the `unknown` bucket with the other provider-less samples.
 */
export const TOKEN_CALIBRATION_UNKNOWN_PROVIDER = 'unknown';

/** The calibration known for one model and request class. */
export interface TokenCalibration {
  /**
   * The multiplier applied to a RAW token count.
   *
   * `1` means "the tokenizer is right"; `1.25` means the request is a quarter
   * bigger than the tokenizer said. It is NEVER below 1 — see the module
   * header.
   */
  factor: number;
  /** How many samples have been APPLIED to this entry. */
  samples: number;
  /** When the entry was last changed (epoch milliseconds; 0 when cold). */
  updatedAt: number;
  /**
   * The provider that reported the last accepted sample.
   *
   * Diagnostics — the cache is keyed on the provider id too, because the
   * framing belongs to the provider's chat template.
   */
  provider?: string;
  /** The model this entry belongs to. Diagnostics. */
  model?: string;
  /** The request class this entry belongs to. Diagnostics. */
  class?: TokenCalibrationClass;
}

/** One measurement: what we thought a request cost, and what it really cost. */
export interface TokenCalibrationSample {
  /** The model the request was sent to. */
  model: string;
  /** The provider that reported the count — part of the cache key. */
  provider?: string;
  /**
   * The shape of the request the sample was taken from.
   *
   * `undefined` files the sample under
   * {@link TOKEN_CALIBRATION_DEFAULT_CLASS}.
   */
  class?: TokenCalibrationClass;
  /** OUR raw count of exactly what was sent (no calibration applied). */
  estimatedTokens: number;
  /** The provider's PROMPT count for that same request. */
  authoritativeTokens: number;
  /**
   * ACCEPTED AND IGNORED.
   *
   * This used to be subtracted from {@link authoritativeTokens} so the ratio
   * would compare like with like. It is not subtracted any more: our
   * estimate of the tool schemas is a guess, and a guess that is too large
   * drives the ratio below 1 — the direction in which the app believes it
   * has room it does not have. The field is kept so that a caller that still
   * passes it compiles; it has no effect on the factor.
   */
  overheadTokens?: number;
  /**
   * Whether the request carried images.
   *
   * A request with images is never sampled: our `IMAGE_TOKEN_ESTIMATE` is a
   * flat guess, not the provider's real image cost, so the ratio would be
   * measuring the wrong thing.
   */
  hasImages?: boolean;
}

/**
 * The smallest factor a calibration may hold, and the largest.
 *
 * WHY the floor is 1 and not something below it: a factor below 1 says the
 * request was CHEAPER than the tokenizer thought, which makes the app believe
 * it has MORE room than it has — the one direction that turns a mis-estimate
 * into an overflow. The floor is the backstop for that, and the ceiling is
 * the backstop for a provider that counts a request as many times bigger than
 * it really is.
 */
export const TOKEN_CALIBRATION_MIN_FACTOR = 1;
export const TOKEN_CALIBRATION_MAX_FACTOR = 3;

/**
 * The smallest request a sample may be taken from.
 *
 * WHY a floor: below a couple of thousand tokens the FIXED overheads (the
 * chat-template framing, the per-message framing, the provider's own padding)
 * dominate the ratio, so a small request would teach the calibration that
 * every request costs several times what it costs. A sample has to be big
 * enough for the variable part to be the thing being measured.
 */
export const TOKEN_CALIBRATION_MIN_SAMPLE_TOKENS = 2000;

/**
 * The weight of one sample in the exponential moving average.
 *
 * WHY damped and not a straight average: one request is one measurement of a
 * moving target (the history grows, the tools change, the provider's
 * accounting shifts). A quarter-weight means a single unusual request moves
 * the factor by a quarter of the gap and then decays away, instead of taking
 * the calibration over.
 */
export const TOKEN_CALIBRATION_SAMPLE_WEIGHT = 0.25;

/** The calibration of a model nobody has measured yet. */
const COLD_CALIBRATION: TokenCalibration = Object.freeze({
  factor: 1,
  samples: 0,
  updatedAt: 0,
});

/**
 * The calibration of every (provider, model, class) that has been measured.
 *
 * The key is {@link cacheKey}.
 */
const calibrationCache = new Map<string, TokenCalibration>();

/**
 * Which provider is LIVE for a (model, class) slot.
 *
 * The key is {@link slotKey}. A slot holds one provider's factor at a time: a
 * sample from a different provider drops the old entry rather than blending
 * two different chat templates into one number.
 */
const liveProviderBySlot = new Map<string, string>();

/** How many times each model is currently pinned (the compaction nests). */
const pinDepth = new Map<string, number>();

/** The samples recorded while a model was pinned, waiting for the unpin. */
const pendingSamples = new Map<string, TokenCalibrationSample[]>();

/**
 * The cache key of one entry: provider + model + request class.
 *
 * @param providerId - the provider that reported the count.
 * @param model      - the model the request went to.
 * @param requestClass - the shape of the request.
 * @returns {string} the key.
 */
function cacheKey(providerId: string, model: string, requestClass: TokenCalibrationClass): string {
  return `${providerId}|${model}|${requestClass}`;
}

/**
 * The key of the (model, class) slot — the pair that has ONE live provider.
 *
 * @param model - the model.
 * @param requestClass - the shape of the request.
 * @returns {string} the slot key.
 */
function slotKey(model: string, requestClass: TokenCalibrationClass): string {
  return `${model}|${requestClass}`;
}

function clampFactor(value: number): number {
  return Math.min(TOKEN_CALIBRATION_MAX_FACTOR, Math.max(TOKEN_CALIBRATION_MIN_FACTOR, value));
}

/**
 * The ratio a sample claims, or `null` when the sample must be rejected.
 *
 * The admission rules live here so that the same rules apply to a sample
 * taken while a model is pinned and to one applied at the unpin.
 *
 * NOTE: the sample's `overheadTokens` is NOT subtracted — see the module
 * header. The ratio is the provider's count over OUR count of the messages,
 * full stop.
 */
function computeSampleRatio(sample: TokenCalibrationSample): number | null {
  if (sample.hasImages === true) {
    return null;
  }
  const estimated = sample.estimatedTokens;
  if (!Number.isFinite(estimated) || estimated < TOKEN_CALIBRATION_MIN_SAMPLE_TOKENS) {
    return null;
  }
  const authoritative = sample.authoritativeTokens;
  if (!Number.isFinite(authoritative) || authoritative <= 0) {
    return null;
  }
  const ratio = authoritative / estimated;
  if (!Number.isFinite(ratio)) {
    return null;
  }
  // A ratio below 1 is REJECTED, not clamped: it means the provider counted
  // the request as cheaper than we did, and the only thing we are allowed to
  // learn from that is "we must not shrink the count".
  if (ratio < TOKEN_CALIBRATION_MIN_FACTOR || ratio > TOKEN_CALIBRATION_MAX_FACTOR) {
    return null;
  }
  return ratio;
}

/**
 * The provider a sample came from.
 *
 * @param sample - the sample.
 * @returns {string} the provider id.
 */
function sampleProviderId(sample: TokenCalibrationSample): string {
  return sample.provider ?? TOKEN_CALIBRATION_UNKNOWN_PROVIDER;
}

/**
 * The request class a sample is filed under.
 *
 * @param sample - the sample.
 * @returns {TokenCalibrationClass} the class.
 */
function sampleClass(sample: TokenCalibrationSample): TokenCalibrationClass {
  return sample.class ?? TOKEN_CALIBRATION_DEFAULT_CLASS;
}

/**
 * The entry for one (provider, model, class), or the cold calibration.
 *
 * @param providerId - the provider.
 * @param model - the model.
 * @param requestClass - the request class.
 * @returns {TokenCalibration} the entry.
 */
function readEntry(
  providerId: string,
  model: string,
  requestClass: TokenCalibrationClass
): TokenCalibration {
  return calibrationCache.get(cacheKey(providerId, model, requestClass)) ?? COLD_CALIBRATION;
}

/**
 * Applies one accepted sample to a calibration.
 *
 * The update is a damped exponential moving average towards the sample's
 * ratio, clamped to the factor bounds. Damping is what keeps ONE unusual
 * request from taking the calibration over; the clamp is what keeps a
 * sequence of unusual requests from taking it outside the bounds.
 *
 * The sample's provider becomes the LIVE provider of its (model, class) slot;
 * a different provider's entry is DROPPED, because a factor measured against
 * one chat template says nothing about another's.
 */
function applySample(
  sample: TokenCalibrationSample,
  ratio: number,
  providerId: string,
  requestClass: TokenCalibrationClass
): TokenCalibration {
  const slot = slotKey(sample.model, requestClass);
  const liveProvider = liveProviderBySlot.get(slot);
  if (liveProvider !== undefined && liveProvider !== providerId) {
    calibrationCache.delete(cacheKey(liveProvider, sample.model, requestClass));
  }
  liveProviderBySlot.set(slot, providerId);

  const current = readEntry(providerId, sample.model, requestClass);
  const next: TokenCalibration = {
    factor: clampFactor(
      current.factor + TOKEN_CALIBRATION_SAMPLE_WEIGHT * (ratio - current.factor)
    ),
    samples: current.samples + 1,
    updatedAt: Date.now(),
    provider: providerId,
    model: sample.model,
    class: requestClass,
  };
  calibrationCache.set(cacheKey(providerId, sample.model, requestClass), next);
  return next;
}

/**
 * The calibration known for a model and request class.
 *
 * A model nobody has measured yet is COLD: factor 1, no samples, never
 * updated. The cold entry is not stored — only a real sample creates one.
 *
 * @param model        - the model.
 * @param requestClass - the shape of the request; defaults to `chat`.
 * @returns {TokenCalibration} the calibration.
 */
export function getTokenCalibration(
  model: string,
  requestClass: TokenCalibrationClass = 'chat'
): TokenCalibration {
  const providerId = liveProviderBySlot.get(slotKey(model, requestClass));
  if (providerId === undefined) {
    return COLD_CALIBRATION;
  }
  return readEntry(providerId, model, requestClass);
}

/**
 * The factor for a model and request class — 1 while the model is cold.
 *
 * This is what every calibrated count multiplies by.
 *
 * @param model        - the model.
 * @param requestClass - the shape of the request; defaults to `chat`.
 * @returns {number} the factor.
 */
export function getTokenCalibrationFactor(
  model: string,
  requestClass: TokenCalibrationClass = 'chat'
): number {
  return getTokenCalibration(model, requestClass).factor;
}

/**
 * Records one measurement and returns the calibration afterwards.
 *
 * Returns `null` when the sample was REJECTED — it was too small, it carried
 * images, the provider reported nothing, or its ratio fell outside the
 * accepted band (below 1, or above the ceiling). A rejected sample changes
 * nothing.
 *
 * While the model is PINNED the sample is QUEUED rather than applied, and the
 * returned calibration is the unchanged one.
 *
 * @param sample - the measurement.
 * @returns {TokenCalibration | null} the calibration, or `null` if rejected.
 */
export function recordTokenCalibrationSample(
  sample: TokenCalibrationSample
): TokenCalibration | null {
  if (!sample || typeof sample.model !== 'string' || sample.model.length === 0) {
    return null;
  }
  const ratio = computeSampleRatio(sample);
  if (ratio === null) {
    return null;
  }
  const providerId = sampleProviderId(sample);
  const requestClass = sampleClass(sample);
  const depth = pinDepth.get(sample.model) ?? 0;
  if (depth > 0) {
    const queued = pendingSamples.get(sample.model);
    if (queued) {
      queued.push(sample);
    } else {
      pendingSamples.set(sample.model, [sample]);
    }
    return readEntry(providerId, sample.model, requestClass);
  }
  return applySample(sample, ratio, providerId, requestClass);
}

/**
 * Applies a model's factor to a raw token count.
 *
 * With a cold model this is the identity (up to rounding), which is what
 * keeps the change bit-identical until a real request has been measured.
 *
 * @param model        - the model.
 * @param tokens       - the raw token count.
 * @param requestClass - the shape of the request; defaults to `chat`.
 * @returns {number} the calibrated count.
 */
export function applyTokenCalibration(
  model: string,
  tokens: number,
  requestClass: TokenCalibrationClass = 'chat'
): number {
  if (!Number.isFinite(tokens)) {
    return tokens;
  }
  return Math.round(tokens * getTokenCalibrationFactor(model, requestClass));
}

/**
 * Freezes a model's factor.
 *
 * Samples recorded while the model is pinned are queued rather than applied,
 * so the factor cannot move underneath a comparison that is already under
 * way. Pins NEST: the compaction's retry pass pins the same model again, and
 * only the LAST unpin releases the factor.
 *
 * @param model - the model to freeze.
 */
export function pinTokenCalibration(model: string): void {
  pinDepth.set(model, (pinDepth.get(model) ?? 0) + 1);
}

/**
 * Releases a model's factor and applies the samples that were queued while it
 * was pinned, in the order they were recorded.
 *
 * A model that is not pinned is left alone — an unpin without a pin must not
 * apply anything.
 *
 * @param model - the model to release.
 */
export function unpinTokenCalibration(model: string): void {
  const depth = pinDepth.get(model) ?? 0;
  if (depth <= 0) {
    return;
  }
  const remaining = depth - 1;
  if (remaining > 0) {
    pinDepth.set(model, remaining);
    return;
  }
  pinDepth.delete(model);
  const queued = pendingSamples.get(model);
  pendingSamples.delete(model);
  if (!queued) {
    return;
  }
  for (const sample of queued) {
    const ratio = computeSampleRatio(sample);
    if (ratio === null) {
      continue;
    }
    applySample(sample, ratio, sampleProviderId(sample), sampleClass(sample));
  }
}

/**
 * Forgets the calibration of one model, or of every model.
 *
 * The cache is in-memory only, so this is what a test uses to get back to a
 * cold start. It also clears the pin and the queue, so a forgotten model
 * cannot inherit a pending sample.
 *
 * @param model - the model to forget; every model when omitted.
 */
export function resetTokenCalibration(model?: string): void {
  if (model === undefined) {
    calibrationCache.clear();
    liveProviderBySlot.clear();
    pinDepth.clear();
    pendingSamples.clear();
    return;
  }
  // Deleting the CURRENT key while iterating a Map is safe (the iterator
  // skips the entries that are gone), so no copy of the keys is needed.
  for (const key of calibrationCache.keys()) {
    const [, entryModel] = key.split('|');
    if (entryModel === model) {
      calibrationCache.delete(key);
    }
  }
  for (const key of liveProviderBySlot.keys()) {
    const [slotModel] = key.split('|');
    if (slotModel === model) {
      liveProviderBySlot.delete(key);
    }
  }
  pinDepth.delete(model);
  pendingSamples.delete(model);
}

/**
 * Overwrites a model's calibration outright.
 *
 * The test seam: it lets a suite put a model at a known factor without
 * having to reach that factor through a sequence of samples. The factor is
 * still clamped to the band, so the seam cannot be used to smuggle in a
 * factor below 1 — the "never under-count" guarantee holds on every path.
 *
 * @param model        - the model.
 * @param calibration  - the calibration to write.
 * @param requestClass - the request class; defaults to `chat`.
 */
export function setTokenCalibration(
  model: string,
  calibration: TokenCalibration,
  requestClass: TokenCalibrationClass = 'chat'
): void {
  const providerId =
    liveProviderBySlot.get(slotKey(model, requestClass)) ?? TOKEN_CALIBRATION_UNKNOWN_PROVIDER;
  liveProviderBySlot.set(slotKey(model, requestClass), providerId);
  calibrationCache.set(cacheKey(providerId, model, requestClass), {
    ...calibration,
    factor: clampFactor(calibration.factor),
    model,
    class: requestClass,
  });
}
