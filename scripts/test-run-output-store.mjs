#!/usr/bin/env node
/**
 * Focused checks for the run_command output store.
 *
 * Run with: npx tsx scripts/test-run-output-store.mjs
 *
 * The store owns the artifacts that back a spilled command output. Those
 * files are only useful if they are reachable, are removed when they go
 * stale, never take the artifacts of another session with them, and stay
 * private to the user who produced them. These checks pin all of that, plus
 * the budgets the sweeper applies and the metadata the model is given.
 *
 * Every scratch directory is created with `mkdtemp` (which is private by
 * construction) and removed in a `finally`, so a failing assertion cannot
 * leave anything behind in the temporary directory.
 */

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  cleanupDiagnosticPayload,
  cleanupStaleOutputs,
  describeOutputFile,
  outputDirectory,
  outputStoreLimits,
  removeOutputsForSession,
  runOutputDirectory,
  secureOutputFile,
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

/** The scratch roots of this run; every one of them is removed at the end. */
const roots = [];

/** A scratch root for one group of checks; the store is pointed at it. */
function useRoot(name) {
  const root = mkdtempSync(path.join(tmpdir(), `locopilot-store-${name}-`));
  roots.push(root);
  process.env.LOCOPILOT_RUN_OUTPUT_DIR = root;
  return root;
}

/**
 * The path of one artifact inside the directory of its run.
 *
 * WHY the path is composed here and not taken from the store: the store
 * exposes the DIRECTORY of a run, and the name of the file inside it is
 * the writer's business. Composing the two keeps the test honest about
 * what the store actually promises.
 */
function artifactPath(name, scope) {
  return path.join(runOutputDirectory(scope), name);
}

/** Writes a file and back-dates it, so the age rule can see it. */
function writeAged(filePath, content, ageMs) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  const stamp = (Date.now() - ageMs) / 1000;
  utimesSync(filePath, stamp, stamp);
}

