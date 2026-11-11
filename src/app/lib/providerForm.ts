/**
 * The "Add provider" form in Settings: what it asks for, what it checks before
 * it asks the server, and what it says afterwards. All pure, so the rules are
 * pinned by tests/provider-add.test.mjs. The server validates again
 * (`src/services/providerValidation.ts`) and is the authority; this only saves
 * a round trip for the obvious mistakes.
 */

import type { ModelList } from '@/app/lib/modelsClient';
import type { LlmProvider } from '@/types/chatConfig';

export interface ProviderFormFields {
  name: string;
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ProviderFormErrors {
  name?: string;
  baseUrl?: string;
}

export const PROVIDER_KIND_OPTIONS: ReadonlyArray<{ value: LlmProvider; label: string }> = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
];

export function providerKindLabel(kind: LlmProvider): string {
  return PROVIDER_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

export function emptyProviderForm(): ProviderFormFields {
  return { name: '', provider: 'ollama', baseUrl: '', apiKey: '', model: '' };
}

/** An example address for the kind, shown as the field's placeholder. */
export function baseUrlPlaceholder(kind: LlmProvider): string {
  return kind === 'ollama' ? 'http://localhost:11434' : 'https://api.example.com';
}

/** One line under the address field that says what to enter. */
export function baseUrlHint(kind: LlmProvider): string {
  return kind === 'ollama'
    ? 'Where Ollama is running. Ollama Cloud is https://ollama.com.'
    : 'The server address without the /v1 part.';
}

/** The mistakes that are obvious without asking the server. Empty when there are none. */
export function validateProviderForm(fields: ProviderFormFields): ProviderFormErrors {
  const errors: ProviderFormErrors = {};
  if (fields.name.trim() === '') {
    errors.name = 'Enter a name for this provider.';
  }
  const url = fields.baseUrl.trim();
  if (url === '') {
    errors.baseUrl = 'Enter the server address.';
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.baseUrl = 'The address must start with http:// or https://.';
      }
    } catch {
      errors.baseUrl = `That is not a valid address. For example: ${baseUrlPlaceholder(fields.provider)}`;
    }
  }
  return errors;
}

/** The body of `POST /api/providers`. Optional fields are left out when blank. */
export function providerRequestBody(fields: ProviderFormFields): Record<string, string> {
  const apiKey = fields.apiKey.trim();
  const model = fields.model.trim();
  return {
    name: fields.name.trim(),
    provider: fields.provider,
    baseUrl: fields.baseUrl.trim(),
    ...(apiKey === '' ? {} : { apiKey }),
    ...(model === '' ? {} : { model }),
  };
}

export interface AddedProviderNote {
  /** `ok` is a plain confirmation; `warn` means the provider was saved but did not answer. */
  kind: 'ok' | 'warn';
  message: string;
}

/**
 * What to tell the user once the provider is saved and the model list has been
 * fetched again. The provider is saved either way (the server wrote it before
 * any model was asked for); this says whether it answered.
 */
export function describeAddedProvider(
  list: ModelList | null,
  providerId: string,
  providerName: string
): AddedProviderNote {
  if (list === null) {
    return {
      kind: 'warn',
      message: `"${providerName}" was added, but the model list could not be loaded. Reload the page to try again.`,
    };
  }
  const prefix = `${providerName}: `;
  const failure = list.errors.find((error) => error.startsWith(prefix));
  if (failure !== undefined) {
    return {
      kind: 'warn',
      message: `"${providerName}" was added, but it did not answer: ${failure.slice(prefix.length)}. Check the address and the key.`,
    };
  }
  const count = list.models.filter((model) => model.providerId === providerId).length;
  if (count === 0) {
    return {
      kind: 'warn',
      message: `"${providerName}" was added, but it listed no models. Check the address and the key.`,
    };
  }
  return {
    kind: 'ok',
    message: `"${providerName}" was added. ${count} ${count === 1 ? 'model' : 'models'} available; choose one below and press Save.`,
  };
}
