'use client';
import { useState } from 'react';

import type { AddedProviderNote } from '@/app/lib/providerForm';

import { useChat } from '@/app/lib/chatStore';

import AddProviderDialog, { type AddedProviderOutcome } from './AddProviderDialog';
import ProviderList from './ProviderList';

interface Props {
  /**
   * Called after a provider is saved and the model list has been fetched again.
   * `model` is the provider's default model, and only when the provider listed
   * it, so the caller never selects a model that is not in the dropdown.
   */
  onProviderAdded: (providerId: string, model: string | undefined) => void;
}

/**
 * The providers Settings knows about. Adding one happens in a dialog that
 * opens from the Add provider button (`AddProviderDialog`); the list here shows
 * names and addresses only, and the result note stays here after the dialog
 * closes.
 */
export default function ProviderSection({ onProviderAdded }: Props) {
  const { state } = useChat();
  const providers = state.providers ?? [];
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<AddedProviderNote | null>(null);

  const handleAdded = ({ providerId, model, note: outcome }: AddedProviderOutcome) => {
    setNote(outcome);
    onProviderAdded(providerId, model);
    setAdding(false);
  };

  return (
    <div className="settings-providers">
      <div className="settings-label">Providers</div>

      <ProviderList
        providers={providers}
        emptyText="No provider yet. Add one, then choose a model to start chatting."
      />

      {note && (
        <div
          className={note.kind === 'warn' ? 'settings-error' : 'settings-note'}
          role={note.kind === 'warn' ? 'alert' : 'status'}
        >
          {note.message}
        </div>
      )}

      {/* Stays mounted while the dialog is open: focus returns to it on close. */}
      <button type="button" className="settings-btn-cancel" onClick={() => setAdding(true)}>
        Add provider
      </button>

      {adding && <AddProviderDialog onClose={() => setAdding(false)} onAdded={handleAdded} />}
    </div>
  );
}
