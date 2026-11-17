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

import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
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
let POST;
let createSession;
let getSessionSelection;
let listSessions;
let recordProviderModels;
let invalidateModelIndex;
let setModelIndexDeps;

/**
 * The saved configuration the routes read: two real providers. A write is
 * checked as a pair against it, so a provider id that is not here is a ghost.
 */
const CONFIG = {
  numCtx: 8192,
  providers: [
    {
      id: 'ollama',
      name: 'Ollama',
      provider: 'ollama',
      baseUrl: 'http://ollama.test',
      model: 'main-model',
    },
    { id: 'openai', name: 'OpenAI', provider: 'openai-compatible', baseUrl: 'http://openai.test' },
  ],
};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'locopilot-session-pair-'));
  // `history.ts` builds `DB_PATH` at module load, so the cwd moves FIRST.
  process.chdir(tmp);
  // `paths.ts` builds `CONFIG_PATH` from the cwd at module load, so the
  // config is written BEFORE the routes are imported.
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(CONFIG));
  ({ createSession, getSessionSelection, listSessions } = await import(
    moduleUrl('../src/services/history.ts')
  ));
  ({ PATCH } = await import(moduleUrl('../src/app/api/sessions/[id]/route.ts')));
  ({ POST } = await import(moduleUrl('../src/app/api/sessions/route.ts')));
  ({ recordProviderModels, invalidateModelIndex, setModelIndexDeps } = await import(
    moduleUrl('../src/services/modelIndex.ts')
  ));
  // The background refresh must never reach for a provider during a test.
  setModelIndexDeps({ fetchModels: async () => [] });
});

beforeEach(() => {
  invalidateModelIndex();
});

afterAll(() => {
  setModelIndexDeps(null);
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
      // The CONTENT is the point of a loud refusal: it names what was sent
      // alone and says what to send instead.
      expect(json.error).toContain('without the compaction model it serves');
      expect(json.error).toContain('together');
      expect(getSessionSelection(id).compaction).toEqual({ kind: 'inherit-default' });
    });
  });
});

async function post(body) {
  const response = await POST(
    new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  return { status: response.status, json: await response.json() };
}

describe('a selection is checked as a PAIR before it is written (BUG 5)', () => {
  test('PATCH refuses a compaction provider that does not exist, names it, and writes nothing', async () => {
    const id = createSession('New chat', BASE);
    const { status, json } = await patch(id, {
      compaction: { kind: 'explicit', model: 'c', providerId: 'ghost-provider' },
    });

    expect(status).toBe(409);
    expect(json.error).toContain('ghost-provider');
    expect(getSessionSelection(id).compaction).toEqual({ kind: 'inherit-default' });
  });

  test('PATCH refuses a main provider that does not exist', async () => {
    const id = createSession('New chat', BASE);
    const { status, json } = await patch(id, { model: 'm', providerId: 'ghost-provider' });

    expect(status).toBe(409);
    expect(json.error).toContain('ghost-provider');
    expect(getSessionSelection(id).providerId).toBe('ollama');
  });

  test('PATCH refuses a model the provider does not serve, once the index knows the list', async () => {
    recordProviderModels('openai', 'http://openai.test', ['gpt-a']);
    const id = createSession('New chat', BASE);
    const { status, json } = await patch(id, { model: 'beam', providerId: 'openai' });

    expect(status).toBe(409);
    expect(json.error).toMatch(/does not serve the model "beam"/);
    expect(getSessionSelection(id).model).toBe('main-model');
  });

  test('PATCH lets a model through when the index cannot say (unknown never refuses)', async () => {
    const id = createSession('New chat', BASE);
    const { status } = await patch(id, { model: 'beam', providerId: 'openai' });

    expect(status).toBe(200);
  });

  test('PATCH refuses a main switch that would send an inherited global compaction model to a provider that does not serve it', async () => {
    // The production failure: the global compaction model "beam" has no
    // provider of its own, so it runs on the provider the chat runs on.
    const config = { ...CONFIG, compactionModel: 'beam' };
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config));
    try {
      recordProviderModels('openai', 'http://openai.test', ['gpt-a']);
      const id = createSession('New chat', BASE);
      const { status, json } = await patch(id, { model: 'gpt-a', providerId: 'openai' });

      expect(status).toBe(409);
      expect(json.error).toMatch(/compaction model "beam"/);
      expect(getSessionSelection(id).providerId).toBe('ollama');
    } finally {
      fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(CONFIG));
    }
  });

  test('a conversation broken by a removed provider can still change its reasoning level', async () => {
    const id = createSession('New chat', { ...BASE, providerId: 'ghost-provider' });
    const { status } = await patch(id, { reasoningEffort: 'high' });

    expect(status).toBe(200);
    expect(getSessionSelection(id).reasoningEffort).toBe('high');
  });

  test('repairing one broken half is not refused because of the other half', async () => {
    // Both halves name a removed provider. Fixing the MAIN pair must not be
    // refused because the compaction half is still broken, or the
    // conversation could never be repaired.
    const id = createSession('New chat', {
      ...BASE,
      providerId: 'ghost-main',
      compaction: { kind: 'explicit', model: 'c', providerId: 'ghost-compaction' },
    });
    const main = await patch(id, { model: 'main-model', providerId: 'ollama' });
    expect(main.status).toBe(200);

    const compaction = await patch(id, { compaction: EXPLICIT });
    expect(compaction.status).toBe(200);
  });

  test('POST refuses a conversation born with a compaction provider that does not exist', async () => {
    const before = listSessions().length;
    const { status, json } = await post({
      model: 'main-model',
      providerId: 'ollama',
      compaction: { kind: 'explicit', model: 'c', providerId: 'ghost-provider' },
    });

    expect(status).toBe(409);
    expect(json.error).toContain('ghost-provider');
    expect(listSessions().length).toBe(before);
  });

  test('POST refuses a pinned main provider that does not exist', async () => {
    const { status, json } = await post({ model: 'm', providerId: 'ghost-provider' });

    expect(status).toBe(409);
    expect(json.error).toContain('ghost-provider');
  });

  test('POST creates a conversation that names a coherent pair', async () => {
    const { status, json } = await post({
      model: 'main-model',
      providerId: 'ollama',
      compaction: EXPLICIT,
    });

    expect(status).toBe(201);
    expect(json.session.compaction_provider_id).toBe('openai');
  });

  test('POST does not check what the request leaves to the defaults: a new chat opens even when they are broken', async () => {
    const config = { ...CONFIG, compactionModel: 'beam', compactionProviderId: 'ghost-provider' };
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config));
    try {
      const { status } = await post({ model: 'main-model' });
      expect(status).toBe(201);
    } finally {
      fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(CONFIG));
    }
  });

  test('a write is not refused for a missing context size (the Settings modal saves the model first)', async () => {
    const { numCtx: _omitted, ...withoutWindow } = CONFIG;
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(withoutWindow));
    try {
      const id = createSession('New chat', BASE);
      const { status } = await patch(id, { model: 'another-model', providerId: 'ollama' });
      expect(status).toBe(200);
    } finally {
      fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(CONFIG));
    }
  });
});
