'use client';

import { useEffect, useRef } from 'react';

/**
 * A single global Escape handler that pops the most recently registered
 * overlay. Per-instance `useClickOutsideEscape` listeners (previously added in
 * ConfirmDialog/MermaidOverlay/popovers) caused re-attach churn — `onClose`
 * was in that hook's deps, so a parent that recreated `onClose` every render
 * tore down and re-added the document listener every frame. This stack is
 * installed once for the whole app (on the first registration) and holds
 * mutable `onClose` runners so registration is stable.
 */

interface OverlayEntry {
  id: string;
  close: () => void;
}

const stack: OverlayEntry[] = [];
let installed = false;
let handler: ((e: KeyboardEvent) => void) | null = null;

function ensureInstalled(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  handler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || stack.length === 0) return;
    const entry = stack.at(-1);
    if (!entry) return;
    e.stopPropagation();
    e.preventDefault();
    entry.close();
  };
  document.addEventListener('keydown', handler, true);
}

function register(id: string, close: () => void): () => void {
  const entry: OverlayEntry = { id, close };
  stack.push(entry);
  return () => {
    const idx = stack.indexOf(entry);
    if (idx !== -1) stack.splice(idx, 1);
  };
}

/**
 * Register an overlay so Esc pops the topmost registration. Keep `onClose`
 * in a ref internally so the id-based registration (and its global listener)
 * stays stable even when the callback changes identity.
 */
export function useRegisterOverlay(id: string, onClose: () => void, enabled: boolean = true): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    ensureInstalled();
    const unregister = register(id, () => closeRef.current());
    return unregister;
  }, [id, enabled]);
}

/** Test-only escape hatch for stack state. */
export function __resetOverlayStackForTests(): void {
  stack.length = 0;
}
