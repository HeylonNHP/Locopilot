'use client';

import { useSyncExternalStore } from 'react';

/**
 * Shared, persisted collapse state for the model selector's provider
 * sections.
 *
 * Why an external store instead of component state: two ModelSelector
 * instances (main model + compaction) are mounted at the same time and
 * must present the same collapse state, and chatStore is deliberately not
 * used for ephemeral view state because every dispatch re-renders the whole
 * app tree. useSyncExternalStore gives both instances a consistent view
 * with minimal re-renders, and localStorage persistence means the user's
 * collapse choices survive page reloads.
 *
 * Shape: Record<providerName, true>. Only collapsed sections are stored —
 * absence means expanded — which keeps the persisted payload minimal and
 * makes "all expanded" the natural default for corrupt/absent data.
 */

const STORAGE_KEY = 'locopilot.modelSelector.collapsedProviders';

type CollapsedProviders = Record<string, true>;

type Listener = () => void;

let cached: CollapsedProviders = {};
let loaded = false;
const listeners = new Set<Listener>();

function isCollapsedRecord(value: unknown): value is CollapsedProviders {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => entry === true);
}

function ensureLoaded(): void {
  if (loaded || typeof globalThis.window === 'undefined') return;
  loaded = true;
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    // Validate rather than trust: a stale or hand-edited payload must never
    // break the selector, it just falls back to all-expanded.
    if (isCollapsedRecord(parsed)) {
      cached = parsed;
    }
  } catch {
    // Corrupt JSON or storage unavailable: keep defaults.
  }
}

function persist(): void {
  if (typeof globalThis.window === 'undefined') return;
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // Private-browsing/quota errors: collapse state degrades to session-only.
  }
}

function subscribe(listener: Listener): () => void {
  ensureLoaded();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CollapsedProviders {
  ensureLoaded();
  return cached;
}

/** Toggle one provider section; keyed by display name (matches grouping). */
export function toggleProviderCollapsed(providerName: string): void {
  ensureLoaded();
  const next: CollapsedProviders = { ...cached };
  if (next[providerName] === true) {
    delete next[providerName];
  } else {
    next[providerName] = true;
  }
  cached = next;
  persist();
  for (const listener of listeners) {
    listener();
  }
}

/** Reactive map of collapsed provider names (absence = expanded). */
export function useCollapsedProviders(): CollapsedProviders {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}