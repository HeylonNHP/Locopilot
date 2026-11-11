/**
 * Tests for the recent-files store (src/services/history.ts) and the tool
 * hook that feeds it (src/tools/fileTouchRecorder.ts).
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
 * `afterAll`, so a failing assertion cannot leave a database behind.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Resolves a repo-relative module against this script, not against the cwd. */
const here = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = (relative) => pathToFileURL(path.join(here, relative)).href;

const root = mkdtempSync(path.join(tmpdir(), 'locopilot-recent-files-'));
const previousCwd = process.cwd();

let createSession;
let deleteSession;
let loadRecentFiles;
let recordTouchedFile;
let updateSessionMessages;
let isFailedToolResult;
let recordToolFileTouch;
let setAgentWorkingDirectory;
let WorkingDirectoryScope;

beforeAll(async () => {
  // The chdir MUST happen before the dynamic import: `history.ts` builds
  // `DB_PATH` at module load from `process.cwd()`.
  process.chdir(root);

  ({ createSession, deleteSession, loadRecentFiles, recordTouchedFile, updateSessionMessages } =
    await import(moduleUrl('../src/services/history.ts')));
  ({ isFailedToolResult, recordToolFileTouch } = await import(
    moduleUrl('../src/tools/fileTouchRecorder.ts')
  ));
  ({ setAgentWorkingDirectory, WorkingDirectoryScope } = await import(
    moduleUrl('../src/tools/workingDirectory.ts')
  ));
});

afterAll(() => {
  // Restore the cwd before removing the scratch root (Windows keeps the
  // directory busy while it is the cwd) and never leave the DB behind.
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
});

/** A realistic replacement transcript: a user prompt and an assistant reply. */
const replacementMessages = () => [
  { role: 'user', content: 'compact me', createdAt: new Date().toISOString() },
  { role: 'assistant', content: 'summary: we were editing files' },
];

