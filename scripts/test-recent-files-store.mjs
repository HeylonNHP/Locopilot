#!/usr/bin/env node
/**
 * Tests for the recent-files store (src/services/history.ts) and the tool
 * hook that feeds it (src/tools/fileTouchRecorder.ts).
 *
 * Run with: npx tsx scripts/test-recent-files-store.mjs
 *
 * WHY this store exists: after a conversation is compacted the model has lost
 * track of the files it was working on and re-reads them from scratch. The
 * paths only ever lived inside the `tool_calls` JSON of the messages, and a
 * compaction REPLACES every message row of the session — so the whole point
 * of the table is that it survives `updateSessionMessages` untouched. That is
 * the check the file is named after; everything else guards a way it could
 * quietly stop being true (a replacement instead of an upsert, a prune that
 * eats the wrong rows, a cascade that never fires, a failed tool call
 * recorded as a touch).
 *
 * ISOLATION: the database path is `process.cwd()`-relative
 * (`DB_PATH` in src/services/paths.ts is `path.join(process.cwd(), …)`), so
 * this script `process.chdir`s into a fresh `mkdtemp` BEFORE importing the
 * store. Importing it first would open — and mutate — the real
 * ./locopilot.db of the checkout. The scratch directory is removed in a
 * `finally`, so a failing assertion cannot leave a database behind.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** Resolves a repo-relative module against this script, not against the cwd. */
const here = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = (relative) => pathToFileURL(path.join(here, relative)).href;

const root = mkdtempSync(path.join(tmpdir(), 'locopilot-recent-files-'));
const previousCwd = process.cwd();

