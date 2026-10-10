#!/usr/bin/env node
/**
 * Tests for conversation favicon emoji extraction (src/app/hooks/useFavicon.ts).
 *
 * Run with: npx tsx scripts/test-conversation-favicon.mjs
 *
 * `extractLeadingEmoji` is the pure, DOM-free core of the favicon feature: it
 * decides which grapheme (if any) of a session name gets rendered as the tab
 * icon. These tests pin that it captures whole emoji — including multi-code-point
 * flags, ZWJ family sequences, skin-tone modifiers and keycaps — refuses plain
 * text, and does not mistake a bare digit for an emoji (digits carry the Unicode
 * `Emoji` property, so a looser `\p{Emoji}` test would wrongly match "2024").
 */

import { extractLeadingEmoji } from '../src/app/hooks/useFavicon.ts';

let pass = 0;
let fail = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(
      `  FAIL  ${label}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
    fail += 1;
  }
}

console.log('extractLeadingEmoji');

assertEq(extractLeadingEmoji('🎉 Party planning notes'), '🎉', 'simple emoji');
assertEq(extractLeadingEmoji('  🚀 Launch checklist'), '🚀', 'leading whitespace is tolerated');
assertEq(extractLeadingEmoji('👨‍👩‍👧 Family trip'), '👨‍👩‍👧', 'ZWJ sequence stays intact');
assertEq(extractLeadingEmoji('🇯🇵 Japan itinerary'), '🇯🇵', 'flag (two regional indicators)');
assertEq(extractLeadingEmoji('👍🏽 Deploy approved'), '👍🏽', 'skin-tone modifier');
assertEq(extractLeadingEmoji('1️⃣ First place'), '1️⃣', 'keycap sequence');

assertEq(extractLeadingEmoji('No emoji here'), null, 'plain text has no emoji');
assertEq(extractLeadingEmoji('2024 report'), null, 'bare digit is not treated as an emoji');
assertEq(extractLeadingEmoji(''), null, 'empty string');
assertEq(extractLeadingEmoji('   '), null, 'whitespace only');
assertEq(extractLeadingEmoji(null), null, 'null');
assertEq(extractLeadingEmoji(undefined), null, 'undefined');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
