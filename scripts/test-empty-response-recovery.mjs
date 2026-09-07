#!/usr/bin/env node
/**
 * Unit tests for the shared empty-response recovery policy
 * (src/services/emptyResponseRecovery.ts).
 *
 * Run with: npx tsx scripts/test-empty-response-recovery.mjs
 *
 * No network, no live server, no Ollama — the tests exercise the pure
 * functions and the tracker class directly.
 *
 * Regression focus: the sub-agent loop previously ended silently on an empty
 * model response (no retry), while the main chat loop had its own private
 * copy of the same policy. Both loops now share this module; these tests
 * pin the shared behaviour — detection rules, attempt cap, reset rules, and
 * the synthetic-marker-prefixed nudge text.
 */

import { SYNTHETIC_NUDGE_END, SYNTHETIC_NUDGE_MARKER } from '../src/services/compact/constants.ts';
import {
  buildEmptyResponseRecoveryNudge,
  EmptyResponseRecoveryTracker,
  hasMeaningfulAssistantContent,
  MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS,
  sanitizeAssistantTextFragment,
} from '../src/services/emptyResponseRecovery.ts';

let pass = 0;
let fail = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}\n        expected: ${expected}\n        actual:   ${actual}`);
    fail += 1;
  }
}

function assertTrue(value, label) {
  if (value) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}\n        expected truthy, got: ${value}`);
    fail += 1;
  }
}

console.log('hasMeaningfulAssistantContent');

assertEq(
  hasMeaningfulAssistantContent({ role: 'assistant', content: '' }),
  false,
  'empty string is not meaningful'
);
assertEq(
  hasMeaningfulAssistantContent({ role: 'assistant', content: '   \n\t ' }),
  false,
  'whitespace-only content is not meaningful'
);
assertEq(
  hasMeaningfulAssistantContent({ role: 'assistant', content: undefined }),
  false,
  'undefined content is not meaningful'
);
assertEq(
  hasMeaningfulAssistantContent({ role: 'assistant', content: 'thought' }),
  false,
  'bare channel label is not meaningful'
);
assertEq(
  hasMeaningfulAssistantContent({ role: 'assistant', content: '  Analysis ' }),
  false,
  'channel label with padding/case is not meaningful'
);
assertEq(
  hasMeaningfulAssistantContent({ role: 'assistant', content: 'The current temperature is 24C.' }),
  true,
  'plain text reply is meaningful'
);
assertEq(
  hasMeaningfulAssistantContent({ role: 'assistant', content: 'thought\nThe temperature is 24C.' }),
  true,
  'channel label followed by real text is meaningful'
);

console.log('sanitizeAssistantTextFragment');

assertEq(
  sanitizeAssistantTextFragment('thought'),
  '',
  'channel-label-only text is blanked'
);
assertEq(
  sanitizeAssistantTextFragment('  hello  '),
  '  hello  ',
  'ordinary text passes through untrimmed'
);

console.log('EmptyResponseRecoveryTracker');

{
  const tracker = new EmptyResponseRecoveryTracker();
  assertEq(tracker.shouldRecover(), true, 'fresh tracker allows recovery');
  assertEq(tracker.attemptsUsed, 0, 'fresh tracker has zero attempts used');

  tracker.recordAttempt();
  assertEq(tracker.shouldRecover(), true, 'one attempt still allows recovery');
  assertEq(tracker.attemptsUsed, 1, 'one attempt recorded');

  tracker.recordAttempt();
  tracker.recordAttempt();
  assertEq(tracker.shouldRecover(), false, `after ${MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS} attempts recovery is exhausted`);
  assertEq(tracker.attemptsUsed, 3, 'three attempts recorded');

  tracker.reset();
  assertEq(tracker.shouldRecover(), true, 'reset re-enables recovery');
  assertEq(tracker.attemptsUsed, 0, 'reset clears the counter');
}

console.log('buildEmptyResponseRecoveryNudge');

{
  const nudge = buildEmptyResponseRecoveryNudge();
  assertEq(nudge.role, 'user', 'nudge is a user-role message');
  assertTrue(
    nudge.content.startsWith(SYNTHETIC_NUDGE_MARKER),
    'nudge starts with SYNTHETIC_NUDGE_MARKER (compaction anchor skips it)'
  );
  assertTrue(
    nudge.content.endsWith(SYNTHETIC_NUDGE_END),
    'nudge ends with SYNTHETIC_NUDGE_END'
  );
  assertTrue(
    nudge.content.includes('Your last response was empty'),
    'nudge states the response was empty'
  );

  const second = buildEmptyResponseRecoveryNudge();
  assertTrue(
    nudge !== second,
    'each call returns a fresh object (no shared mutable state)'
  );
  assertEq(second.content, nudge.content, 'nudge content is deterministic');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);