describe('the recent files store', () => {
  describe('ordering and the limit', () => {
    test('the store keeps the 5 most recent of 7 paths, newest first', () => {
      const sid = createSession('ordering', 'test-model');
      // Explicit `now` values: the rows must be ordered by the stored stamp,
      // not by the order the INSERTs happened to run in.
      for (let index = 0; index < 7; index += 1) {
        recordTouchedFile(sid, `/repo/file-${index}.ts`, 'read_file', 1000 + index);
      }

      const rows = loadRecentFiles(sid, 5);
      expect(rows).toHaveLength(5);
      expect(rows.map((row) => row.path)).toStrictEqual([
        '/repo/file-6.ts',
        '/repo/file-5.ts',
        '/repo/file-4.ts',
        '/repo/file-3.ts',
        '/repo/file-2.ts',
      ]);
      expect(rows[0].tool).toBe('read_file');
      expect(rows[0].hits).toBe(1);
      expect(rows[0].lastSeenAt).toBe(1006);
    });

    test('a limit larger than the row count returns every row', () => {
      const sid = createSession('limit-large', 'test-model');
      recordTouchedFile(sid, '/repo/only.ts', 'read_file', 5000);
      expect(loadRecentFiles(sid, 100)).toHaveLength(1);
    });

    test('a non-positive limit returns no rows', () => {
      const sid = createSession('limit-zero', 'test-model');
      recordTouchedFile(sid, '/repo/only.ts', 'read_file', 5000);
      expect(loadRecentFiles(sid, 0)).toStrictEqual([]);
      expect(loadRecentFiles(sid, -3)).toStrictEqual([]);
    });
  });

  describe('the upsert', () => {
    test('re-touching a path increments hits and moves it to the top', () => {
      const sid = createSession('upsert', 'test-model');
      recordTouchedFile(sid, '/repo/a.ts', 'read_file', 1000);
      recordTouchedFile(sid, '/repo/b.ts', 'read_file', 2000);
      recordTouchedFile(sid, '/repo/c.ts', 'write_file', 3000);

      // Touch `a` again: same key, so it is bumped, not duplicated.
      recordTouchedFile(sid, '/repo/a.ts', 'patch_file', 4000);

      const rows = loadRecentFiles(sid, 10);
      expect(rows).toHaveLength(3);
      expect(rows[0].path).toBe('/repo/a.ts');
      expect(rows[0].hits).toBe(2);
      expect(rows[0].tool).toBe('patch_file');
      expect(rows[0].lastSeenAt).toBe(4000);
      expect(rows[1].path).toBe('/repo/c.ts');
      expect(rows[2].path).toBe('/repo/b.ts');
    });

    test('the same path in two sessions is two independent rows', () => {
      const first = createSession('shared-a', 'test-model');
      const second = createSession('shared-b', 'test-model');
      recordTouchedFile(first, '/repo/shared.ts', 'read_file', 1000);
      recordTouchedFile(second, '/repo/shared.ts', 'read_file', 2000);
      recordTouchedFile(second, '/repo/shared.ts', 'read_file', 3000);

      expect(loadRecentFiles(first, 10)[0].hits).toBe(1);
      expect(loadRecentFiles(second, 10)[0].hits).toBe(2);
    });
  });

  describe('the prune', () => {
    test('30 distinct paths are pruned to the 24 most recent', () => {
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
      expect(rows).toHaveLength(24);
      // The 24 newest survive: prune-06 … prune-29.
      expect(rows[0].path).toBe('/repo/prune-29.ts');
      expect(rows.at(-1).path).toBe('/repo/prune-06.ts');
      const survivors = new Set(rows.map((row) => row.path));
      expect(survivors.has('/repo/prune-05.ts')).toBe(false);
    });

    test('pruning one session leaves another session untouched', () => {
      const noisy = createSession('prune-noisy', 'test-model');
      const quiet = createSession('prune-quiet', 'test-model');
      recordTouchedFile(quiet, '/repo/quiet.ts', 'read_file', 1_000_000);
      for (let index = 0; index < 30; index += 1) {
        recordTouchedFile(noisy, `/repo/noisy-${index}.ts`, 'read_file', index);
      }

      expect(loadRecentFiles(noisy, 100)).toHaveLength(24);
      expect(loadRecentFiles(quiet, 100)).toHaveLength(1);
    });
  });

  describe('The point', () => {
    test('the rows survive updateSessionMessages', () => {
      const sid = createSession('survives-compaction', 'test-model');
      recordTouchedFile(sid, '/repo/keep-me.ts', 'read_file', Date.now() - 60_000);
      recordTouchedFile(sid, '/repo/keep-me-too.ts', 'write_file', Date.now());

      // This is what a persisted compaction does: it REPLACES every message row
      // of the session. The recent files must not be part of that replacement.
      updateSessionMessages(sid, replacementMessages());

      const rows = loadRecentFiles(sid, 10);
      expect(rows).toHaveLength(2);
      expect(rows[0].path).toBe('/repo/keep-me-too.ts');
      expect(rows[1].path).toBe('/repo/keep-me.ts');
      expect(rows[0].tool).toBe('write_file');
    });

    test('the rows survive an emptying updateSessionMessages too', () => {
      const sid = createSession('survives-empty', 'test-model');
      recordTouchedFile(sid, '/repo/empty-survivor.ts', 'patch_file', 1234);
      updateSessionMessages(sid, []);
      const rows = loadRecentFiles(sid, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0].lastSeenAt).toBe(1234);
    });

    test('a touch after a compaction still lands on the surviving row', () => {
      const sid = createSession('touch-after-compaction', 'test-model');
      recordTouchedFile(sid, '/repo/again.ts', 'read_file', 1000);
      updateSessionMessages(sid, replacementMessages());
      recordTouchedFile(sid, '/repo/again.ts', 'patch_file', 2000);

      const rows = loadRecentFiles(sid, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0].hits).toBe(2);
      expect(rows[0].lastSeenAt).toBe(2000);
    });
  });

  describe('the cascade', () => {
    test('deleting the session removes its recent files', () => {
      const sid = createSession('cascade', 'test-model');
      recordTouchedFile(sid, '/repo/cascade.ts', 'read_file', 1000);
      expect(loadRecentFiles(sid, 10)).toHaveLength(1);

      deleteSession(sid);
      expect(loadRecentFiles(sid, 10)).toStrictEqual([]);
    });

    test('deleting a session leaves the rows of the others alone', () => {
      const doomed = createSession('cascade-doomed', 'test-model');
      const survivor = createSession('cascade-survivor', 'test-model');
      recordTouchedFile(doomed, '/repo/doomed.ts', 'read_file', 1000);
      recordTouchedFile(survivor, '/repo/survivor.ts', 'read_file', 1000);

      deleteSession(doomed);
      expect(loadRecentFiles(doomed, 10)).toStrictEqual([]);
      expect(loadRecentFiles(survivor, 10)).toHaveLength(1);
    });
  });

  describe('degradation', () => {
    test('an unknown session returns no rows', () => {
      expect(loadRecentFiles(987_654, 10)).toStrictEqual([]);
    });

    test('a non-finite session id does not throw and records nothing', () => {
      expect(() => recordTouchedFile(Number.NaN, '/repo/nan.ts', 'read_file')).not.toThrow();
      expect(() =>
        recordTouchedFile(Number.POSITIVE_INFINITY, '/repo/inf.ts', 'read_file')
      ).not.toThrow();
      expect(() => recordTouchedFile(1.5, '/repo/fraction.ts', 'read_file')).not.toThrow();
      expect(loadRecentFiles(Number.NaN, 10)).toStrictEqual([]);
    });

    test('an empty path is not recorded', () => {
      const sid = createSession('empty-path', 'test-model');
      recordTouchedFile(sid, '   ', 'read_file', 1000);
      expect(loadRecentFiles(sid, 10)).toStrictEqual([]);
    });

    test('a session id that was never created cannot accumulate rows', () => {
      // The foreign key rejects the insert, so a ghost id can never have rows:
      // `loadRecentFiles` answers [] for it, before and after the attempt.
      const ghost = 424_242;
      recordTouchedFile(ghost, '/repo/ghost.ts', 'read_file', 1000);
      expect(loadRecentFiles(ghost, 10)).toStrictEqual([]);
    });
  });

  describe("the hook's failure predicate", () => {
    test('the failure predicates match the prefixes the file tools emit', () => {
      expect(isFailedToolResult('[Error: missing required argument "path"]')).toBe(true);
      expect(isFailedToolResult('[read_file error: unable to access file: ENOENT]')).toBe(true);
      expect(isFailedToolResult('[write_file error: failed to write file: EACCES]')).toBe(true);
      expect(isFailedToolResult('[patch_file error: patch 1 of 2 was not found]')).toBe(true);
      expect(isFailedToolResult('[patch_file error: target path is not a regular file.]')).toBe(
        true
      );
    });

    test('the success shapes of the file tools are not treated as failures', () => {
      expect(isFailedToolResult('read_file_result:\npath: /repo/a.ts\ncontents:\nhi')).toBe(false);
      expect(isFailedToolResult('patch_file_result:\npath: /repo/a.ts\naction: patch')).toBe(false);
      expect(isFailedToolResult('write_file_result:\npath: /repo/a.ts\naction: overwrite')).toBe(
        false
      );
      expect(isFailedToolResult('')).toBe(false);
    });

    test('a failed tool result records nothing', () => {
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
      expect(loadRecentFiles(sid, 10)).toStrictEqual([]);
    });

    test('only read_file, patch_file, and write_file record a touch', () => {
      const sid = createSession('hook-tools', 'test-model');
      const context = { sessionId: sid, yoloMode: true };
      recordToolFileTouch('read_pdf', { path: '/repo/doc.pdf' }, { content: 'pdf text' }, context);
      recordToolFileTouch('fetch_image', { source: '/repo/pic.png' }, { content: 'ok' }, context);
      recordToolFileTouch(
        'run_command',
        { command: 'ls', cwd: '/repo' },
        { content: 'ok' },
        context
      );
      recordToolFileTouch('create_skill', { name: 'x', body: 'y' }, { content: 'ok' }, context);
      expect(loadRecentFiles(sid, 10)).toStrictEqual([]);
    });

    test('no session id means no touch', () => {
      // Sub-agents have no session id, and they bypass the hook anyway.
      const sid = createSession('no-session-id', 'test-model');
      recordToolFileTouch(
        'read_file',
        { path: '/repo/a.ts' },
        { content: 'ok' },
        { yoloMode: true }
      );
      recordToolFileTouch('read_file', { path: '/repo/a.ts' }, { content: 'ok' }, undefined);
      expect(loadRecentFiles(sid, 10)).toStrictEqual([]);
    });
  });

  describe('absolute paths', () => {
    test('a relative read_file path is recorded absolute, under the working directory', () => {
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
      expect(rows).toHaveLength(1);
      expect(rows[0].path).toBe('/work/project/src/app.ts');
      expect(path.isAbsolute(rows[0].path)).toBe(true);
    });

    test('an absolute path is stored unchanged', () => {
      const sid = createSession('absolute-input', 'test-model');
      const scope = new WorkingDirectoryScope();
      setAgentWorkingDirectory(scope, '/work/project');

      recordToolFileTouch(
        'write_file',
        { path: '/elsewhere/notes.md' },
        { content: 'write_file_result:\npath: /elsewhere/notes.md' },
        { sessionId: sid, yoloMode: true, workingDirectoryScope: scope }
      );

      expect(loadRecentFiles(sid, 5)[0].path).toBe('/elsewhere/notes.md');
    });

    test('a drifted working directory cannot re-key a file that was already seen', () => {
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
      expect(rows).toHaveLength(2);
      expect(rows[0].path).toBe('/work/one/app.ts');
      expect(rows[0].hits).toBe(2);
      expect(rows[1].path).toBe('/work/two/app.ts');
    });

    test('an unknown tool name is a no-op rather than an error', () => {
      expect(() => {
        recordToolFileTouch(
          'not_a_tool',
          { path: '/repo/a.ts' },
          { content: 'ok' },
          { sessionId: 1 }
        );
      }).not.toThrow();
    });
  });
});
