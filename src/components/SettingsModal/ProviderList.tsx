'use client';
import type { ProviderConfig } from '@/types/chatConfig';

import { providerKindLabel } from '@/app/lib/providerForm';

interface Props {
  providers: ProviderConfig[];
  emptyText: string;
}

/**
 * The configured providers by name, kind and address. A stored API key is
 * never shown: the list only has the public fields of a provider.
 */
export default function ProviderList({ providers, emptyText }: Props) {
  if (providers.length === 0) {
    return <p className="settings-hint">{emptyText}</p>;
  }
  return (
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
  );
}
