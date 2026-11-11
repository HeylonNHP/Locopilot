/**
 * Tests for conversation favicon emoji extraction (src/app/hooks/useDocumentHead.ts).
 *
 * `extractLeadingEmoji` is the pure, DOM-free core of the favicon feature: it
 * decides which grapheme (if any) of a session name gets rendered as the tab
 * icon. These tests pin that it captures whole emoji — including multi-code-point
 * flags, ZWJ family sequences, skin-tone modifiers and keycaps — refuses plain
 * text, and does not mistake a bare digit for an emoji (digits carry the Unicode
 * `Emoji` property, so a looser `\p{Emoji}` test would wrongly match "2024").
 */

import { beforeEach, describe, expect, test } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  applyEmojiPresentation,
  extractLeadingEmoji,
  hasVisiblePixels,
  isRenderableGlyph,
  resolveFavicon,
  useDocumentHead,
  withoutLeadingEmoji,
} from '../src/app/hooks/useDocumentHead.ts';

describe('extractLeadingEmoji', () => {
  test.each([
    ['simple emoji', '🎉 Party planning notes', '🎉'],
    ['leading whitespace is tolerated', '  🚀 Launch checklist', '🚀'],
    ['ZWJ sequence stays intact', '👨‍👩‍👧 Family trip', '👨‍👩‍👧'],
    ['flag (two regional indicators)', '🇯🇵 Japan itinerary', '🇯🇵'],
    ['skin-tone modifier', '👍🏽 Deploy approved', '👍🏽'],
    ['keycap sequence', '1️⃣ First place', '1️⃣'],
    ['plain text has no emoji', 'No emoji here', null],
    ['bare digit is not treated as an emoji', '2024 report', null],
    ['empty string', '', null],
    ['whitespace only', '   ', null],
    ['null', null, null],
    ['undefined', undefined, null],
  ])('%s', (_label, input, expected) => {
    expect(extractLeadingEmoji(input)).toBe(expected);
  });
});

describe('applyEmojiPresentation', () => {
  test.each([
    ['lone text-default heart gains VS16', '\u2764', '\u2764\uFE0F'],
    ['lone text-default smiley gains VS16', '\u263A', '\u263A\uFE0F'],
    ['lone copyright sign gains VS16', '\u00A9', '\u00A9\uFE0F'],
    ['already-colour heart is unchanged', '\u2764\uFE0F', '\u2764\uFE0F'],
    ['emoji-presentation glyph is unchanged', '\uD83D\uDE00', '\uD83D\uDE00'],
    ['flag sequence is untouched', '\uD83C\uDDEF\uD83C\uDD75', '\uD83C\uDDEF\uD83C\uDD75'],
    [
      'ZWJ family sequence is untouched',
      '\uD83D\uDC69\u200D\uD83D\uDC69\u200D\uD83D\uDC67',
      '\uD83D\uDC69\u200D\uD83D\uDC69\u200D\uD83D\uDC67',
    ],
    ['keycap sequence is untouched', '1\uFE0F\u20E3', '1\uFE0F\u20E3'],
    ['skin-tone sequence is untouched', '\uD83D\uDC4D\uD83C\uDFFD', '\uD83D\uDC4D\uD83C\uDFFD'],
  ])('%s', (_label, input, expected) => {
    expect(applyEmojiPresentation(input)).toBe(expected);
  });
});

describe('withoutLeadingEmoji', () => {
  test.each([
    ['emoji removed from title', ['💡 LED Specs Deep Dive', '💡'], 'LED Specs Deep Dive'],
    ['emoji + space removed', ['🦉 Owl survey notes', '🦉'], 'Owl survey notes'],
    ['ZWJ emoji removed', ['👨‍👩‍👧 Family trip', '👨‍👩‍👧'], 'Family trip'],
    ['keycap removed', ['  1️⃣ First place', '1️⃣'], 'First place'],
    ['no emoji leaves the name untouched', ['No emoji here', null], 'No emoji here'],
    ['emoji-only name is kept as a fallback', ['💡', '💡'], '💡'],
  ])('%s', (_label, args, expected) => {
    expect(withoutLeadingEmoji(...args)).toBe(expected);
  });
});

