#!/usr/bin/env node
/**
 * Tests for the Mermaid pre-display validation and recovery policy
 * (src/services/mermaidRecovery.ts).
 *
 * Run with: npx tsx scripts/test-mermaid-recovery.mjs
 *
 * No network, no live server, no Ollama. The fence extractor, the parse
 * validator (which runs the real mermaid through the jsdom shim), the nudge
 * builder and the tracker are all exercised directly.
 *
 * Regression focus: before this module, `render_mermaid` was the ONLY mermaid
 * check and it was advisory — a model that skipped it could emit an invalid
 * fence and the user saw an "Unable to render diagram" panel. These tests pin
 * (a) the extractor matching the client renderer's fence semantics, so the
 * server validates exactly what the browser will draw, (b) the validator
 * actually failing real breakages and passing real diagrams (non-vacuous),
 * and (c) the marker-prefixed nudge / capped tracker contract.
 */

import { MAX_MERMAID_RECOVERY_ATTEMPTS } from '../src/constants.ts';
import { SYNTHETIC_NUDGE_END, SYNTHETIC_NUDGE_MARKER } from '../src/services/compact/constants.ts';
import {
  buildMermaidRecoveryNudge,
  extractMermaidFences,
  mayContainMermaidFence,
  MermaidRecoveryTracker,
  validateMermaidFences,
} from '../src/services/mermaidRecovery.ts';

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

const fence = (source) => `\`\`\`mermaid\n${source}\n\`\`\``;

// ── mayContainMermaidFence ────────────────────────────────────────────────
console.log('mayContainMermaidFence');
assertTrue(mayContainMermaidFence('text\n```mermaid\ngraph TD\n```'), 'detects ```mermaid');
assertTrue(mayContainMermaidFence('~~~mermaid\ngraph TD\n~~~'), 'detects ~~~mermaid');
assertEq(mayContainMermaidFence('just prose, no diagram'), false, 'plain prose is not a fence');
assertEq(
  mayContainMermaidFence('```python\nprint(1)\n```'),
  false,
  'a non-mermaid fence is not a mermaid fence'
);

// ── extractMermaidFences (mirrors client extractFrozenBlocks) ─────────────
console.log('\nextractMermaidFences');
{
  const found = extractMermaidFences(fence('graph TD\n  A --> B'));
  assertEq(found.length, 1, 'extracts a single closed fence');
  assertEq(found[0].source, 'graph TD\n  A --> B', 'source excludes the fence markers');
  assertEq(found[0].index, 0, 'first fence is index 0');
}
{
  const found = extractMermaidFences('~~~mermaid\ngraph TD\n  A --> B\n~~~');
  assertEq(found.length, 1, 'extracts a tilde fence');
  assertEq(found[0].source, 'graph TD\n  A --> B', 'tilde fence source is clean');
}
{
  const md = `${fence('graph TD\n  A --> B')}\n\nsome prose\n\n${fence('sequenceDiagram\n  A->>B: hi')}`;
  const found = extractMermaidFences(md);
  assertEq(found.length, 2, 'extracts multiple fences');
  assertEq(found[1].index, 1, 'second fence is indexed 1');
  assertTrue(found[1].source.startsWith('sequenceDiagram'), 'second fence source is right');
}
{
  const found = extractMermaidFences('```mermaid\ngraph TD\n  A --> B');
  assertEq(found.length, 0, 'an UNCLOSED fence is skipped (client treats it as streaming tail)');
}
{
  const found = extractMermaidFences('```python\nprint(1)\n```\n\n```mermaid\ngraph TD\n```');
  assertEq(found.length, 1, 'non-mermaid fences are ignored');
  assertEq(found[0].source, 'graph TD', 'only the mermaid fence is captured');
}
{
  // A longer closing fence must still close the block (client semantics).
  const found = extractMermaidFences('```mermaid\ngraph TD\n  A --> B\n`````');
  assertEq(found.length, 1, 'a longer closing fence still closes the block');
  assertEq(found[0].source, 'graph TD\n  A --> B', 'source ends at the closing fence');
}
{
  // A shorter closing fence must NOT close (the fence stays open).
  const found = extractMermaidFences('````mermaid\ngraph TD\n```');
  assertEq(found.length, 0, 'a shorter closing fence does not close the block');
}
{
  assertEq(extractMermaidFences('').length, 0, 'empty string yields no fences');
  assertEq(extractMermaidFences('no fences here').length, 0, 'prose yields no fences');
}
{
  // A blank line before the closing fence leaves one trailing newline. This
  // is deliberate client parity: `extractFrozenBlocks` slices the same range
  // and applies the same single `.replace(/\n$/, '')`, so the server
  // validates byte-identically to what the browser receives.
  const found = extractMermaidFences('```mermaid\ngraph TD\n  A --> B\n\n```');
  assertEq(
    found[0].source,
    'graph TD\n  A --> B\n',
    'blank line before the closing fence matches client slicing'
  );
}

