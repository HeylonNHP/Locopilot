/**
 * Focused checks for the run_command output store.
 *
 * The store owns the artifacts that back a spilled command output. Those
 * files are only useful if they are reachable, are removed when they go
 * stale, never take the artifacts of another session with them, and stay
 * private to the user who produced them. These checks pin all of that, plus
 * the budgets the sweeper applies and the metadata the model is given.
 *
 * Every scratch directory is created with `mkdtemp` (which is private by
 * construction) and removed in `afterAll`, so a failing assertion cannot
 * leave anything behind in the temporary directory.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
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

describe('run_command output store', () => {
  describe('Paths', () => {
    let pathRoot;
    beforeAll(() => {
      pathRoot = useRoot('paths');
    });

    test('the store root lives under the temporary directory', () => {
      const root = outputDirectory();
      expect(root).toBe(path.resolve(pathRoot));
      expect(root.startsWith(tmpdir())).toBeTruthy();
    });

    test('an artifact path is absolute and inside the store root', () => {
      const artifact = artifactPath('stdout.log', { sessionId: 42, runId: 'run-7' });
      expect(path.isAbsolute(artifact)).toBeTruthy();
      expect(artifact.startsWith(pathRoot + path.sep)).toBeTruthy();
      expect(path.basename(artifact)).toBe('stdout.log');
    });

    test('an artifact lands in a per-run subdirectory of its session', () => {
      const scope = { sessionId: 42, runId: 'run-7' };
      expect(runOutputDirectory(scope)).toBe(path.join(pathRoot, 'session-42', 'run-7'));
      expect(artifactPath('stdout.log', scope)).toBe(
        path.join(pathRoot, 'session-42', 'run-7', 'stdout.log')
      );
      expect(sessionOutputDirectory(42)).toBe(path.join(pathRoot, 'session-42'));
    });

    test('two runs of the same session never collide', () => {
      const first = artifactPath('stdout.log', { sessionId: 42, runId: 'run-1' });
      const second = artifactPath('stdout.log', { sessionId: 42, runId: 'run-2' });
      expect(first).not.toBe(second);
    });
  });

  describe('Privacy', () => {
    test('the directory of a run is private to its owner', () => {
      const mode = modeOf(runOutputDirectory({ sessionId: 42, runId: 'run-7' }));
      if (mode === null) return; // no POSIX modes on this platform
      expect(mode).toBe(0o700);
    });

    test('the session directory of a run is private to its owner', () => {
      const mode = modeOf(sessionOutputDirectory(42));
      if (mode === null) return;
      expect(mode).toBe(0o700);
    });

    test('a directory that already existed is tightened', () => {
      // A directory left behind by an older version of the store (or by a
      // writer that did not know about the modes) must not stay readable by
      // every local user.
      const session = sessionOutputDirectory(99);
      mkdirSync(session, { recursive: true });
      if (process.platform === 'win32') return;
      chmodSync(session, 0o755);
      runOutputDirectory({ sessionId: 99, runId: 'r1' });
      expect(modeOf(session)).toBe(0o700);
    });

    test('an artifact file can be made private to its owner', () => {
      const file = artifactPath('loose.log', { sessionId: 43, runId: 'run-1' });
      writeFileSync(file, 'x');
      if (process.platform === 'win32') return;
      chmodSync(file, 0o644);
      secureOutputFile(file);
      expect(modeOf(file)).toBe(0o600);
    });

    test('describing an artifact tightens its permissions', () => {
      const file = artifactPath('described.log', { sessionId: 43, runId: 'run-2' });
      writeFileSync(file, 'x');
      if (process.platform === 'win32') return;
      chmodSync(file, 0o644);
      describeOutputFile(file);
      expect(modeOf(file)).toBe(0o600);
    });

    test('a sweep tightens the permissions of the artifacts it finds', () => {
      const file = artifactPath('swept.log', { sessionId: 43, runId: 'run-3' });
      writeFileSync(file, 'x');
      if (process.platform === 'win32') return;
      chmodSync(file, 0o644);
      cleanupStaleOutputs();
      expect(modeOf(file)).toBe(0o600);
    });
  });

  describe('Retention', () => {
    beforeAll(() => {
      useRoot('age');
    });

    test('an artifact past the retention window is evicted', () => {
      const stale = artifactPath('stale.log', { sessionId: 1, runId: 'r1' });
      const fresh = artifactPath('fresh.log', { sessionId: 1, runId: 'r1' });
      writeAged(stale, 'old', 48 * 60 * 60 * 1000);
      writeAged(fresh, 'new', 60 * 1000);

      const report = cleanupStaleOutputs();
      expect(report.ok).toBe(true);
      expect(report.removed).toBe(1);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    });

    test('the eviction reports the bytes it reclaimed', () => {
      const file = artifactPath('bulk.log', { sessionId: 2, runId: 'r1' });
      writeAged(file, 'x'.repeat(4096), 48 * 60 * 60 * 1000);
      const report = cleanupStaleOutputs();
      expect(report.removed).toBe(1);
      expect(report.freedBytes).toBe(4096);
    });
  });

  describe('Size caps', () => {
    beforeAll(() => {
      useRoot('caps');
    });

    test('the per-session file cap evicts the oldest artifact first', () => {
      const session = sessionOutputDirectory(7);
      mkdirSync(session, { recursive: true });
      // 101 artifacts: one more than the cap allows.
      for (let index = 0; index < 101; index += 1) {
        const file = path.join(session, `artifact-${String(index).padStart(3, '0')}.log`);
        writeAged(file, 'x', (101 - index) * 1000);
      }

      cleanupStaleOutputs();
      expect(existsSync(path.join(session, 'artifact-000.log'))).toBe(false);
      expect(existsSync(path.join(session, 'artifact-001.log'))).toBe(true);
      expect(existsSync(path.join(session, 'artifact-100.log'))).toBe(true);
    });

    test('the per-session byte cap evicts the oldest artifact first', () => {
      const session = sessionOutputDirectory(8);
      mkdirSync(session, { recursive: true });
      // Three sparse files of 100 MiB each: more than the 250 MiB session cap.
      for (let index = 0; index < 3; index += 1) {
        const file = path.join(session, `big-${index}.log`);
        writeAged(file, '', (3 - index) * 1000);
        truncateSync(file, 100 * 1024 * 1024);
      }

      cleanupStaleOutputs();
      expect(existsSync(path.join(session, 'big-0.log'))).toBe(false);
      expect(existsSync(path.join(session, 'big-2.log'))).toBe(true);
    });
  });

  describe('The global budget', () => {
    let globalRoot;
    beforeAll(() => {
      globalRoot = useRoot('global');
    });

    test('the global file cap evicts the oldest artifacts across every session', () => {
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
        expect(report.ok).toBe(true);
        expect(report.removed).toBe(7);
      });

      // The five newest survive, the seven oldest are gone.
      for (let index = 0; index < 7; index += 1) {
        const file = path.join(
          globalRoot,
          `session-${index % 3}`,
          'run-1',
          `artifact-${String(index).padStart(2, '0')}.log`
        );
        expect(existsSync(file)).toBe(false);
      }
      for (let index = 7; index < 12; index += 1) {
        const file = path.join(
          globalRoot,
          `session-${index % 3}`,
          'run-1',
          `artifact-${String(index).padStart(2, '0')}.log`
        );
        expect(existsSync(file)).toBe(true);
      }
    });

    test('the global file cap holds after a second sweep', () => {
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
        expect(survivors).toHaveLength(5);
      });
    });

    test('the global byte cap evicts the oldest artifacts first', () => {
      const byteRoot = useRoot('global-bytes');
      for (let index = 0; index < 3; index += 1) {
        const file = path.join(byteRoot, `session-${index}`, 'run-1', `bulk-${index}.log`);
        writeAged(file, 'x'.repeat(1000), (3 - index) * 60 * 1000);
      }

      withEnv({ LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_BYTES: '2500' }, () => {
        const report = cleanupStaleOutputs();
        expect(report.ok).toBe(true);
        expect(report.removed).toBe(1);
        expect(report.freedBytes).toBe(1000);
      });

      expect(existsSync(path.join(byteRoot, 'session-0', 'run-1', 'bulk-0.log'))).toBe(false);
      expect(existsSync(path.join(byteRoot, 'session-1', 'run-1', 'bulk-1.log'))).toBe(true);
      expect(existsSync(path.join(byteRoot, 'session-2', 'run-1', 'bulk-2.log'))).toBe(true);
    });
  });

  describe('The budgets come from the environment', () => {
    beforeAll(() => {
      useRoot('budgets');
    });

    test('the budgets default to the values that shipped with the feature', () => {
      withEnv(
        {
          LOCOPILOT_RUN_OUTPUT_RETENTION_MS: undefined,
          LOCOPILOT_RUN_OUTPUT_SESSION_MAX_FILES: undefined,
          LOCOPILOT_RUN_OUTPUT_SESSION_MAX_BYTES: undefined,
          LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_FILES: undefined,
          LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_BYTES: undefined,
        },
        () => {
          expect(outputStoreLimits()).toStrictEqual({
            retentionMs: 24 * 60 * 60 * 1000,
            sessionMaxFiles: 100,
            sessionMaxBytes: 250 * 1024 * 1024,
            globalMaxFiles: 1000,
            globalMaxBytes: 1024 * 1024 * 1024,
          });
        }
      );
    });

    test('the budgets are read at call time, not at import time', () => {
      expect(outputStoreLimits().retentionMs).toBe(24 * 60 * 60 * 1000);
      process.env.LOCOPILOT_RUN_OUTPUT_RETENTION_MS = '1234';
      try {
        expect(outputStoreLimits().retentionMs).toBe(1234);
      } finally {
        delete process.env.LOCOPILOT_RUN_OUTPUT_RETENTION_MS;
      }
      expect(outputStoreLimits().retentionMs).toBe(24 * 60 * 60 * 1000);
    });

    test('a malformed budget falls back to the default', () => {
      withEnv(
        {
          LOCOPILOT_RUN_OUTPUT_RETENTION_MS: 'not-a-number',
          LOCOPILOT_RUN_OUTPUT_SESSION_MAX_FILES: '',
          LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_BYTES: '-1',
        },
        () => {
          const limits = outputStoreLimits();
          expect(limits.retentionMs).toBe(24 * 60 * 60 * 1000);
          expect(limits.sessionMaxFiles).toBe(100);
          expect(limits.globalMaxBytes).toBe(1024 * 1024 * 1024);
        }
      );
    });

    test('the retention window can be tightened', () => {
      const file = artifactPath('short-lived.log', { sessionId: 30, runId: 'r1' });
      writeAged(file, 'x', 60 * 1000);
      const fresh = artifactPath('kept.log', { sessionId: 30, runId: 'r1' });
      writeAged(fresh, 'x', 0);

      withEnv({ LOCOPILOT_RUN_OUTPUT_RETENTION_MS: '1000' }, () => {
        const report = cleanupStaleOutputs();
        expect(report.removed).toBe(1);
      });
      expect(existsSync(file)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    });

    test('the per-session file cap can be tightened', () => {
      const session = sessionOutputDirectory(31);
      mkdirSync(session, { recursive: true });
      for (let index = 0; index < 5; index += 1) {
        const file = path.join(session, `artifact-${index}.log`);
        writeAged(file, 'x', (5 - index) * 1000);
      }

      withEnv({ LOCOPILOT_RUN_OUTPUT_SESSION_MAX_FILES: '2' }, () => {
        cleanupStaleOutputs();
      });
      expect(existsSync(path.join(session, 'artifact-0.log'))).toBe(false);
      expect(existsSync(path.join(session, 'artifact-1.log'))).toBe(false);
      expect(existsSync(path.join(session, 'artifact-4.log'))).toBe(true);
    });
  });

  describe('Degradation', () => {
    let root;
    beforeAll(() => {
      root = useRoot('degradation');
    });

    test('a sweep of a missing directory does not throw', () => {
      process.env.LOCOPILOT_RUN_OUTPUT_DIR = path.join(root, 'not-there');
      const report = cleanupStaleOutputs();
      expect(report.ok).toBe(true);
      expect(report.removed).toBe(0);
    });

    test('a sweep of a root that is not a directory does not throw', () => {
      const file = path.join(root, 'a-file');
      writeFileSync(file, 'x');
      process.env.LOCOPILOT_RUN_OUTPUT_DIR = file;
      const report = cleanupStaleOutputs();
      expect(report.ok).toBe(true);
      expect(report.removed).toBe(0);
    });
  });

  describe('Session removal', () => {
    beforeAll(() => {
      useRoot('session');
    });

    test("removing a session removes only that session's artifacts", () => {
      const mine = artifactPath('mine.log', { sessionId: 100, runId: 'r1' });
      const other = artifactPath('other.log', { sessionId: 200, runId: 'r1' });
      const unscoped = artifactPath('loose.log', { runId: 'r1' });
      for (const file of [mine, other, unscoped]) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, 'x');
      }

      removeOutputsForSession(100);
      expect(existsSync(mine)).toBe(false);
      expect(existsSync(other)).toBe(true);
      expect(existsSync(unscoped)).toBe(true);
    });

    test('removing a session that produced nothing does not throw', () => {
      removeOutputsForSession(999);
    });
  });

  describe('The unscoped tree', () => {
    let unscopedRoot;
    beforeAll(() => {
      unscopedRoot = useRoot('unscoped');
    });

    test('an unscoped artifact past the retention window is evicted', () => {
      // The unscoped tree belongs to no session, so there is no session
      // deletion that could take it away: the age rule is the only thing
      // that will ever evict it.
      const file = path.join(unscopedRoot, 'unscoped', 'run-1', 'loose.log');
      writeAged(file, 'x', 48 * 60 * 60 * 1000);

      const report = cleanupStaleOutputs();
      expect(report.ok).toBe(true);
      expect(report.removed).toBe(1);
      expect(existsSync(file)).toBe(false);
    });

    test('the unscoped tree is bounded by the per-session budget', () => {
      const directory = path.join(unscopedRoot, 'unscoped', 'run-2');
      mkdirSync(directory, { recursive: true });
      for (let index = 0; index < 4; index += 1) {
        writeAged(path.join(directory, `artifact-${index}.log`), 'x', (4 - index) * 1000);
      }

      withEnv({ LOCOPILOT_RUN_OUTPUT_SESSION_MAX_FILES: '2' }, () => {
        cleanupStaleOutputs();
      });
      expect(existsSync(path.join(directory, 'artifact-0.log'))).toBe(false);
      expect(existsSync(path.join(directory, 'artifact-3.log'))).toBe(true);
    });
  });

  describe('The report', () => {
    test('a sweep reports what it did', () => {
      const file = artifactPath('reported.log', { sessionId: 40, runId: 'r1' });
      writeAged(file, 'x'.repeat(128), 48 * 60 * 60 * 1000);
      const report = cleanupStaleOutputs();
      expect(report.ok).toBe(true);
      expect(report.removed).toBe(1);
      expect(report.freedBytes).toBe(128);
      expect(report.error).toBeUndefined();
    });

    test('the diagnostic payload carries the counts of the sweep', () => {
      expect(cleanupDiagnosticPayload({ ok: true, removed: 2, freedBytes: 64 })).toStrictEqual({
        ok: true,
        removed: 2,
        freedBytes: 64,
      });
      expect(
        cleanupDiagnosticPayload({ ok: false, removed: 0, freedBytes: 0, error: 'broken' })
      ).toStrictEqual({ ok: false, removed: 0, freedBytes: 0, error: 'broken' });
    });
  });

  describe('Metadata', () => {
    let metaRoot;
    beforeAll(() => {
      metaRoot = useRoot('meta');
    });

    test('the metadata counts the lines of a file without a trailing newline', () => {
      const file = path.join(metaRoot, 'partial.log');
      writeFileSync(file, 'a\nb\nc');
      expect(describeOutputFile(file)).toStrictEqual({ bytes: 5, lines: 3 });
    });

    test('the metadata counts the lines of a file with a trailing newline', () => {
      const file = path.join(metaRoot, 'complete.log');
      writeFileSync(file, 'a\nb\n');
      expect(describeOutputFile(file)).toStrictEqual({ bytes: 4, lines: 2 });
    });

    test('the metadata of an empty file is zero', () => {
      const file = path.join(metaRoot, 'empty.log');
      writeFileSync(file, '');
      expect(describeOutputFile(file)).toStrictEqual({ bytes: 0, lines: 0 });
    });

    test('the metadata of a missing file is zero', () => {
      expect(describeOutputFile(path.join(metaRoot, 'missing.log'))).toStrictEqual({
        bytes: 0,
        lines: 0,
      });
    });
  });

  afterAll(() => {
    // The scratch roots are removed whether the tests passed or not, so a
    // failure cannot leave a directory behind in the temporary directory.
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
