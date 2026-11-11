/**
 * What the server reports about a model's context window.
 *
 * Shared by the resolver (`src/services/contextWindow/resolveNumCtx.ts`), the
 * `GET /api/numctx` route and the page. Types only, so the page can import it.
 */

/** Where a model maximum came from. */
export type ModelMaxSource = 'static' | 'llamacpp-loaded' | 'openai-models' | 'learned' | 'unknown';

/** What the server knows about one model's window. */
export interface NumCtxResolution {
  /** The user's setting (the provider's own, else the global one); null when unset. */
  requested: number | null;
  /** The model's maximum; null when it is not known. */
  modelMax: number | null;
  /** The window to plan with; null only when there is no setting. */
  effective: number | null;
  /** True when `modelMax` is known. When false the page says "model max unknown". */
  known: boolean;
  source: ModelMaxSource;
  /** Why the last probe failed (timeout, unreachable, …); null when it did not. */
  probeError: string | null;
}

/** The body of `GET /api/numctx`: the resolution plus what it was resolved for. */
export interface NumCtxResponse extends NumCtxResolution {
  providerId: string;
  model: string;
}