// ── validateMermaidFences (runs the real mermaid) ─────────────────────────
// These assertions are the non-vacuity guard: if the validator ever stops
// actually parsing, the FAIL cases below stop being detected.
const VALID = [
  ['flowchart', 'graph TD\n  A[Start] --> B[End]'],
  ['classDiagram', 'classDiagram\n  class Foo\n  Foo --> Bar : has'],
  ['sequenceDiagram', 'sequenceDiagram\n  Alice->>Bob: Hi'],
  ['gantt', 'gantt\n  title T\n  dateFormat YYYY-MM-DD\n  section S\n  Task :a1, 2024-01-01, 30d'],
];
const INVALID = [
  ['unclosed bracket', 'graph TD\n  A[Start --> B[End]'],
  ['bad arrow', 'graph TD\n  A --> B =>  C'],
  ['unknown diagram type', 'notADiagram\n  A --> B'],
  ['malformed sequence', 'sequenceDiagram\n  Alice ->> Bob'],
];

for (const [name, source] of VALID) {
  const errors = await validateMermaidFences(fence(source));
  assertEq(errors.length, 0, `valid ${name} is accepted`);
}

for (const [name, source] of INVALID) {
  const errors = await validateMermaidFences(fence(source));
  assertEq(errors.length, 1, `invalid ${name} is rejected`);
  assertTrue(
    typeof errors[0].error === 'string' && errors[0].error.trim().length > 0,
    `invalid ${name} carries a human-readable reason`
  );
}

{
  const errors = await validateMermaidFences('no diagram here');
  assertEq(errors.length, 0, 'markdown with no fence validates clean');
}
{
  const md = `${fence('graph TD\n  A --> B')}\n\n${fence('graph TD\n  A[bad --> B[bad]')}`;
  const errors = await validateMermaidFences(md);
  assertEq(errors.length, 1, 'only the broken fence in a multi-fence response is reported');
  assertEq(errors[0].index, 1, 'the reported fence carries its own index');
}

// ── buildMermaidRecoveryNudge ─────────────────────────────────────────────
console.log('\nbuildMermaidRecoveryNudge');
{
  const errors = await validateMermaidFences(fence('graph TD\n  A[bad --> B[bad]'));
  const nudge = buildMermaidRecoveryNudge(errors);

  assertEq(nudge.role, 'user', 'nudge is a user-role message');
  assertTrue(nudge.content.startsWith(SYNTHETIC_NUDGE_MARKER), 'nudge is marker-prefixed');
  assertTrue(nudge.content.endsWith(SYNTHETIC_NUDGE_END), 'nudge ends with SYNTHETIC_NUDGE_END');
  assertTrue(nudge.content.includes(errors[0].error.trim()), 'nudge quotes the parse error');
  assertTrue(nudge.content.includes('failed to parse'), 'nudge explains the rejection');
  assertTrue(nudge.content.includes('```mermaid'), 'nudge tells the model to re-emit a fence');

  const second = buildMermaidRecoveryNudge(errors);
  assertTrue(nudge !== second, 'each call returns a fresh object (no shared mutable state)');
  assertEq(second.content, nudge.content, 'nudge content is deterministic');
}
{
  const two = buildMermaidRecoveryNudge([
    { index: 0, source: 'a', error: 'err-a' },
    { index: 1, source: 'b', error: 'err-b' },
  ]);
  assertTrue(two.content.includes('err-a'), 'multi-fence nudge includes the first error');
  assertTrue(two.content.includes('err-b'), 'multi-fence nudge includes the second error');
  assertTrue(two.content.includes('Diagram 1 of 2'), 'multi-fence nudge numbers its entries');
}

// ── MermaidRecoveryTracker ────────────────────────────────────────────────
console.log('\nMermaidRecoveryTracker');
{
  const tracker = new MermaidRecoveryTracker();
  assertEq(tracker.attemptsUsed, 0, 'starts with no attempts');
  assertTrue(tracker.shouldRecover(), 'allows a first retry');

  for (let i = 1; i <= MAX_MERMAID_RECOVERY_ATTEMPTS; i += 1) {
    tracker.recordAttempt();
    assertEq(tracker.attemptsUsed, i, `records attempt ${i}`);
  }

  assertEq(
    tracker.shouldRecover(),
    false,
    `stops retrying at the cap (${MAX_MERMAID_RECOVERY_ATTEMPTS})`
  );

  tracker.reset();
  assertEq(tracker.attemptsUsed, 0, 'reset clears the streak');
  assertTrue(tracker.shouldRecover(), 'allows retries again after reset');
}
{
  assertEq(MAX_MERMAID_RECOVERY_ATTEMPTS, 3, 'the cap constant is 3');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