try {
  // The chdir MUST happen before the dynamic import: `history.ts` builds
  // `DB_PATH` at module load from `process.cwd()`.
  process.chdir(root);

  const {
    createSession,
    deleteSession,
    loadRecentFiles,
    recordTouchedFile,
    updateSessionMessages,
  } = await import(moduleUrl('../src/services/history.ts'));

  const { isFailedToolResult, recordToolFileTouch } = await import(
    moduleUrl('../src/tools/fileTouchRecorder.ts')
  );

  const { setAgentWorkingDirectory, WorkingDirectoryScope } = await import(
    moduleUrl('../src/tools/workingDirectory.ts')
  );

  /** A realistic replacement transcript: a user prompt and an assistant reply. */
  const replacementMessages = () => [
    { role: 'user', content: 'compact me', createdAt: new Date().toISOString() },
    { role: 'assistant', content: 'summary: we were editing files' },
  ];

  console.log('recent files store');

  // ── Ordering and the limit ─────────────────────────────────────────────
  check('the store keeps the 5 most recent of 7 paths, newest first', () => {
    const sid = createSession('ordering', 'test-model');
    // Explicit `now` values: the rows must be ordered by the stored stamp,
    // not by the order the INSERTs happened to run in.
    for (let index = 0; index < 7; index += 1) {
      recordTouchedFile(sid, `/repo/file-${index}.ts`, 'read_file', 1000 + index);
    }

    const rows = loadRecentFiles(sid, 5);
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map((row) => row.path),
      [
        '/repo/file-6.ts',
        '/repo/file-5.ts',
        '/repo/file-4.ts',
        '/repo/file-3.ts',
        '/repo/file-2.ts',
      ]
    );
    assert.equal(rows[0].tool, 'read_file');
    assert.equal(rows[0].hits, 1);
    assert.equal(rows[0].lastSeenAt, 1006);
  });

  check('a limit larger than the row count returns every row', () => {
    const sid = createSession('limit-large', 'test-model');
    recordTouchedFile(sid, '/repo/only.ts', 'read_file', 5000);
    assert.equal(loadRecentFiles(sid, 100).length, 1);
  });

  check('a non-positive limit returns no rows', () => {
    const sid = createSession('limit-zero', 'test-model');
    recordTouchedFile(sid, '/repo/only.ts', 'read_file', 5000);
    assert.deepEqual(loadRecentFiles(sid, 0), []);
    assert.deepEqual(loadRecentFiles(sid, -3), []);
  });

  // ── The upsert ─────────────────────────────────────────────────────────
  check('re-touching a path increments hits and moves it to the top', () => {
    const sid = createSession('upsert', 'test-model');
    recordTouchedFile(sid, '/repo/a.ts', 'read_file', 1000);
    recordTouchedFile(sid, '/repo/b.ts', 'read_file', 2000);
    recordTouchedFile(sid, '/repo/c.ts', 'write_file', 3000);

    // Touch `a` again: same key, so it is bumped, not duplicated.
    recordTouchedFile(sid, '/repo/a.ts', 'patch_file', 4000);

    const rows = loadRecentFiles(sid, 10);
    assert.equal(rows.length, 3, 'a second row was created for the same path');
    assert.equal(rows[0].path, '/repo/a.ts');
    assert.equal(rows[0].hits, 2);
    assert.equal(rows[0].tool, 'patch_file', 'the tool of the latest touch should win');
    assert.equal(rows[0].lastSeenAt, 4000);
    assert.equal(rows[1].path, '/repo/c.ts');
    assert.equal(rows[2].path, '/repo/b.ts');
  });

  check('the same path in two sessions is two independent rows', () => {
    const first = createSession('shared-a', 'test-model');
    const second = createSession('shared-b', 'test-model');
    recordTouchedFile(first, '/repo/shared.ts', 'read_file', 1000);
    recordTouchedFile(second, '/repo/shared.ts', 'read_file', 2000);
    recordTouchedFile(second, '/repo/shared.ts', 'read_file', 3000);

    assert.equal(loadRecentFiles(first, 10)[0].hits, 1);
    assert.equal(loadRecentFiles(second, 10)[0].hits, 2);
  });

  // ── The prune ──────────────────────────────────────────────────────────
  check('30 distinct paths are pruned to the 24 most recent', () => {
    const sid = createSession('prune', 'test-model');
    for (let index = 0; index < 30; index += 1) {
      recordTouchedFile(
        sid,
        `/repo/prune-${String(index).padStart(2, '0')}.ts`,
        'read_file',
        index
      );
    }

    const rows = loadRecentFiles(sid, 100);
    assert.equal(rows.length, 24, 'the session was not pruned to 24 rows');
    // The 24 newest survive: prune-06 … prune-29.
    assert.equal(rows[0].path, '/repo/prune-29.ts');
    assert.equal(rows.at(-1).path, '/repo/prune-06.ts');
    const survivors = new Set(rows.map((row) => row.path));
    assert.equal(survivors.has('/repo/prune-05.ts'), false, 'an old path survived the prune');
  });

  check('pruning one session leaves another session untouched', () => {
    const noisy = createSession('prune-noisy', 'test-model');
    const quiet = createSession('prune-quiet', 'test-model');
    recordTouchedFile(quiet, '/repo/quiet.ts', 'read_file', 1_000_000);
    for (let index = 0; index < 30; index += 1) {
      recordTouchedFile(noisy, `/repo/noisy-${index}.ts`, 'read_file', index);
    }

    assert.equal(loadRecentFiles(noisy, 100).length, 24);
    assert.equal(loadRecentFiles(quiet, 100).length, 1);
  });

  // ── THE POINT ──────────────────────────────────────────────────────────
  check('the rows survive updateSessionMessages', () => {
    const sid = createSession('survives-compaction', 'test-model');
    recordTouchedFile(sid, '/repo/keep-me.ts', 'read_file', Date.now() - 60_000);
    recordTouchedFile(sid, '/repo/keep-me-too.ts', 'write_file', Date.now());

    // This is what a persisted compaction does: it REPLACES every message row
    // of the session. The recent files must not be part of that replacement.
    updateSessionMessages(sid, replacementMessages());

    const rows = loadRecentFiles(sid, 10);
    assert.equal(rows.length, 2, 'the compaction wiped the recent files');
    assert.equal(rows[0].path, '/repo/keep-me-too.ts');
    assert.equal(rows[1].path, '/repo/keep-me.ts');
    assert.equal(rows[0].tool, 'write_file');
  });

  check('the rows survive an emptying updateSessionMessages too', () => {
    const sid = createSession('survives-empty', 'test-model');
    recordTouchedFile(sid, '/repo/empty-survivor.ts', 'patch_file', 1234);
    updateSessionMessages(sid, []);
    const rows = loadRecentFiles(sid, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lastSeenAt, 1234);
  });

  check('a touch after a compaction still lands on the surviving row', () => {
    const sid = createSession('touch-after-compaction', 'test-model');
    recordTouchedFile(sid, '/repo/again.ts', 'read_file', 1000);
    updateSessionMessages(sid, replacementMessages());
    recordTouchedFile(sid, '/repo/again.ts', 'patch_file', 2000);

    const rows = loadRecentFiles(sid, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hits, 2);
    assert.equal(rows[0].lastSeenAt, 2000);
  });

  // ── The cascade ────────────────────────────────────────────────────────
  check('deleting the session removes its recent files', () => {
    const sid = createSession('cascade', 'test-model');
    recordTouchedFile(sid, '/repo/cascade.ts', 'read_file', 1000);
    assert.equal(loadRecentFiles(sid, 10).length, 1);

    deleteSession(sid);
    assert.deepEqual(loadRecentFiles(sid, 10), [], 'the cascade did not fire');
  });

  check('deleting a session leaves the rows of the others alone', () => {
    const doomed = createSession('cascade-doomed', 'test-model');
    const survivor = createSession('cascade-survivor', 'test-model');
    recordTouchedFile(doomed, '/repo/doomed.ts', 'read_file', 1000);
    recordTouchedFile(survivor, '/repo/survivor.ts', 'read_file', 1000);

    deleteSession(doomed);
    assert.deepEqual(loadRecentFiles(doomed, 10), []);
    assert.equal(loadRecentFiles(survivor, 10).length, 1);
  });

  // ── Degradation ────────────────────────────────────────────────────────
  check('an unknown session returns no rows', () => {
    assert.deepEqual(loadRecentFiles(987_654, 10), []);
  });

  check('a non-finite session id does not throw and records nothing', () => {
    assert.doesNotThrow(() => recordTouchedFile(Number.NaN, '/repo/nan.ts', 'read_file'));
    assert.doesNotThrow(() =>
      recordTouchedFile(Number.POSITIVE_INFINITY, '/repo/inf.ts', 'read_file')
    );
    assert.doesNotThrow(() => recordTouchedFile(1.5, '/repo/fraction.ts', 'read_file'));
    assert.deepEqual(loadRecentFiles(Number.NaN, 10), []);
  });

  check('an empty path is not recorded', () => {
    const sid = createSession('empty-path', 'test-model');
    recordTouchedFile(sid, '   ', 'read_file', 1000);
    assert.deepEqual(loadRecentFiles(sid, 10), []);
  });

  check('a session id that was never created cannot accumulate rows', () => {
    // The foreign key rejects the insert, so a ghost id can never have rows:
    // `loadRecentFiles` answers [] for it, before and after the attempt.
    const ghost = 424_242;
    recordTouchedFile(ghost, '/repo/ghost.ts', 'read_file', 1000);
    assert.deepEqual(loadRecentFiles(ghost, 10), []);
  });

  // ── The hook's failure predicate ───────────────────────────────────────
  check('the failure predicates match the prefixes the file tools emit', () => {
    assert.equal(isFailedToolResult('[Error: missing required argument "path"]'), true);
    assert.equal(isFailedToolResult('[read_file error: unable to access file: ENOENT]'), true);
    assert.equal(isFailedToolResult('[write_file error: failed to write file: EACCES]'), true);
    assert.equal(isFailedToolResult('[patch_file error: patch 1 of 2 was not found]'), true);
    assert.equal(
      isFailedToolResult('[patch_file error: target path is not a regular file.]'),
      true
    );
  });

  check('the success shapes of the file tools are not treated as failures', () => {
    assert.equal(isFailedToolResult('read_file_result:\npath: /repo/a.ts\ncontents:\nhi'), false);
    assert.equal(isFailedToolResult('patch_file_result:\npath: /repo/a.ts\naction: patch'), false);
    assert.equal(
      isFailedToolResult('write_file_result:\npath: /repo/a.ts\naction: overwrite'),
      false
    );
    assert.equal(isFailedToolResult(''), false);
  });

  check('a failed tool result records nothing', () => {
    const sid = createSession('hook-failure', 'test-model');
    const context = { sessionId: sid, yoloMode: true };
    recordToolFileTouch(
      'read_file',
      { path: '/repo/missing.ts' },
      { content: '[read_file error: unable to access file: ENOENT]' },
      context
    );
    recordToolFileTouch(
      'patch_file',
      { path: '/repo/missing.ts' },
      { content: '[Error: missing required argument "patches"]' },
      context
    );
    assert.deepEqual(loadRecentFiles(sid, 10), []);
  });

  check('only read_file, patch_file, and write_file record a touch', () => {
    const sid = createSession('hook-tools', 'test-model');
    const context = { sessionId: sid, yoloMode: true };
    recordToolFileTouch('read_pdf', { path: '/repo/doc.pdf' }, { content: 'pdf text' }, context);
    recordToolFileTouch('fetch_image', { source: '/repo/pic.png' }, { content: 'ok' }, context);
    recordToolFileTouch('run_command', { command: 'ls', cwd: '/repo' }, { content: 'ok' }, context);
    recordToolFileTouch('create_skill', { name: 'x', body: 'y' }, { content: 'ok' }, context);
    assert.deepEqual(loadRecentFiles(sid, 10), []);
  });

  check('no session id means no touch', () => {
    // Sub-agents have no session id, and they bypass the hook anyway.
    const sid = createSession('no-session-id', 'test-model');
    recordToolFileTouch('read_file', { path: '/repo/a.ts' }, { content: 'ok' }, { yoloMode: true });
    recordToolFileTouch('read_file', { path: '/repo/a.ts' }, { content: 'ok' }, undefined);
    assert.deepEqual(loadRecentFiles(sid, 10), []);
  });

  // ── Absolute paths ─────────────────────────────────────────────────────
  check('a relative read_file path is recorded absolute, under the working directory', () => {
    const sid = createSession('absolute', 'test-model');
    const scope = new WorkingDirectoryScope();
    setAgentWorkingDirectory(scope, '/work/project');

    recordToolFileTouch(
      'read_file',
      { path: ' src/app.ts ' },
      { content: 'read_file_result:\npath: /work/project/src/app.ts' },
      { sessionId: sid, yoloMode: true, workingDirectoryScope: scope }
    );

    const rows = loadRecentFiles(sid, 5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, '/work/project/src/app.ts');
    assert.equal(path.isAbsolute(rows[0].path), true);
  });

  check('an absolute path is stored unchanged', () => {
    const sid = createSession('absolute-input', 'test-model');
    const scope = new WorkingDirectoryScope();
    setAgentWorkingDirectory(scope, '/work/project');

    recordToolFileTouch(
      'write_file',
      { path: '/elsewhere/notes.md' },
      { content: 'write_file_result:\npath: /elsewhere/notes.md' },
      { sessionId: sid, yoloMode: true, workingDirectoryScope: scope }
    );

    assert.equal(loadRecentFiles(sid, 5)[0].path, '/elsewhere/notes.md');
  });

  check('a drifted working directory cannot re-key a file that was already seen', () => {
    const sid = createSession('drift', 'test-model');
    const scope = new WorkingDirectoryScope();
    const context = { sessionId: sid, yoloMode: true, workingDirectoryScope: scope };

    setAgentWorkingDirectory(scope, '/work/one');
    recordToolFileTouch('read_file', { path: 'app.ts' }, { content: 'ok' }, context);

    // The shell prompt moved: 'app.ts' now names a DIFFERENT file, so it gets
    // its own row — the two are not the same file.
    setAgentWorkingDirectory(scope, '/work/two');
    recordToolFileTouch('read_file', { path: 'app.ts' }, { content: 'ok' }, context);

    // The first file is reached again by its absolute path: it must land on
    // the row recorded before the drift, not on a third one.
    recordToolFileTouch('patch_file', { path: '/work/one/app.ts' }, { content: 'ok' }, context);

    const rows = loadRecentFiles(sid, 10);
    assert.equal(rows.length, 2, `expected 2 rows, got ${rows.map((row) => row.path).join(', ')}`);
    assert.equal(rows[0].path, '/work/one/app.ts');
    assert.equal(rows[0].hits, 2);
    assert.equal(rows[1].path, '/work/two/app.ts');
  });

  check('an unknown tool name is a no-op rather than an error', () => {
    assert.doesNotThrow(() => {
      recordToolFileTouch(
        'not_a_tool',
        { path: '/repo/a.ts' },
        { content: 'ok' },
        { sessionId: 1 }
      );
    });
  });
} finally {
  // Restore the cwd before removing the scratch root (Windows keeps the
  // directory busy while it is the cwd) and never leave the DB behind.
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
