#!/usr/bin/env node
/**
 * Tests for a provider's context-limit 400 that names no number (Phase 3.2).
 *
 * Run with: npx tsx scripts/test-numberless-context-limit.mjs
 *
 * No network. The classifier is pure; the two retry branches (the main chat
 * loop and the sub-agent) are pinned in source, because they need a live model
 * to run end to end. The live check is recorded in CONFIRMATIONS C-005.
 *
 * NEEDS CLARIFICATION: only one phrasing is confirmed (Ollama Cloud
 * `minimax-m3.1-flash`). Widen the list in llmContextLimit.ts only from a logged
 * occurrence, and add a case here when you do.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyContextLimitError,
  isNumberlessContextLimitError,
  parseContextLimitFromError,
} from '../src/services/llmContextLimit.ts';

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message.split('\n').join('\n        ')}`);
    fail += 1;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, '..', relative), 'utf8');

// The exact body the owner's sub-agent received (CONFIRMATIONS C-005).
const NUMBERLESS = '{"error":"invalid params, context window exceeds limit"}';

console.log('the numberless phrasing is recognised');

check('the confirmed Ollama Cloud body is numberless', () => {
  assert.equal(isNumberlessContextLimitError(NUMBERLESS), true);
});

check('the phrase is matched without regard to case or spacing', () => {
  assert.equal(
    isNumberlessContextLimitError('Invalid Params,  Context Window Exceeds Limit'),
    true
  );
  assert.equal(isNumberlessContextLimitError('invalid params context window exceeds limit'), true);
});

check('a message that names a window is not numberless (the parser handles it)', () => {
  assert.equal(
    isNumberlessContextLimitError(
      'request (326517 tokens) exceeds the available context size (262144 tokens)'
    ),
    false
  );
});

check('unrelated errors are not numberless', () => {
  for (const message of [
    '',
    'Invalid API key',
    'invalid params: temperature must be a number',
    'context window is fine',
    'rate limit exceeded',
  ]) {
    assert.equal(isNumberlessContextLimitError(message), false, `matched: ${message}`);
  }
});

check('a non-string or empty message is not numberless', () => {
  assert.equal(isNumberlessContextLimitError(undefined), false);
  assert.equal(isNumberlessContextLimitError(null), false);
});

console.log('the classifier gives each case one verdict');

check('a message that names the window teaches it (learn)', () => {
  assert.deepEqual(classifyContextLimitError('maximum context length is 4096 tokens'), {
    kind: 'learn',
    cap: 4096,
  });
});

check('the numberless message compacts without learning a cap (compact-only)', () => {
  assert.deepEqual(classifyContextLimitError(NUMBERLESS), { kind: 'compact-only' });
});

check('anything else is left to the caller (none)', () => {
  assert.deepEqual(classifyContextLimitError('Invalid API key'), { kind: 'none' });
  assert.deepEqual(classifyContextLimitError(''), { kind: 'none' });
});

check('a message with both a number and the numberless phrase learns the number', () => {
  const both = `${NUMBERLESS} maximum context length is 8192 tokens`;
  assert.equal(classifyContextLimitError(both).kind, 'learn');
  assert.equal(parseContextLimitFromError(both), 8192);
});

console.log('the two retry branches use the classifier, and only learn from a number');

check('the sub-agent branch compacts on either verdict but learns only from a number', () => {
  const source = read('src/tools/impl/subAgentTool.ts');
  assert.ok(source.includes('classifyContextLimitError(apiMessage)'), 'not classified');
  assert.ok(source.includes("verdict.kind !== 'none'"), 'a numberless message is not acted on');
  assert.ok(
    /if \(verdict\.kind === 'learn'\) {\s*adoptDiscoveredContextLimit\(config, verdict\.cap\);/.test(
      source
    ),
    'the cap is learned from something other than a number'
  );
});

check(
  'the main loop retries a numberless 400 once, by compacting and continuing the outer loop',
  () => {
    const source = read('src/app/api/chat/route.ts');
    assert.ok(source.includes('classifyContextLimitError(providerMessage)'), 'not classified');
    assert.ok(source.includes("kind === 'compact-only'"), 'the verdict is not checked');
    assert.ok(source.includes('providerLimitRetriedThisTurn = true;'), 'the retry is not bounded');
    assert.ok(source.includes('compactionForcedByProvider = true;'), 'no compaction is forced');
    assert.ok(
      /compactionForcedByProvider = true;[\S\s]*?continue outer;/.test(source),
      'the retry does not continue the outer loop'
    );
    assert.ok(
      source.includes('(forcedByProvider || tokensUsed >= compactionTriggerTokens)'),
      'the forced flag does not reach the compaction gate'
    );
  }
);

check('the main loop never learns a cap from a numberless 400', () => {
  const source = read('src/app/api/chat/route.ts');
  const block = new Set(
    source.slice(
      source.indexOf('if (classifyContextLimitError(providerMessage).kind'),
      source.indexOf(
        'continue outer;',
        source.indexOf('if (classifyContextLimitError(providerMessage).kind')
      )
    )
  );
  assert.ok(!block.has('adoptDiscoveredContextLimit'), 'the numberless branch learns a cap');
  assert.ok(!block.has('recordDiscoveredCap'), 'the numberless branch writes the cache');
});

check('the clarification is marked where the phrasing is kept and where it is used', () => {
  for (const file of [
    'src/services/llmContextLimit.ts',
    'src/tools/impl/subAgentTool.ts',
    'src/app/api/chat/route.ts',
  ]) {
    assert.ok(read(file).includes('NEEDS CLARIFICATION'), `${file} has no clarification marker`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
