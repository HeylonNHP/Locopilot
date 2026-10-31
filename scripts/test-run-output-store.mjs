#!/usr/bin/env node
/**
 * Focused checks for the run_command output store.
 *
 * Run with: npx tsx scripts/test-run-output-store.mjs
 *
 * The store owns the artifacts that back a spilled command output. Those
 * files are only useful if they are reachable, are removed when they go
 * stale, and never take the artifacts of another session with them. These
 * checks pin all three, plus the metadata the model is given about a file.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  cleanupStaleOutputs,
  createOutputPath,
  describeOutputFile,
  outputDirectory,
  removeOutputsForSession,
  runOutputDirectory,
  sessionOutputDirectory,
} from '../src/tools/runCommandOutputStore.ts';

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
}

/** A scratch root for one group of checks; the store is pointed at it. */
function useRoot(name) {
  const root = mkdtempSync(path.join(tmpdir(), `locopilot-store-${name}-`));
  process.env.LOCOPILOT_RUN_OUTPUT_DIR = root;
  return root;
}

/** Writes a file and back-dates it, so the age rule can see it. */
function writeAged(filePath, content, ageMs) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  const stamp = (Date.now() - ageMs) / 1000;
  utimesSync(filePath, stamp, stamp);
}

console.log('run_command output store');

// ── Paths ────────────────────────────────────────────────────────────────
const pathRoot = useRoot('paths');

check('the store root lives under the temporary directory', () => {
  const root = outputDirectory();
  assert.equal(root, path.resolve(pathRoot));
  assert.ok(root.startsWith(tmpdir()));
});

check('an artifact path is absolute and inside the store root', () => {
  const artifact = createOutputPath('stdout.log', { sessionId: 42, runId: 'run-7' });
  assert.ok(path.isAbsolute(artifact));
  assert.ok(artifact.startsWith(pathRoot + path.sep));
  assert.equal(path.basename(artifact), 'stdout.log');
});

check('an artifact lands in a per-run subdirectory of its session', () => {
  const scope = { sessionId: 42, runId: 'run-7' };
  assert.equal(runOutputDirectory(scope), path.join(pathRoot, 'session-42', 'run-7'));
  assert.equal(
    createOutputPath('stdout.log', scope),
    path.join(pathRoot, 'session-42', 'run-7', 'stdout.log')
  );
  assert.equal(sessionOutputDirectory(42), path.join(pathRoot, 'session-42'));
});

check('two runs of the same session never collide', () => {
  const first = createOutputPath('stdout.log', { sessionId: 42, runId: 'run-1' });
  const second = createOutputPath('stdout.log', { sessionId: 42, runId: 'run-2' });
  assert.notEqual(first, second);
});

// ── Retention ────────────────────────────────────────────────────────────
const ageRoot = useRoot('age');

