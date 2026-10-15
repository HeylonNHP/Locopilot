'use client';

import { useMemo, useSyncExternalStore } from 'react';

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
 * A noncharacter no font covers. Drawn with the same font and position as the
 * real glyph, it shows what this browser paints for a missing glyph ("tofu"), so
 * an emoji that renders identically can be rejected.
 */
const MISSING_GLYPH = '\u{10FFFF}';

/** True when at least one pixel of an RGBA buffer is not fully transparent. */
export function hasVisiblePixels(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 0) return true;
  }
  return false;
}

function pixelsEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return a.length === b.length && Array.prototype.every.call(a, (v, i) => v === b[i]);
}

/**
 * Decides whether a rendered glyph is worth using as a favicon: it must have
 * drawn something, and must not match the browser's missing-glyph box.
 * `missingGlyph` is null when that reference could not be rendered, in which case
 * only the blank check applies.
 */
export function isRenderableGlyph(
  glyph: ArrayLike<number>,
  missingGlyph: ArrayLike<number> | null
): boolean {
  return hasVisiblePixels(glyph) && !(missingGlyph !== null && pixelsEqual(glyph, missingGlyph));
}

/**
 * Draws `text` to a canvas with the platform emoji font and reads the pixels
 * back. Returns null when there is no 2D context or readback is blocked (e.g.
 * anti-fingerprinting modes), so callers fall back to the default icon.
 */
function drawGlyph(text: string): { canvas: HTMLCanvasElement; rgba: Uint8ClampedArray } | null {
  const canvas = document.createElement('canvas');
  canvas.width = FAVICON_SIZE;
  canvas.height = FAVICON_SIZE;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.clearRect(0, 0, FAVICON_SIZE, FAVICON_SIZE);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${FAVICON_SIZE * 0.82}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif`;
  ctx.fillText(text, FAVICON_SIZE / 2, FAVICON_SIZE / 2 + FAVICON_SIZE * 0.04);

  try {
    return { canvas, rgba: ctx.getImageData(0, 0, FAVICON_SIZE, FAVICON_SIZE).data };
  } catch {
    return null;
  }
}

/** Rendered once per page; `undefined` means not yet computed. */
let missingGlyphRgba: Uint8ClampedArray | null | undefined;

function getMissingGlyphRgba(): Uint8ClampedArray | null {
  if (missingGlyphRgba === undefined) {
    missingGlyphRgba = drawGlyph(MISSING_GLYPH)?.rgba ?? null;
  }
  return missingGlyphRgba;
}

/**
 * Renders a single emoji to a PNG data URL via a canvas, or returns '' when the
 * browser has no usable glyph for it (blank or missing-glyph box).
 *
 * The glyph is drawn with the platform emoji font, so the favicon matches the
 * artwork already shown in the sidebar.
 */
function emojiToFaviconDataUrl(emoji: string): string {
  const glyph = drawGlyph(emoji);
  if (!glyph || !isRenderableGlyph(glyph.rgba, getMissingGlyphRgba())) return '';
  return glyph.canvas.toDataURL('image/png');
}

/**
 * Resolves an emoji to a favicon, falling back to the default when there is no
 * emoji or it cannot be rendered. `renderToDataUrl` is injectable for tests.
 */
export function resolveFavicon(
  emoji: string | null,
  renderToDataUrl: (emoji: string) => string = emojiToFaviconDataUrl
): Favicon {
  if (emoji === null) return DEFAULT_FAVICON;
  const href = renderToDataUrl(applyEmojiPresentation(emoji));
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

const subscribeNoop = () => () => {};

/** False during SSR and hydration, true on every client render after. */
function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false
  );
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
 * The favicon is derived during render and gated on `isClient`, so it is always
 * in step with the current emoji and hydration still sees the default icon.
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

  // Derived during render (not in an effect) so a session switch never commits a
  // frame with the previous conversation's icon. Gated on `isClient` because the
  // canvas is client-only and the first client render must match SSR's default.
  const isClient = useIsClient();
  const favicon = useMemo(
    () => (isClient ? resolveFavicon(emoji) : DEFAULT_FAVICON),
    [emoji, isClient]
  );

  return { title: resolveTitle(currentSessionId, label), favicon };
}
