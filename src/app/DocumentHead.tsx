'use client';

import { resolveDocumentTitle } from './hooks/documentTitle';
import { useFavicon } from './hooks/useFavicon';
import { useChat } from './lib/chatStore';

/**
 * Owns the browser tab chrome — the `<title>` and the conversation favicon — for
 * the whole app.
 *
 * React 19 hoists `<title>`/`<link>` rendered anywhere in the tree into `<head>`,
 * and keeps them correct across the `<head>` re-commits Next.js performs after
 * hydration. Setting `document.title` or appending a `<link>` imperatively loses
 * that race: the framework rebuilds `<head>` and clobbers the change, which left
 * the tab stuck on the default title and icon.
 *
 * Rendered once in the root layout so every route gets a title.
 */
export function DocumentHead() {
  const { state } = useChat();
  const title = resolveDocumentTitle(state.currentSessionId, state.sessions);
  const favicon = useFavicon(state.currentSessionId, state.sessions);

  return (
    <>
      <title>{title}</title>
      <link rel="icon" type={favicon.type} sizes="any" href={favicon.href} />
    </>
  );
}