check('an artifact past the retention window is evicted', () => {
  const stale = createOutputPath('stale.log', { sessionId: 1, runId: 'r1' });
  const fresh = createOutputPath('fresh.log', { sessionId: 1, runId: 'r1' });
  writeAged(stale, 'old', 48 * 60 * 60 * 1000);
  writeAged(fresh, 'new', 60 * 1000);

  const report = cleanupStaleOutputs();
  assert.equal(report.ok, true);
  assert.equal(report.removed, 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

check('the eviction reports the bytes it reclaimed', () => {
  const file = createOutputPath('bulk.log', { sessionId: 2, runId: 'r1' });
  writeAged(file, 'x'.repeat(4096), 48 * 60 * 60 * 1000);
  const report = cleanupStaleOutputs();
  assert.equal(report.removed, 1);
  assert.equal(report.freedBytes, 4096);
});

// ── Size caps ────────────────────────────────────────────────────────────
const capRoot = useRoot('caps');

check('the per-session file cap evicts the oldest artifact first', () => {
  const session = sessionOutputDirectory(7);
  mkdirSync(session, { recursive: true });
  // 101 artifacts: one more than the cap allows.
  for (let index = 0; index < 101; index += 1) {
    const file = path.join(session, `artifact-${String(index).padStart(3, '0')}.log`);
    writeAged(file, 'x', (101 - index) * 1000);
  }

  cleanupStaleOutputs();
  assert.equal(existsSync(path.join(session, 'artifact-000.log')), false);
  assert.equal(existsSync(path.join(session, 'artifact-001.log')), true);
  assert.equal(existsSync(path.join(session, 'artifact-100.log')), true);
});

check('the per-session byte cap evicts the oldest artifact first', () => {
  const session = sessionOutputDirectory(8);
  mkdirSync(session, { recursive: true });
  // Three sparse files of 100 MiB each: more than the 250 MiB session cap.
  for (let index = 0; index < 3; index += 1) {
    const file = path.join(session, `big-${index}.log`);
    writeAged(file, '', (3 - index) * 1000);
    truncateSync(file, 100 * 1024 * 1024);
  }

  cleanupStaleOutputs();
  assert.equal(existsSync(path.join(session, 'big-0.log')), false);
  assert.equal(existsSync(path.join(session, 'big-2.log')), true);
});

// ── Degradation ──────────────────────────────────────────────────────────
check('a sweep of a missing directory does not throw', () => {
  process.env.LOCOPILOT_RUN_OUTPUT_DIR = path.join(capRoot, 'not-there');
  const report = cleanupStaleOutputs();
  assert.equal(report.ok, true);
  assert.equal(report.removed, 0);
});

check('a sweep of a root that is not a directory does not throw', () => {
  const file = path.join(capRoot, 'a-file');
  writeFileSync(file, 'x');
  process.env.LOCOPILOT_RUN_OUTPUT_DIR = file;
  const report = cleanupStaleOutputs();
  assert.equal(report.ok, true);
  assert.equal(report.removed, 0);
});

// ── Session removal ──────────────────────────────────────────────────────
const sessionRoot = useRoot('session');

check("removing a session removes only that session's artifacts", () => {
  const mine = createOutputPath('mine.log', { sessionId: 100, runId: 'r1' });
  const other = createOutputPath('other.log', { sessionId: 200, runId: 'r1' });
  const unscoped = createOutputPath('loose.log', { runId: 'r1' });
  for (const file of [mine, other, unscoped]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'x');
  }

  removeOutputsForSession(100);
  assert.equal(existsSync(mine), false);
  assert.equal(existsSync(other), true);
  assert.equal(existsSync(unscoped), true);
});

check('removing a session that produced nothing does not throw', () => {
  removeOutputsForSession(999);
});

// ── Metadata ─────────────────────────────────────────────────────────────
const metaRoot = useRoot('meta');

check('the metadata counts the lines of a file without a trailing newline', () => {
  const file = path.join(metaRoot, 'partial.log');
  writeFileSync(file, 'a\nb\nc');
  assert.deepEqual(describeOutputFile(file), { bytes: 5, lines: 3 });
});

check('the metadata counts the lines of a file with a trailing newline', () => {
  const file = path.join(metaRoot, 'complete.log');
  writeFileSync(file, 'a\nb\n');
  assert.deepEqual(describeOutputFile(file), { bytes: 4, lines: 2 });
});

check('the metadata of an empty file is zero', () => {
  const file = path.join(metaRoot, 'empty.log');
  writeFileSync(file, '');
  assert.deepEqual(describeOutputFile(file), { bytes: 0, lines: 0 });
});

check('the metadata of a missing file is zero', () => {
  assert.deepEqual(describeOutputFile(path.join(metaRoot, 'missing.log')), { bytes: 0, lines: 0 });
});

rmSync(pathRoot, { recursive: true, force: true });
rmSync(ageRoot, { recursive: true, force: true });
rmSync(capRoot, { recursive: true, force: true });
rmSync(sessionRoot, { recursive: true, force: true });
rmSync(metaRoot, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
