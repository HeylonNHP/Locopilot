'use client';
import { type FormEvent, useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { LlmProvider, ProviderConfig } from '@/types/chatConfig';

import { useModalOverlay } from '@/app/hooks/useModalOverlay';
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
  validateProviderForm,
} from '@/app/lib/providerForm';
import { postNewProvider } from '@/app/lib/providersClient';

import ProviderList from './ProviderList';

/** What the dialog reports once the provider is saved and the models are fetched again. */
export interface AddedProviderOutcome {
  providerId: string;
  /** The provider's default model, only when the provider listed it. */
  model: string | undefined;
  note: AddedProviderNote;
}

interface Props {
  onClose: () => void;
  onAdded: (outcome: AddedProviderOutcome) => void;
}

/**
 * A dialog over Settings that lists the configured providers and holds the
 * form that adds one.
 *
 * Adding saves the provider to `config.json` right away (`POST /api/providers`);
 * it does not wait for the Save button in Settings. Escape and the backdrop do
 * nothing while a save is in flight, so the outcome always reaches Settings.
 * The dialog is portaled to `body` and stacks above Settings (`--z-overlay`).
 */
export default function AddProviderDialog({ onClose, onAdded }: Props) {
  const { state, dispatch } = useChat();
  const providers = state.providers ?? [];
  const idBase = useId();
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [fields, setFields] = useState<ProviderFormFields>(emptyProviderForm);
  const [errors, setErrors] = useState<ProviderFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleDismiss = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  const panelRef = useModalOverlay<HTMLDivElement>({
    onClose: handleDismiss,
    initialFocusRef: nameRef,
  });

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
    if (Object.keys(found).length > 0) {
      return;
    }

    setBusy(true);
    try {
      const result = await postNewProvider(fields);
      if (!result.ok) {
        setSubmitError(result.message);
        return;
      }

      const added = result.provider;
      dispatch({
        type: 'SET_PROVIDERS',
        providers: [...providers, toProviderConfig(added)],
      });

      // The models of every provider are fetched again, the same way the page
      // loads them, so the Settings dropdowns show the new provider's models.
      dispatch({ type: 'SET_MODELS_LOADING', modelsLoading: true });
      const list = await fetchModelList();
      if (list) {
        dispatch({ type: 'SET_MODELS', models: list.models });
      }
      dispatch({ type: 'SET_MODELS_LOADING', modelsLoading: false });

      const listed =
        added.model !== undefined &&
        list?.models.some((m) => m.providerId === added.id && m.name === added.model) === true;
      onAdded({
        providerId: added.id,
        model: listed ? added.model : undefined,
        note: describeAddedProvider(list, added.id, added.name),
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'The provider could not be added.');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="settings-overlay provider-dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleDismiss();
      }}
    >
      <div
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
      >
        <div className="settings-scroll">
          <h3 id={titleId} className="settings-heading">
            Providers
          </h3>

          <ProviderList providers={providers} emptyText="No provider yet." />

          <form onSubmit={handleSubmit} noValidate>
            <div className="provider-dialog-divider" />
            <h4 className="provider-dialog-subheading">Add a provider</h4>

            <div className="settings-grid">
              <div className="settings-row">
                <label className="settings-label" htmlFor={`${idBase}-name`}>
                  Name
                </label>
                <input
                  id={`${idBase}-name`}
                  ref={nameRef}
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
              Adding saves the provider right away. The key is stored in config.json and is not
              shown again.
            </div>

            {submitError && (
              <div className="settings-error" role="alert">
                {submitError}
              </div>
            )}

            <div className="settings-inline-actions">
              <button
                type="button"
                className="settings-btn-cancel"
                disabled={busy}
                onClick={handleDismiss}
              >
                Cancel
              </button>
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
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * The store's view of a provider just added. Built from the public fields the
 * server returned, so no key is ever copied into the page state.
 */
function toProviderConfig(added: {
  id: string;
  name: string;
  provider: LlmProvider;
  baseUrl: string;
  model?: string;
}): ProviderConfig {
  return {
    id: added.id,
    name: added.name,
    provider: added.provider,
    baseUrl: added.baseUrl,
    ...(added.model ? { model: added.model } : {}),
  };
}
