/**
 * Tests for the compaction selection at the session PATCH boundary.
 *
 * WHY this exists: the compaction model and the compaction provider used to
 * be two independent fields, so a conversation could hold a compaction MODEL
 * without the provider that serves it. That is the state that sent a
 * compaction model to an endpoint that did not have it, and it came back a
 * 404 with nothing to explain why. The selection is now ONE value with three
 * states (`inherit-default`, `same-as-main`, `explicit`), and this route is
 * where a caller tries to write the fourth one — or, from a tab that was
 * open before the change, the old flat pair.
 *
 * The route is called IN PROCESS, in a TEMPORARY directory: the working
 * directory is changed before the route is imported, so the database it opens
 * is a scratch file. The owner's `locopilot.db` is never touched.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
/** Resolves a repo-relative module against this script, not against the cwd. */
const moduleUrl = (relative) => pathToFileURL(path.join(here, relative)).href;

let tmp;
let PATCH;
let createSession;
let getSessionSelection;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'locopilot-session-pair-'));
  // `history.ts` builds `DB_PATH` at module load, so the cwd moves FIRST.
  process.chdir(tmp);
  ({ createSession, getSessionSelection } = await import(
    moduleUrl('../src/services/history.ts')
  ));
  ({ PATCH } = await import(moduleUrl('../src/app/api/sessions/[id]/route.ts')));
});

afterAll(() => {
  process.chdir(repoRoot);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while `history.ts` holds it open.
  }
});

async function patch(sessionId, body) {
  const response = await PATCH(
    new Request(`http://localhost/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(sessionId) }) }
  );
  return { status: response.status, json: await response.json() };
}

const BASE = {
  model: 'main-model',
  providerId: 'ollama',
  compaction: { kind: 'inherit-default' },
  reasoningEffort: null,
  compactionReasoningEffort: null,
};

const EXPLICIT = { kind: 'explicit', model: 'cheap-compactor', providerId: 'openai' };

describe('PATCH /api/sessions/[id] — the compaction selection', () => {
  test('a compaction selection that names a model WITHOUT its provider is REFUSED', async () => {
    const id = createSession('New chat', BASE);
    const { status, json } = await patch(id, {
      compaction: { kind: 'explicit', model: 'cheap-compactor' },
    });

    expect(status).toBe(400);
    expect(json.error).toContain('cheap-compactor');
    // The row is untouched: a refused write changes nothing.
    expect(getSessionSelection(id).compaction).toEqual({ kind: 'inherit-default' });
  });

  test('a compaction selection with an unknown kind is REFUSED', async () => {
    const id = createSession('New chat', BASE);
    const { status, json } = await patch(id, { compaction: { kind: 'half-a-pair' } });

    expect(status).toBe(400);
    expect(json.error).toContain('compaction must be one of');
    expect(getSessionSelection(id).compaction).toEqual({ kind: 'inherit-default' });
  });

  test('an explicit selection is accepted, and stored as a pair', async () => {
    const id = createSession('New chat', BASE);
    const { status, json } = await patch(id, { compaction: EXPLICIT });

    expect(status).toBe(200);
    expect(json.selection.compaction).toEqual(EXPLICIT);

    const stored = getSessionSelection(id);
    expect(stored.compaction).toEqual(EXPLICIT);
  });

  test('"same as the main model" is accepted — it carries no provider of its own', async () => {
    const id = createSession('New chat', { ...BASE, compaction: EXPLICIT });
    const { status, json } = await patch(id, { compaction: { kind: 'same-as-main' } });

    expect(status).toBe(200);
    expect(json.selection.compaction).toEqual({ kind: 'same-as-main' });
    expect(getSessionSelection(id).compaction).toEqual({ kind: 'same-as-main' });
  });

  test('"inherit the global default" is accepted', async () => {
    const id = createSession('New chat', { ...BASE, compaction: EXPLICIT });
    const { status, json } = await patch(id, { compaction: { kind: 'inherit-default' } });

    expect(status).toBe(200);
    expect(json.selection.compaction).toEqual({ kind: 'inherit-default' });
    expect(getSessionSelection(id).compaction).toEqual({ kind: 'inherit-default' });
  });

  test('a patch that touches only the main model leaves the selection alone', async () => {
    const id = createSession('New chat', { ...BASE, compaction: EXPLICIT });
    const { status, json } = await patch(id, { model: 'another-model' });

    expect(status).toBe(200);
    expect(json.selection.model).toBe('another-model');
    expect(json.selection.compaction).toEqual(EXPLICIT);
    expect(getSessionSelection(id).compaction).toEqual(EXPLICIT);
  });

  describe('the LEGACY flat pair (a tab open before the change)', () => {
    test('both halves together are still accepted', async () => {
      const id = createSession('New chat', BASE);
      const { status, json } = await patch(id, {
        compactionModel: 'cheap-compactor',
        compactionProviderId: 'openai',
      });

      expect(status).toBe(200);
      expect(json.selection.compaction).toEqual(EXPLICIT);
      expect(getSessionSelection(id).compaction).toEqual(EXPLICIT);
    });

    test('the model WITHOUT its provider is REFUSED', async () => {
      const id = createSession('New chat', BASE);
      const { status, json } = await patch(id, { compactionModel: 'cheap-compactor' });

      expect(status).toBe(400);
      expect(json.error).toContain('cheap-compactor');
      expect(getSessionSelection(id).compaction).toEqual({ kind: 'inherit-default' });
    });

    test('the provider WITHOUT its model is REFUSED', async () => {
      const id = createSession('New chat', BASE);
      const { status, json } = await patch(id, { compactionProviderId: 'openai' });

      expect(status).toBe(400);
      expect(json.error).not.toBeNull();
      expect(getSessionSelection(id).compaction).toEqual({ kind: 'inherit-default' });
    });
  });
});
