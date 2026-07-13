'use client';

import { useEffect, useRef } from 'react';

/**
 * Keeps mutable refs in sync with changing state values so that callbacks
 * (e.g. in useSlashCommands) can read the latest value without re-creating
 * the callback on every render.
 */
export function useSyncRefs(isCompacting: boolean, isGeneratingTitle: boolean) {
  const isCompactingRef = useRef(false);
  const isGeneratingTitleRef = useRef(false);

  useEffect(() => {
    isCompactingRef.current = isCompacting;
  }, [isCompacting]);
  useEffect(() => {
    isGeneratingTitleRef.current = isGeneratingTitle;
  }, [isGeneratingTitle]);

  return { isCompactingRef, isGeneratingTitleRef };
}