/** Runs a check with temporary environment overrides, then restores them. */
function withEnv(values, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The permission bits of a path, or null when the platform has none. */
function modeOf(target) {
  if (process.platform === 'win32') return null;
  return statSync(target).mode & 0o777;
}

console.log('run_command output store');

try {
  // ── Paths ──────────────────────────────────────────────────────────────
  const pathRoot = useRoot('paths');

  check('the store root lives under the temporary directory', () => {
    const root = outputDirectory();
    assert.equal(root, path.resolve(pathRoot));
    assert.ok(root.startsWith(tmpdir()));
  });

  check('an artifact path is absolute and inside the store root', () => {
    const artifact = artifactPath('stdout.log', { sessionId: 42, runId: 'run-7' });
    assert.ok(path.isAbsolute(artifact));
    assert.ok(artifact.startsWith(pathRoot + path.sep));
    assert.equal(path.basename(artifact), 'stdout.log');
  });

  check('an artifact lands in a per-run subdirectory of its session', () => {
    const scope = { sessionId: 42, runId: 'run-7' };
    assert.equal(runOutputDirectory(scope), path.join(pathRoot, 'session-42', 'run-7'));
    assert.equal(
      artifactPath('stdout.log', scope),
      path.join(pathRoot, 'session-42', 'run-7', 'stdout.log')
    );
    assert.equal(sessionOutputDirectory(42), path.join(pathRoot, 'session-42'));
  });

  check('two runs of the same session never collide', () => {
    const first = artifactPath('stdout.log', { sessionId: 42, runId: 'run-1' });
    const second = artifactPath('stdout.log', { sessionId: 42, runId: 'run-2' });
    assert.notEqual(first, second);
  });

  // ── Privacy ────────────────────────────────────────────────────────────
  check('the directory of a run is private to its owner', () => {
    const mode = modeOf(runOutputDirectory({ sessionId: 42, runId: 'run-7' }));
    if (mode === null) return; // no POSIX modes on this platform
    assert.equal(mode, 0o700, `the run directory has mode ${mode.toString(8)}`);
  });

  check('the session directory of a run is private to its owner', () => {
    const mode = modeOf(sessionOutputDirectory(42));
    if (mode === null) return;
    assert.equal(mode, 0o700, `the session directory has mode ${mode.toString(8)}`);
  });

  check('a directory that already existed is tightened', () => {
    // A directory left behind by an older version of the store (or by a
    // writer that did not know about the modes) must not stay readable by
    // every local user.
    const session = sessionOutputDirectory(99);
    mkdirSync(session, { recursive: true });
    if (process.platform === 'win32') return;
    chmodSync(session, 0o755);
    runOutputDirectory({ sessionId: 99, runId: 'r1' });
    assert.equal(modeOf(session), 0o700);
  });

  check('an artifact file can be made private to its owner', () => {
    const file = artifactPath('loose.log', { sessionId: 43, runId: 'run-1' });
    writeFileSync(file, 'x');
    if (process.platform === 'win32') return;
    chmodSync(file, 0o644);
    secureOutputFile(file);
    assert.equal(modeOf(file), 0o600);
  });

  check('describing an artifact tightens its permissions', () => {
    const file = artifactPath('described.log', { sessionId: 43, runId: 'run-2' });
    writeFileSync(file, 'x');
    if (process.platform === 'win32') return;
    chmodSync(file, 0o644);
    describeOutputFile(file);
    assert.equal(modeOf(file), 0o600);
  });

  check('a sweep tightens the permissions of the artifacts it finds', () => {
    const file = artifactPath('swept.log', { sessionId: 43, runId: 'run-3' });
    writeFileSync(file, 'x');
    if (process.platform === 'win32') return;
    chmodSync(file, 0o644);
    cleanupStaleOutputs();
    assert.equal(modeOf(file), 0o600);
  });

  // ── Retention ──────────────────────────────────────────────────────────
  useRoot('age');

  check('an artifact past the retention window is evicted', () => {
    const stale = artifactPath('stale.log', { sessionId: 1, runId: 'r1' });
    const fresh = artifactPath('fresh.log', { sessionId: 1, runId: 'r1' });
    writeAged(stale, 'old', 48 * 60 * 60 * 1000);
    writeAged(fresh, 'new', 60 * 1000);

    const report = cleanupStaleOutputs();
    assert.equal(report.ok, true);
    assert.equal(report.removed, 1);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(fresh), true);
  });

  check('the eviction reports the bytes it reclaimed', () => {
    const file = artifactPath('bulk.log', { sessionId: 2, runId: 'r1' });
    writeAged(file, 'x'.repeat(4096), 48 * 60 * 60 * 1000);
    const report = cleanupStaleOutputs();
    assert.equal(report.removed, 1);
    assert.equal(report.freedBytes, 4096);
  });

  // ── Size caps ──────────────────────────────────────────────────────────
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

  // ── The global budget ──────────────────────────────────────────────────
  const globalRoot = useRoot('global');

  check('the global file cap evicts the oldest artifacts across every session', () => {
    // Twelve artifacts spread over three sessions: a per-session cap would
    // not touch them, a global one has to.
    for (let index = 0; index < 12; index += 1) {
      const file = path.join(
        globalRoot,
        `session-${index % 3}`,
        'run-1',
        `artifact-${String(index).padStart(2, '0')}.log`
      );
      writeAged(file, 'x', (12 - index) * 60 * 1000);
    }

    withEnv({ LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_FILES: '5' }, () => {
      const report = cleanupStaleOutputs();
      assert.equal(report.ok, true);
      assert.equal(report.removed, 7);
    });

    // The five newest survive, the seven oldest are gone.
    for (let index = 0; index < 7; index += 1) {
      const file = path.join(
        globalRoot,
        `session-${index % 3}`,
        'run-1',
        `artifact-${String(index).padStart(2, '0')}.log`
      );
      assert.equal(existsSync(file), false, `artifact-${index} should have been evicted`);
    }
    for (let index = 7; index < 12; index += 1) {
      const file = path.join(
        globalRoot,
        `session-${index % 3}`,
        'run-1',
        `artifact-${String(index).padStart(2, '0')}.log`
      );
      assert.equal(existsSync(file), true, `artifact-${index} should have been kept`);
    }
  });

  check('the global file cap holds after a second sweep', () => {
    withEnv({ LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_FILES: '5' }, () => {
      cleanupStaleOutputs();
      const survivors = [];
      for (let index = 7; index < 12; index += 1) {
        const file = path.join(
          globalRoot,
          `session-${index % 3}`,
          'run-1',
          `artifact-${String(index).padStart(2, '0')}.log`
        );
        if (existsSync(file)) survivors.push(file);
      }
      assert.equal(survivors.length, 5);
    });
  });

  check('the global byte cap evicts the oldest artifacts first', () => {
    const byteRoot = useRoot('global-bytes');
    for (let index = 0; index < 3; index += 1) {
      const file = path.join(byteRoot, `session-${index}`, 'run-1', `bulk-${index}.log`);
      writeAged(file, 'x'.repeat(1000), (3 - index) * 60 * 1000);
    }

    withEnv({ LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_BYTES: '2500' }, () => {
      const report = cleanupStaleOutputs();
      assert.equal(report.ok, true);
      assert.equal(report.removed, 1);
      assert.equal(report.freedBytes, 1000);
    });

    assert.equal(existsSync(path.join(byteRoot, 'session-0', 'run-1', 'bulk-0.log')), false);
    assert.equal(existsSync(path.join(byteRoot, 'session-1', 'run-1', 'bulk-1.log')), true);
    assert.equal(existsSync(path.join(byteRoot, 'session-2', 'run-1', 'bulk-2.log')), true);
  });

  // ── The budgets come from the environment ──────────────────────────────
  useRoot('budgets');

  check('the budgets default to the values that shipped with the feature', () => {
    withEnv(
      {
        LOCOPILOT_RUN_OUTPUT_RETENTION_MS: undefined,
        LOCOPILOT_RUN_OUTPUT_SESSION_MAX_FILES: undefined,
        LOCOPILOT_RUN_OUTPUT_SESSION_MAX_BYTES: undefined,
        LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_FILES: undefined,
        LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_BYTES: undefined,
      },
      () => {
        assert.deepEqual(outputStoreLimits(), {
          retentionMs: 24 * 60 * 60 * 1000,
          sessionMaxFiles: 100,
          sessionMaxBytes: 250 * 1024 * 1024,
          globalMaxFiles: 1000,
          globalMaxBytes: 1024 * 1024 * 1024,
        });
      }
    );
  });

  check('the budgets are read at call time, not at import time', () => {
    assert.equal(outputStoreLimits().retentionMs, 24 * 60 * 60 * 1000);
    process.env.LOCOPILOT_RUN_OUTPUT_RETENTION_MS = '1234';
    try {
      assert.equal(outputStoreLimits().retentionMs, 1234);
    } finally {
      delete process.env.LOCOPILOT_RUN_OUTPUT_RETENTION_MS;
    }
    assert.equal(outputStoreLimits().retentionMs, 24 * 60 * 60 * 1000);
  });

  check('a malformed budget falls back to the default', () => {
    withEnv(
      {
        LOCOPILOT_RUN_OUTPUT_RETENTION_MS: 'not-a-number',
        LOCOPILOT_RUN_OUTPUT_SESSION_MAX_FILES: '',
        LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_BYTES: '-1',
      },
      () => {
        const limits = outputStoreLimits();
        assert.equal(limits.retentionMs, 24 * 60 * 60 * 1000);
        assert.equal(limits.sessionMaxFiles, 100);
        assert.equal(limits.globalMaxBytes, 1024 * 1024 * 1024);
      }
    );
  });

  check('the retention window can be tightened', () => {
    const file = artifactPath('short-lived.log', { sessionId: 30, runId: 'r1' });
    writeAged(file, 'x', 60 * 1000);
    const fresh = artifactPath('kept.log', { sessionId: 30, runId: 'r1' });
    writeAged(fresh, 'x', 0);

    withEnv({ LOCOPILOT_RUN_OUTPUT_RETENTION_MS: '1000' }, () => {
      const report = cleanupStaleOutputs();
      assert.equal(report.removed, 1);
    });
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(fresh), true);
  });

  check('the per-session file cap can be tightened', () => {
    const session = sessionOutputDirectory(31);
    mkdirSync(session, { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      const file = path.join(session, `artifact-${index}.log`);
      writeAged(file, 'x', (5 - index) * 1000);
    }

    withEnv({ LOCOPILOT_RUN_OUTPUT_SESSION_MAX_FILES: '2' }, () => {
      cleanupStaleOutputs();
    });
    assert.equal(existsSync(path.join(session, 'artifact-0.log')), false);
    assert.equal(existsSync(path.join(session, 'artifact-1.log')), false);
    assert.equal(existsSync(path.join(session, 'artifact-4.log')), true);
  });

  // ── Degradation ────────────────────────────────────────────────────────
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

  // ── Session removal ────────────────────────────────────────────────────
  useRoot('session');

  check("removing a session removes only that session's artifacts", () => {
    const mine = artifactPath('mine.log', { sessionId: 100, runId: 'r1' });
    const other = artifactPath('other.log', { sessionId: 200, runId: 'r1' });
    const unscoped = artifactPath('loose.log', { runId: 'r1' });
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

  // ── The unscoped tree ──────────────────────────────────────────────────
  const unscopedRoot = useRoot('unscoped');

  check('an unscoped artifact past the retention window is evicted', () => {
    // The unscoped tree belongs to no session, so there is no session
    // deletion that could take it away: the age rule is the only thing
    // that will ever evict it.
    const file = path.join(unscopedRoot, 'unscoped', 'run-1', 'loose.log');
    writeAged(file, 'x', 48 * 60 * 60 * 1000);

    const report = cleanupStaleOutputs();
    assert.equal(report.ok, true);
    assert.equal(report.removed, 1);
    assert.equal(existsSync(file), false);
  });

  check('the unscoped tree is bounded by the per-session budget', () => {
    const directory = path.join(unscopedRoot, 'unscoped', 'run-2');
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      writeAged(path.join(directory, `artifact-${index}.log`), 'x', (4 - index) * 1000);
    }

    withEnv({ LOCOPILOT_RUN_OUTPUT_SESSION_MAX_FILES: '2' }, () => {
      cleanupStaleOutputs();
    });
    assert.equal(existsSync(path.join(directory, 'artifact-0.log')), false);
    assert.equal(existsSync(path.join(directory, 'artifact-3.log')), true);
  });

  // ── The report ─────────────────────────────────────────────────────────
  check('a sweep reports what it did', () => {
    const file = artifactPath('reported.log', { sessionId: 40, runId: 'r1' });
    writeAged(file, 'x'.repeat(128), 48 * 60 * 60 * 1000);
    const report = cleanupStaleOutputs();
    assert.equal(report.ok, true);
    assert.equal(report.removed, 1);
    assert.equal(report.freedBytes, 128);
    assert.equal(report.error, undefined);
  });

  check('the diagnostic payload carries the counts of the sweep', () => {
    assert.deepEqual(cleanupDiagnosticPayload({ ok: true, removed: 2, freedBytes: 64 }), {
      ok: true,
      removed: 2,
      freedBytes: 64,
    });
    assert.deepEqual(
      cleanupDiagnosticPayload({ ok: false, removed: 0, freedBytes: 0, error: 'broken' }),
      { ok: false, removed: 0, freedBytes: 0, error: 'broken' }
    );
  });

  // ── Metadata ───────────────────────────────────────────────────────────
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
    assert.deepEqual(describeOutputFile(path.join(metaRoot, 'missing.log')), {
      bytes: 0,
      lines: 0,
    });
  });
} finally {
  // The scratch roots are removed whether the checks passed or not, so a
  // failure cannot leave a directory behind in the temporary directory.
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
