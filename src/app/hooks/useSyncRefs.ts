'use client';

import { useEffect, useRef } from 'react';

/**
 * Keeps mutable refs in sync with changing state values so that callbacks
 * (e.g. in useSlashCommands) can read the latest value without re-creating
 * the callback on every render.
 */
export function useSyncRefs(
  isCompacting: boolean,
  isGeneratingTitle: boolean,
  currentSessionId: number | null
) {
  const isCompactingRef = useRef(false);
  const isGeneratingTitleRef = useRef(false);
  const currentSessionIdRef = useRef<number | null>(currentSessionId);

  useEffect(() => {
    isCompactingRef.current = isCompacting;
  }, [isCompacting]);
  useEffect(() => {
    isGeneratingTitleRef.current = isGeneratingTitle;
  }, [isGeneratingTitle]);
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  return { isCompactingRef, isGeneratingTitleRef, currentSessionIdRef };
}
