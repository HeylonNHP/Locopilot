import type { LLmModel } from '@/app/lib/chatStore';

/** The aggregated model list, and the per-provider failures that came with it. */
export interface ModelList {
  models: LLmModel[];
  /** One entry per provider that did not answer, each starting `"<provider name>: "`. */
  errors: string[];
}

/**
 * Fetch the model list of every configured provider.
 *
 * `null` when the request fails or the server refuses (no provider yet, an
 * unreadable config). The caller keeps whatever list it already has: nothing
 * here throws, and nothing is written to the store.
 */
export async function fetchModelList(): Promise<ModelList | null> {
  try {
    const res = await fetch('/api/models');
    if (!res.ok) {
      return null;
    }
    const data: unknown = await res.json();
    const record = (typeof data === 'object' && data !== null ? data : {}) as {
      models?: unknown;
      errors?: unknown;
    };
    const raw = record.models ?? data;
    return {
      models: Array.isArray(raw) ? (raw as LLmModel[]) : [],
      errors: Array.isArray(record.errors)
        ? record.errors.filter((e): e is string => typeof e === 'string')
        : [],
    };
  } catch {
    return null;
  }
}
