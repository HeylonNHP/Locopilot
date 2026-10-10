'use client';

import { useEffect } from 'react';

import type { Session } from '@/app/lib/chatStore';

/** Fallback icon shown when the active session has no leading emoji. */
const DEFAULT_FAVICON_HREF = '/icon.svg';

/** Edge length of the generated PNG. 64px is crisp enough for browser tabs. */
const FAVICON_SIZE = 64;

/** Marks the <link> we own so we never clobber Next.js-managed icon tags. */
const FAVICON_LINK_ATTR = 'data-conversation-favicon';

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
 * artwork already shown in the sidebar. A data URL is returned (rather than an
 * object URL) so nothing has to be revoked later.
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

/** Returns our injected favicon <link>, creating it if it does not exist yet. */
function getOrCreateFaviconLink(): HTMLLinkElement {
  const existing = document.querySelector<HTMLLinkElement>(`link[${FAVICON_LINK_ATTR}]`);
  if (existing) return existing;

  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/png';
  // Mirror the `sizes="any"` Next.js places on its own SVG icon. Without it our
  // candidate lacks a size and can lose the browser's "most appropriate icon"
  // selection to the built-in SVG.
  link.setAttribute('sizes', 'any');
  link.setAttribute(FAVICON_LINK_ATTR, '');
  document.head.append(link);
  return link;
}

/**
 * Keeps the browser favicon in sync with the active conversation.
 *
 * When the session name starts with an emoji (Locopilot titles always do), that
 * emoji is rendered to a PNG and installed as the tab icon. Otherwise the app's
 * default icon is restored.
 *
 * The icon is written to a dedicated <link> we create ourselves, so we never
 * disturb the icon tag Next.js emits from `src/app/icon.svg`.
 */
export function useFavicon(currentSessionId: number | null, sessions: Session[]): void {
  // Derive the emoji outside the effect and depend on that string, so the
  // canvas render + toDataURL only re-run when the glyph actually changes —
  // not on every store dispatch that replaces the `sessions` array.
  const session =
    currentSessionId === null ? undefined : sessions.find((s) => s.id === currentSessionId);
  const emoji = extractLeadingEmoji(session?.name);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const link = document.querySelector<HTMLLinkElement>(`link[${FAVICON_LINK_ATTR}]`);

    if (emoji === null) {
      // No emoji to show: point our link back at the default icon. Setting a
      // concrete href (rather than removing the link) guarantees the browser
      // actually repaints the tab icon.
      if (link && link.getAttribute('href') !== DEFAULT_FAVICON_HREF) {
        link.setAttribute('href', DEFAULT_FAVICON_HREF);
      }
      return;
    }

    const dataUrl = emojiToFaviconDataUrl(applyEmojiPresentation(emoji));
    if (dataUrl === '') return;

    const target = link ?? getOrCreateFaviconLink();
    // Skip the DOM write when nothing changed — avoids needless repaints.
    if (target.getAttribute('href') !== dataUrl) target.setAttribute('href', dataUrl);
  }, [emoji]);

  // Remove our injected <link> only on unmount. This lives in its own effect so
  // the frequent re-runs above never tear the link down and recreate it.
  useEffect(
    () => () => {
      document.querySelector(`link[${FAVICON_LINK_ATTR}]`)?.remove();
    },
    []
  );
}
