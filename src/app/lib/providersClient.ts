import type { LlmProvider } from '@/types/chatConfig';

import { type ProviderFormFields, providerRequestBody } from '@/app/lib/providerForm';

/** A provider as `POST /api/providers` returns it. It never carries the key. */
export interface AddedProvider {
  id: string;
  name: string;
  provider: LlmProvider;
  baseUrl: string;
  model?: string;
}

export type AddProviderResult =
  | { ok: true; provider: AddedProvider }
  | { ok: false; message: string };

/**
 * Save a new provider on the server (`POST /api/providers`).
 *
 * The server refusal comes back as `{ ok: false }` with its reason. A network
 * failure is not caught here: the caller shows it, the same as any other
 * thrown error.
 */
export async function postNewProvider(fields: ProviderFormFields): Promise<AddProviderResult> {
  const response = await fetch('/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(providerRequestBody(fields)),
  });
  const data: { error?: unknown; provider?: unknown } | null = await response
    .json()
    .catch(() => null);
  if (!response.ok || !data?.provider) {
    return {
      ok: false,
      message:
        typeof data?.error === 'string'
          ? data.error
          : `The provider could not be added (HTTP ${response.status}).`,
    };
  }
  return { ok: true, provider: data.provider as AddedProvider };
}
