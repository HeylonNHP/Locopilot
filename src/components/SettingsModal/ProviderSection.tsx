'use client';
import { type FormEvent, useId, useState } from 'react';

import type { LlmProvider } from '@/types/chatConfig';

import { useChat } from '@/app/lib/chatStore';
import { fetchModelList } from '@/app/lib/modelsClient';
import {
  type AddedProviderNote,
  baseUrlHint,
  baseUrlPlaceholder,
  describeAddedProvider,
  emptyProviderForm,
  PROVIDER_KIND_OPTIONS,
  type ProviderFormErrors,
  type ProviderFormFields,
  providerKindLabel,
  providerRequestBody,
  validateProviderForm,
} from '@/app/lib/providerForm';

interface Props {
  /**
   * Called after a provider is saved and the model list has been fetched again.
   * `model` is the provider's default model, and only when the provider listed
   * it, so the caller never selects a model that is not in the dropdown.
   */
  onProviderAdded: (providerId: string, model: string | undefined) => void;
}

/**
 * The providers Settings knows about, and a small form to add one.
 *
 * Adding saves the provider to `config.json` right away (`POST /api/providers`);
 * it does not wait for the Save button, which saves the other settings. The
 * list shows names and addresses only. A stored API key is never shown or sent
 * back to the page.
 */
export default function ProviderSection({ onProviderAdded }: Props) {
  const { state, dispatch } = useChat();
  const providers = state.providers ?? [];
  const idBase = useId();
  const [open, setOpen] = useState(providers.length === 0);
  const [fields, setFields] = useState<ProviderFormFields>(emptyProviderForm);
  const [errors, setErrors] = useState<ProviderFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [note, setNote] = useState<AddedProviderNote | null>(null);
  const [busy, setBusy] = useState(false);

  const setField = <K extends keyof ProviderFormFields>(key: K, value: ProviderFormFields[K]) => {
    setFields((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    const found = validateProviderForm(fields);
    setErrors(found);
    setSubmitError(null);
    setNote(null);
    if (Object.keys(found).length > 0) {
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(providerRequestBody(fields)),
      });
      const data: { error?: unknown; provider?: Record<string, unknown> } | null = await response
        .json()
        .catch(() => null);
      if (!response.ok || !data?.provider) {
        setSubmitError(
          typeof data?.error === 'string'
            ? data.error
            : `The provider could not be added (HTTP ${response.status}).`
        );
        return;
      }

      const added = data.provider as {
        id: string;
        name: string;
        provider: LlmProvider;
        baseUrl: string;
        model?: string;
      };
      dispatch({
        type: 'SET_PROVIDERS',
        providers: [
          ...providers,
          {
            id: added.id,
            name: added.name,
            provider: added.provider,
            baseUrl: added.baseUrl,
            ...(added.model ? { model: added.model } : {}),
          },
        ],
      });

      // The new provider's models: fetched again for every provider, the same
      // way the page loads them, so the dropdowns below show them.
      dispatch({ type: 'SET_MODELS_LOADING', modelsLoading: true });
      const list = await fetchModelList();
      if (list) {
        dispatch({ type: 'SET_MODELS', models: list.models });
      }
      dispatch({ type: 'SET_MODELS_LOADING', modelsLoading: false });

      setNote(describeAddedProvider(list, added.id, added.name));
      const listed =
        added.model !== undefined &&
        list?.models.some((m) => m.providerId === added.id && m.name === added.model) === true;
      onProviderAdded(added.id, listed ? added.model : undefined);
      setFields(emptyProviderForm());
      setOpen(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'The provider could not be added.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-providers">
      <div className="settings-label">Providers</div>

      {providers.length === 0 ? (
        <p className="settings-hint">
          No provider yet. Add one below, then choose a model to start chatting.
        </p>
      ) : (
        <ul className="settings-provider-list">
          {providers.map((p) => (
            <li key={p.id} className="settings-provider-item">
              <span>{p.name}</span>
              <span className="settings-provider-meta">
                {providerKindLabel(p.provider)} · {p.baseUrl}
              </span>
            </li>
          ))}
        </ul>
      )}

      {note && (
        <div
          className={note.kind === 'warn' ? 'settings-error' : 'settings-note'}
          role={note.kind === 'warn' ? 'alert' : 'status'}
        >
          {note.message}
        </div>
      )}

      {!open && (
        <button type="button" className="settings-btn-cancel" onClick={() => setOpen(true)}>
          Add provider
        </button>
      )}

      {open && (
        <form className="settings-provider-form" onSubmit={handleSubmit} noValidate>
          <div className="settings-grid">
            <div className="settings-row">
              <label className="settings-label" htmlFor={`${idBase}-name`}>
                Name
              </label>
              <input
                id={`${idBase}-name`}
                type="text"
                value={fields.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="For example: Local Ollama"
                autoComplete="off"
                className="settings-input"
              />
              {errors.name && <div className="settings-field-error">{errors.name}</div>}
            </div>

            <div className="settings-row">
              <label className="settings-label" htmlFor={`${idBase}-kind`}>
                Kind
              </label>
              <select
                id={`${idBase}-kind`}
                value={fields.provider}
                onChange={(e) => setField('provider', e.target.value as LlmProvider)}
                className="settings-input"
              >
                {PROVIDER_KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label" htmlFor={`${idBase}-url`}>
              Server address
            </label>
            <input
              id={`${idBase}-url`}
              type="text"
              value={fields.baseUrl}
              onChange={(e) => setField('baseUrl', e.target.value)}
              placeholder={baseUrlPlaceholder(fields.provider)}
              autoComplete="off"
              spellCheck={false}
              className="settings-input"
            />
            <div className="settings-hint">{baseUrlHint(fields.provider)}</div>
            {errors.baseUrl && <div className="settings-field-error">{errors.baseUrl}</div>}
          </div>

          <div className="settings-grid">
            <div className="settings-row">
              <label className="settings-label" htmlFor={`${idBase}-key`}>
                API key (optional)
              </label>
              <input
                id={`${idBase}-key`}
                type="password"
                value={fields.apiKey}
                onChange={(e) => setField('apiKey', e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="settings-input"
              />
            </div>

            <div className="settings-row">
              <label className="settings-label" htmlFor={`${idBase}-model`}>
                Model (optional)
              </label>
              <input
                id={`${idBase}-model`}
                type="text"
                value={fields.model}
                onChange={(e) => setField('model', e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="settings-input"
              />
            </div>
          </div>

          <div className="settings-hint">
            Adding saves the provider right away. The key is stored in config.json and is not shown
            again.
          </div>

          {submitError && (
            <div className="settings-error" role="alert">
              {submitError}
            </div>
          )}

          <div className="settings-inline-actions">
            {providers.length > 0 && (
              <button
                type="button"
                className="settings-btn-cancel"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setErrors({});
                  setSubmitError(null);
                }}
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={busy}
              className={`settings-btn-save ${
                busy ? 'settings-btn-save-disabled' : 'settings-btn-save-active'
              }`}
            >
              {busy ? 'Adding...' : 'Add provider'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
