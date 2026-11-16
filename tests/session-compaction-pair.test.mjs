/**
 * Tests for the compaction pair at the session PATCH boundary.
 *
 * WHY this exists: the compaction model and the compaction provider used to
 * be two independent fields, so a conversation could hold a compaction MODEL
 * without the provider that serves it. That is the state that sent a
 * compaction model to an endpoint that did not have it, and it came back a
 * 404 with nothing to explain why. The pair is now ONE value with three
 * states (`inherit-default`, `same-as-main`, `explicit`), and this route is
 * where a caller tries to write the fourth one.
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
  compactionModel: null,
  compactionProviderId: null,
  reasoningEffort: null,
  compactionReasoningEffort: null,
};

describe('PATCH /api/sessions/[id] — the compaction pair', () => {
  test('a compaction model WITHOUT its provider is REFUSED', async () => {
    const id = createSession('New chat', BASE);
    const { status, json } = await patch(id, { compactionModel: 'cheap-compactor' });

    expect(status).toBe(400);
    expect(json.error).toContain('cheap-compactor');
    // The row is untouched: a refused write changes nothing.
    expect(getSessionSelection(id).compactionModel).toBeNull();
  });

  test('a compaction provider WITHOUT its model is REFUSED', async () => {
    const id = createSession('New chat', BASE);
    const { status, json } = await patch(id, { compactionProviderId: 'openai' });

    expect(status).toBe(400);
    expect(json.error).not.toBeNull();
    expect(getSessionSelection(id).compactionProviderId).toBeNull();
  });

  test('a model AND a provider is accepted, and stored as a pair', async () => {
    const id = createSession('New chat', BASE);
    const { status, json } = await patch(id, {
      compactionModel: 'cheap-compactor',
      compactionProviderId: 'openai',
    });

    expect(status).toBe(200);
    expect(json.selection.compactionModel).toBe('cheap-compactor');
    expect(json.selection.compactionProviderId).toBe('openai');

    const stored = getSessionSelection(id);
    expect(stored.compactionModel).toBe('cheap-compactor');
    expect(stored.compactionProviderId).toBe('openai');
  });

  test('"same as the main model" is accepted — the empty model carries no provider', async () => {
    const id = createSession('New chat', {
      ...BASE,
      compactionModel: 'cheap-compactor',
      compactionProviderId: 'openai',
    });
    const { status, json } = await patch(id, {
      compactionModel: '',
      compactionProviderId: null,
    });

    expect(status).toBe(200);
    expect(json.selection.compactionModel).toBe('');
    expect(json.selection.compactionProviderId).toBeNull();
  });

  test('"inherit the global default" is accepted', async () => {
    const id = createSession('New chat', {
      ...BASE,
      compactionModel: 'cheap-compactor',
      compactionProviderId: 'openai',
    });
    const { status, json } = await patch(id, {
      compactionModel: null,
      compactionProviderId: null,
    });

    expect(status).toBe(200);
    expect(json.selection.compactionModel).toBeNull();
    expect(json.selection.compactionProviderId).toBeNull();
  });

  test('a patch that edits ONE half of an EXISTING pair is refused', async () => {
    // The conversation already holds ('cheap-compactor', 'openai'). A patch
    // that changes the model alone would leave the model on a provider that
    // was pinned for the OTHER model — the same wrong endpoint, reached a
    // different way. The check runs on the MERGED result.
    const id = createSession('New chat', {
      ...BASE,
      compactionModel: 'cheap-compactor',
      compactionProviderId: 'openai',
    });
    const { status, json } = await patch(id, { compactionModel: 'another-compactor' });

    expect(status).toBe(400);
    expect(json.error).toContain('another-compactor');
    expect(getSessionSelection(id).compactionModel).toBe('cheap-compactor');
  });

  test('a patch that touches only the main model leaves the pair alone', async () => {
    const id = createSession('New chat', {
      ...BASE,
      compactionModel: 'cheap-compactor',
      compactionProviderId: 'openai',
    });
    const { status, json } = await patch(id, { model: 'another-model' });

    expect(status).toBe(200);
    expect(json.selection.model).toBe('another-model');
    expect(json.selection.compactionModel).toBe('cheap-compactor');
    expect(json.selection.compactionProviderId).toBe('openai');
  });
});
