/**
 * The dump route and the provider the conversation runs on (bug hunt BUG 4).
 *
 * The dump makes no model call, so it must not refuse a conversation because
 * its provider does not serve the model: it is the tool you reach for when
 * something is broken. It must still resolve the provider the conversation
 * RUNS on - from the id the client sends - and not `providers[0]`, because a
 * provider with no default `model` (the owner's `ollama-cloud`) never wins a
 * model-name match.
 *
 * The route is called in process, in a temporary directory.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const moduleUrl = (relative) => pathToFileURL(path.join(here, relative)).href;

// 127.0.0.1:1 refuses at once, so the window probe fails fast instead of
// waiting on DNS.
const CONFIG = {
  numCtx: 8192,
  providers: [
    {
      id: 'nvidia',
      name: 'NVIDIA',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1',
      model: 'nemotron',
    },
    {
      id: 'ollama-cloud',
      name: 'Ollama Cloud',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:1',
      numCtx: 4096,
    },
  ],
};

let tmp;
let POST;
let recordProviderModels;
let invalidateModelIndex;
let setModelIndexDeps;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'locopilot-dump-'));
  process.chdir(tmp);
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(CONFIG));
  ({ POST } = await import(moduleUrl('../src/app/api/dump/route.ts')));
  ({ recordProviderModels, invalidateModelIndex, setModelIndexDeps } = await import(
    moduleUrl('../src/services/modelIndex.ts')
  ));
  setModelIndexDeps({ fetchModels: async () => [] });
});

afterAll(() => {
  setModelIndexDeps(null);
  process.chdir(repoRoot);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows keeps SQLite files locked.
  }
});

beforeEach(() => {
  invalidateModelIndex();
  // The index knows `beam` is on Ollama Cloud and NOT on NVIDIA.
  recordProviderModels('nvidia', 'http://127.0.0.1:1', ['nemotron']);
  recordProviderModels('ollama-cloud', 'http://127.0.0.1:1', ['beam']);
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(CONFIG));
});

async function dump(body) {
  const response = await POST(
    new Request('http://localhost/api/dump', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'beam', ...body }),
    })
  );
  const text = await response.text();
  return { status: response.status, text };
}

describe('POST /api/dump', () => {
  test('dumps a conversation on the provider it runs on, when the client names it', async () => {
    const { status } = await dump({ providerId: 'ollama-cloud' });
    expect(status).toBe(200);
  });

  test('labels the window of the provider the conversation runs on, not providers[0]', async () => {
    // Ollama Cloud has its own window (4096); NVIDIA falls back to the global
    // 8192. The serves check being skipped is not enough: the dump must also
    // RESOLVE by the id the client sent, or it labels the wrong provider's
    // window while still returning 200.
    const cloud = await dump({ providerId: 'ollama-cloud' });
    expect(cloud.text).toContain('- Runtime num_ctx: 4096');
    const nvidia = await dump({ providerId: 'nvidia' });
    expect(nvidia.text).toContain('- Runtime num_ctx: 8192');
  });

  test('does not refuse a pair the provider does not serve: the dump makes no model call', async () => {
    // An old client sends no provider id, so `beam` resolves to providers[0]
    // (NVIDIA), which does not serve it. The chat would refuse that pair; the
    // dump is the tool for when something is broken and must still work.
    const { status } = await dump({});
    expect(status).toBe(200);
    const explicit = await dump({ providerId: 'nvidia' });
    expect(explicit.status).toBe(200);
  });

  test('says which provider the conversation runs on', async () => {
    const { text } = await dump({ providerId: 'ollama-cloud' });
    expect(text).toContain('- Provider: Ollama Cloud (ollama-cloud)');
  });

  test('a provider that was removed from config.json is REPORTED in the file, not refused', async () => {
    // The dump is the tool for when something is broken. A conversation whose
    // provider no longer exists is exactly that case.
    const { status, text } = await dump({ providerId: 'ghost-provider' });
    expect(status).toBe(200);
    expect(text).toContain('- Provider: (the provider "ghost-provider" is not configured)');
    expect(text).toContain('- Runtime num_ctx: (unknown)');
    // the conversation itself is still in the file
    expect(text).toContain('hi');
  });

  test('a missing context size is labelled unknown, not refused', async () => {
    const { numCtx: _omitted, ...withoutWindow } = CONFIG;
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(withoutWindow));
    // NVIDIA has no window of its own, so without the global one there is none.
    const { status, text } = await dump({ providerId: 'nvidia' });
    expect(status).toBe(200);
    expect(text).toContain('- Runtime num_ctx: (unknown)');
  });

  test('an unreadable config.json is reported in the file, not refused', async () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), '{ this is not json');
    const { status, text } = await dump({ providerId: 'ollama-cloud' });
    expect(status).toBe(200);
    expect(text).toMatch(/- Provider: \(config\.json could not be read/);
    expect(text).toContain('config.json could not be read');
    expect(text).toContain('- Runtime num_ctx: (unknown)');
  });

  test('a malformed request is still a 400: that is a bad request, not a bad configuration', async () => {
    const noModel = await dump({ model: '' });
    expect(noModel.status).toBe(400);
  });
});
