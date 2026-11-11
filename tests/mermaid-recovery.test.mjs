/**
 * Tests for the Mermaid pre-display validation and recovery policy
 * (src/services/mermaidRecovery.ts).
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

import { describe, expect, test } from '@jest/globals';

import { MAX_MERMAID_RECOVERY_ATTEMPTS } from '../src/constants.ts';
import { SYNTHETIC_NUDGE_END, SYNTHETIC_NUDGE_MARKER } from '../src/services/compact/constants.ts';
import {
  buildMermaidRecoveryNudge,
  extractMermaidFences,
  mayContainMermaidFence,
  MermaidRecoveryTracker,
  validateMermaidFences,
} from '../src/services/mermaidRecovery.ts';

const fence = (source) => `\`\`\`mermaid\n${source}\n\`\`\``;

describe('mayContainMermaidFence', () => {
  test.each([
    ['detects ```mermaid', 'text\n```mermaid\ngraph TD\n```', true],
    ['detects ~~~mermaid', '~~~mermaid\ngraph TD\n~~~', true],
    ['plain prose is not a fence', 'just prose, no diagram', false],
    ['a non-mermaid fence is not a mermaid fence', '```python\nprint(1)\n```', false],
  ])('%s', (_label, input, expected) => {
    expect(mayContainMermaidFence(input)).toBe(expected);
  });
});

// Mirrors the client's `extractFrozenBlocks`.
describe('extractMermaidFences', () => {
  test('extracts a single closed fence', () => {
    const found = extractMermaidFences(fence('graph TD\n  A --> B'));
    expect(found).toHaveLength(1);
    // the source excludes the fence markers
    expect(found[0].source).toBe('graph TD\n  A --> B');
    expect(found[0].index).toBe(0);
  });

  test('extracts a tilde fence', () => {
    const found = extractMermaidFences('~~~mermaid\ngraph TD\n  A --> B\n~~~');
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('graph TD\n  A --> B');
  });

  test('extracts multiple fences, each with its own index', () => {
    const md = `${fence('graph TD\n  A --> B')}\n\nsome prose\n\n${fence('sequenceDiagram\n  A->>B: hi')}`;
    const found = extractMermaidFences(md);
    expect(found).toHaveLength(2);
    expect(found[1].index).toBe(1);
    expect(found[1].source.startsWith('sequenceDiagram')).toBe(true);
  });

  test('skips an UNCLOSED fence (the client treats it as the streaming tail)', () => {
    expect(extractMermaidFences('```mermaid\ngraph TD\n  A --> B')).toHaveLength(0);
  });

  test('ignores non-mermaid fences', () => {
    const found = extractMermaidFences('```python\nprint(1)\n```\n\n```mermaid\ngraph TD\n```');
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('graph TD');
  });

  test('a longer closing fence still closes the block', () => {
    const found = extractMermaidFences('```mermaid\ngraph TD\n  A --> B\n`````');
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('graph TD\n  A --> B');
  });

  test('a shorter closing fence does not close the block', () => {
    expect(extractMermaidFences('````mermaid\ngraph TD\n```')).toHaveLength(0);
  });

  test.each([
    ['an empty string', ''],
    ['prose', 'no fences here'],
  ])('yields no fences for %s', (_label, input) => {
    expect(extractMermaidFences(input)).toHaveLength(0);
  });

  test('a blank line before the closing fence leaves one trailing newline', () => {
    // Deliberate client parity: `extractFrozenBlocks` slices the same range
    // and applies the same single `.replace(/\n$/, '')`, so the server
    // validates byte-identically to what the browser receives.
    const found = extractMermaidFences('```mermaid\ngraph TD\n  A --> B\n\n```');
    expect(found[0].source).toBe('graph TD\n  A --> B\n');
  });
});

// These runs use the real mermaid. They are the non-vacuity guard: if the
// validator ever stops actually parsing, the invalid cases stop being detected.
describe('validateMermaidFences', () => {
  test.each([
    ['flowchart', 'graph TD\n  A[Start] --> B[End]'],
    ['classDiagram', 'classDiagram\n  class Foo\n  Foo --> Bar : has'],
    ['sequenceDiagram', 'sequenceDiagram\n  Alice->>Bob: Hi'],
    [
      'gantt',
      'gantt\n  title T\n  dateFormat YYYY-MM-DD\n  section S\n  Task :a1, 2024-01-01, 30d',
    ],
  ])('accepts a valid %s', async (_name, source) => {
    expect(await validateMermaidFences(fence(source))).toHaveLength(0);
  });

  test.each([
    ['unclosed bracket', 'graph TD\n  A[Start --> B[End]'],
    ['bad arrow', 'graph TD\n  A --> B =>  C'],
    ['unknown diagram type', 'notADiagram\n  A --> B'],
    ['malformed sequence', 'sequenceDiagram\n  Alice ->> Bob'],
  ])('rejects an invalid %s, with a human-readable reason', async (_name, source) => {
    const errors = await validateMermaidFences(fence(source));
    expect(errors).toHaveLength(1);
    expect(typeof errors[0].error).toBe('string');
    expect(errors[0].error.trim().length).toBeGreaterThan(0);
  });

  test('markdown with no fence validates clean', async () => {
    expect(await validateMermaidFences('no diagram here')).toHaveLength(0);
  });

  test('reports only the broken fence in a multi-fence response, with its own index', async () => {
    const md = `${fence('graph TD\n  A --> B')}\n\n${fence('graph TD\n  A[bad --> B[bad]')}`;
    const errors = await validateMermaidFences(md);
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(1);
  });
});

describe('buildMermaidRecoveryNudge', () => {
  test('builds a marker-prefixed user message that quotes the parse error', async () => {
    const errors = await validateMermaidFences(fence('graph TD\n  A[bad --> B[bad]'));
    const nudge = buildMermaidRecoveryNudge(errors);

    expect(nudge.role).toBe('user');
    expect(nudge.content.startsWith(SYNTHETIC_NUDGE_MARKER)).toBe(true);
    expect(nudge.content.endsWith(SYNTHETIC_NUDGE_END)).toBe(true);
    expect(nudge.content).toContain(errors[0].error.trim());
    // the nudge explains the rejection
    expect(nudge.content).toContain('failed to parse');
    // the nudge tells the model to re-emit a fence
    expect(nudge.content).toContain('```mermaid');
  });

  test('is deterministic and returns a fresh object each call', async () => {
    const errors = await validateMermaidFences(fence('graph TD\n  A[bad --> B[bad]'));
    const first = buildMermaidRecoveryNudge(errors);
    const second = buildMermaidRecoveryNudge(errors);
    // no shared mutable state
    expect(first).not.toBe(second);
    expect(second.content).toBe(first.content);
  });

  test('numbers the entries of a multi-fence nudge', () => {
    const two = buildMermaidRecoveryNudge([
      { index: 0, source: 'a', error: 'err-a' },
      { index: 1, source: 'b', error: 'err-b' },
    ]);
    expect(two.content).toContain('err-a');
    expect(two.content).toContain('err-b');
    expect(two.content).toContain('Diagram 1 of 2');
  });
});

describe('MermaidRecoveryTracker', () => {
  test('the cap constant is 3', () => {
    expect(MAX_MERMAID_RECOVERY_ATTEMPTS).toBe(3);
  });

  test('starts with no attempts and allows a first retry', () => {
    const tracker = new MermaidRecoveryTracker();
    expect(tracker.attemptsUsed).toBe(0);
    expect(tracker.shouldRecover()).toBe(true);
  });

  test('records each attempt and stops retrying at the cap', () => {
    const tracker = new MermaidRecoveryTracker();
    for (let attempt = 1; attempt <= MAX_MERMAID_RECOVERY_ATTEMPTS; attempt += 1) {
      tracker.recordAttempt();
      expect(tracker.attemptsUsed).toBe(attempt);
    }
    expect(tracker.shouldRecover()).toBe(false);
  });

  test('reset clears the streak and allows retries again', () => {
    const tracker = new MermaidRecoveryTracker();
    for (let attempt = 0; attempt < MAX_MERMAID_RECOVERY_ATTEMPTS; attempt += 1) {
      tracker.recordAttempt();
    }
    tracker.reset();
    expect(tracker.attemptsUsed).toBe(0);
    expect(tracker.shouldRecover()).toBe(true);
  });
});
