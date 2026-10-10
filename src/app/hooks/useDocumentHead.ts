'use client';

import { useEffect, useMemo, useState } from 'react';

import type { Session } from '@/app/lib/chatStore';

const APP_TITLE = 'Locopilot';

/** A `<link rel="icon">` to render for the current conversation. */
export interface Favicon {
  href: string;
  type: 'image/png' | 'image/svg+xml';
}

/** The tab chrome — title and favicon — for the active conversation. */
export interface DocumentHead {
  title: string;
  favicon: Favicon;
}

/** Shown when the active session has no leading emoji. */
const DEFAULT_FAVICON: Favicon = { href: '/icon.svg', type: 'image/svg+xml' };

/** Edge length of the generated PNG. 64px is crisp enough for browser tabs. */
const FAVICON_SIZE = 64;

/**
 * Matches a single grapheme cluster that is (or contains) an emoji.
 *
 * `Extended_Pictographic` covers the vast majority of emoji, `Regional_Indicator`
 * covers flag sequences (which are two code points), and `\u20E3` covers
 * keycap sequences such as 1️⃣ that are otherwise made only of a digit + VS16.
 */
const EMOJI_GRAPHEME_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;

/** True for a single pictograph, e.g. ❤ (U+2764). */
const LONE_PICTOGRAPH_RE = /^\p{Extended_Pictographic}$/u;

/** True for code points that render as colour emoji without a variation selector. */
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}$/u;

/**
 * Returns the leading emoji of a session name, or null when the name does not
 * begin with one.
 *
 * Uses `Intl.Segmenter` (grapheme granularity) when available so multi-code-point
 * emoji — flags, ZWJ sequences, skin-tone modifiers and keycaps — are captured
 * intact instead of being sliced at the first code point.
 */
export function extractLeadingEmoji(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? '';
  if (!trimmed) return null;

  let firstGrapheme: string;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed);
    firstGrapheme = segments[Symbol.iterator]().next().value?.segment ?? '';
  } else {
    // Fallback: assume the first whitespace-delimited token is the grapheme.
    firstGrapheme = trimmed.match(/^\S+/u)?.[0] ?? '';
  }

  return EMOJI_GRAPHEME_RE.test(firstGrapheme) ? firstGrapheme : null;
}

/**
 * Forces colour (emoji) presentation for a lone, text-default pictograph such as
 * ❤ (U+2764) or ☺ (U+263A), which would otherwise render as a monochrome glyph.
 *
 * Sequences are returned untouched: appending U+FE0F to a flag, ZWJ family,
 * keycap or skin-tone sequence would produce a malformed/unintended sequence.
 */
export function applyEmojiPresentation(emoji: string): string {
  const isLonePictograph = [...emoji].length === 1 && LONE_PICTOGRAPH_RE.test(emoji);
  const alreadyColour = EMOJI_PRESENTATION_RE.test(emoji);
  return isLonePictograph && !alreadyColour ? `${emoji}\uFE0F` : emoji;
}

/**
 * Renders a single emoji to a PNG data URL via a canvas.
 *
 * The glyph is drawn with the platform emoji font, so the favicon matches the
 * artwork already shown in the sidebar.
 */
function emojiToFaviconDataUrl(emoji: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = FAVICON_SIZE;
  canvas.height = FAVICON_SIZE;

  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.clearRect(0, 0, FAVICON_SIZE, FAVICON_SIZE);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${FAVICON_SIZE * 0.82}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif`;
  ctx.fillText(emoji, FAVICON_SIZE / 2, FAVICON_SIZE / 2 + FAVICON_SIZE * 0.04);

  return canvas.toDataURL('image/png');
}

/** Renders an emoji to a ready-to-render favicon, falling back to the default. */
function renderEmojiFavicon(emoji: string): Favicon {
  const href = emojiToFaviconDataUrl(applyEmojiPresentation(emoji));
  return href === '' ? DEFAULT_FAVICON : { href, type: 'image/png' };
}

/**
 * Removes a leading emoji from a session name.
 *
 * The emoji is shown as the favicon, so repeating it in the tab title is visual
 * duplication. Falls back to the raw name when stripping would leave nothing
 * (e.g. an emoji-only name).
 */
export function withoutLeadingEmoji(name: string, emoji: string | null): string {
  if (emoji === null) return name;
  return name.trim().slice(emoji.length).trim() || name;
}

/** Formats the tab title: "{name} — Locopilot", or a neutral fallback. */
function resolveTitle(currentSessionId: number | null, name: string | undefined): string {
  if (currentSessionId === null) return APP_TITLE;
  return name ? `${name} — ${APP_TITLE}` : `Session ${currentSessionId} — ${APP_TITLE}`;
}

/**
 * Resolves the tab title and favicon for the active conversation.
 *
 * The leading emoji of the session name becomes the favicon and is stripped from
 * the title, so the two do not repeat each other.
 *
 * The result is meant to be rendered by React (which hoists `<title>`/`<link>`
 * into `<head>` and keeps them correct across the head re-commits Next.js
 * performs after hydration). Touching the DOM imperatively instead loses that
 * race: the framework rebuilds `<head>` and clobbers the change.
 *
 * The session lookup is memoized because consumers re-render on every chat-store
 * update (i.e. every streamed token) while `sessions` can be large.
 */
export function useDocumentHead(
  currentSessionId: number | null,
  sessions: Session[]
): DocumentHead {
  const session = useMemo(
    () => (currentSessionId === null ? undefined : sessions.find((s) => s.id === currentSessionId)),
    [currentSessionId, sessions]
  );
  const name = session?.name?.trim();

  const emoji = useMemo(() => extractLeadingEmoji(name), [name]);
  // The leading emoji already appears as the favicon, so keep it out of the title.
  const label = name === undefined ? undefined : withoutLeadingEmoji(name, emoji);

  const [favicon, setFavicon] = useState<Favicon>(DEFAULT_FAVICON);
  useEffect(() => {
    // Canvas rendering is client-only, so it must happen in an effect; the
    // initial render (and SSR) falls back to the default icon.
    setFavicon(emoji === null ? DEFAULT_FAVICON : renderEmojiFavicon(emoji));
  }, [emoji]);

  return { title: resolveTitle(currentSessionId, label), favicon };
}
