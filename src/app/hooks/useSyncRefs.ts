'use client';

import { useEffect, useRef } from 'react';

/**
 * Keeps mutable refs in sync with changing state values so that callbacks
 * (e.g. in useSlashCommands) can read the latest value without re-creating
 * the callback on every render.
 */
export function useSyncRefs(compactingSessions: ReadonlySet<number>, isGeneratingTitle: boolean) {
  const compactingSessionsRef = useRef<ReadonlySet<number>>(new Set());
  const isGeneratingTitleRef = useRef(false);

  useEffect(() => {
    compactingSessionsRef.current = compactingSessions;
  }, [compactingSessions]);
  useEffect(() => {
    isGeneratingTitleRef.current = isGeneratingTitle;
  }, [isGeneratingTitle]);

  return { compactingSessionsRef, isGeneratingTitleRef };
}