describe('hasVisiblePixels', () => {
  test.each([
    ['all-zero buffer is blank', new Uint8ClampedArray(16), false],
    ['empty buffer is blank', new Uint8ClampedArray(0), false],
    ['RGB set but alpha 0 is blank', new Uint8ClampedArray([255, 0, 0, 0, 0, 0, 0, 0]), false],
    ['one opaque pixel is visible', new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]), true],
  ])('%s', (_label, input, expected) => {
    expect(hasVisiblePixels(input)).toBe(expected);
  });
});

describe('isRenderableGlyph', () => {
  const blank = new Uint8ClampedArray(16);
  const glyphA = new Uint8ClampedArray([1, 2, 3, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const glyphB = new Uint8ClampedArray([1, 2, 3, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
  test.each([
    ['blank glyph rejected, no reference', [blank, null], false],
    ['visible glyph accepted without a reference', [glyphA, null], true],
    [
      'glyph identical to missing-glyph box rejected',
      [glyphA, new Uint8ClampedArray(glyphA)],
      false,
    ],
    ['glyph differing from reference accepted', [glyphA, glyphB], true],
    [
      'blank glyph rejected when reference also blank',
      [blank, new Uint8ClampedArray(blank)],
      false,
    ],
    ['length mismatch is not equal', [glyphA, new Uint8ClampedArray(8)], true],
  ])('%s', (_label, args, expected) => {
    expect(isRenderableGlyph(...args)).toBe(expected);
  });
});

describe('resolveFavicon', () => {
  let calls;
  const stub = (value) => (emoji) => {
    calls.push(emoji);
    return value;
  };

  beforeEach(() => {
    calls = [];
  });

  describe('with no emoji', () => {
    test('uses the default icon', () => {
      expect(resolveFavicon(null, stub('data:image/png;base64,AAAA')).href).toBe('/icon.svg');
    });

    test('uses the default icon type', () => {
      expect(resolveFavicon(null, stub('data:image/png;base64,AAAA')).type).toBe('image/svg+xml');
    });

    test('never calls the renderer', () => {
      resolveFavicon(null, stub('data:image/png;base64,AAAA'));
      expect(calls).toHaveLength(0);
    });
  });

  test('an empty render falls back to the default', () => {
    expect(resolveFavicon('🚀', stub('')).href).toBe('/icon.svg');
  });

  describe('with a rendered emoji', () => {
    test('the render becomes the href', () => {
      expect(resolveFavicon('🚀', stub('data:image/png;base64,AAAA')).href).toBe(
        'data:image/png;base64,AAAA'
      );
    });

    test('the icon is a PNG', () => {
      expect(resolveFavicon('🚀', stub('data:image/png;base64,AAAA')).type).toBe('image/png');
    });

    test('colour presentation is applied before rendering', () => {
      resolveFavicon('❤', stub('data:x'));
      expect(calls[0]).toBe('❤️');
    });

    test('an emoji-presentation glyph is passed through unchanged', () => {
      resolveFavicon('🚀', stub('data:x'));
      expect(calls[0]).toBe('🚀');
    });
  });
});

describe('useDocumentHead (server render)', () => {
  function Probe() {
    const head = useDocumentHead(1, [
      { id: 1, name: '🚀 Launch', model: 'm', created_at: '', updated_at: '' },
    ]);
    return createElement('p', { 'data-href': head.favicon.href }, head.title);
  }
  const html = renderToStaticMarkup(createElement(Probe));
  test('SSR renders default icon without a DOM', () => {
    expect(html.includes('data-href="/icon.svg"')).toBe(true);
  });
  test('SSR title has the emoji stripped', () => {
    expect(html.includes('>Launch — Locopilot<')).toBe(true);
  });
});
