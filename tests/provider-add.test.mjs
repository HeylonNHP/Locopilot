/**
 * Tests for adding a provider from Settings: the shared validation, the form's
 * own rules, and `POST /api/providers` itself.
 *
 * The endpoint is called in-process, in a TEMPORARY directory: the working
 * directory is changed before the route is imported, so its config path points
 * at a scratch file. The owner's config.json is never read or written.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  baseUrlHint,
  baseUrlPlaceholder,
  describeAddedProvider,
  emptyProviderForm,
  providerKindLabel,
  providerRequestBody,
  validateProviderForm,
} from '../src/app/lib/providerForm.ts';
import {
  normaliseProviderBaseUrl,
  toPublicProvider,
  uniqueProviderId,
  validateProvider,
} from '../src/services/providerValidation.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const codeOnly = (source) =>
  source.replaceAll(/\/\*[\S\s]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

describe('provider validation', () => {
  test('a valid provider is accepted and trimmed', () => {
    const result = validateProvider(
      { id: ' p1 ', name: ' Local ', provider: 'ollama', baseUrl: ' http://localhost:11434 ' },
      ''
    );
    expect(result).toStrictEqual({
      id: 'p1',
      name: 'Local',
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
    });
  });

  test('messages carry the list position when there is one, and are plain when there is not', () => {
    const bad = { id: 'p', name: '', provider: 'ollama', baseUrl: 'http://x' };
    expect(validateProvider(bad, 'providers[2]')).toBe(
      'providers[2].name must be a non-empty string'
    );
    expect(validateProvider(bad, '')).toBe('name must be a non-empty string');
  });

  test('the kind, the address and its scheme are checked', () => {
    const base = { id: 'p', name: 'N', provider: 'ollama', baseUrl: 'http://x' };
    expect(validateProvider({ ...base, provider: 'openai' }, '')).toMatch(
      /provider must be 'ollama' or 'openai-compatible'/
    );
    expect(validateProvider({ ...base, baseUrl: 'not a url' }, '')).toMatch(
      /baseUrl is not a valid URL/
    );
    expect(validateProvider({ ...base, baseUrl: 'ftp://x' }, '')).toMatch(
      /must use http: or https: scheme/
    );
    expect(validateProvider({ ...base, baseUrl: '' }, '')).toMatch(
      /baseUrl must be a non-empty string/
    );
    expect(validateProvider({ ...base, apiKey: 5 }, '')).toMatch(/apiKey must be a string/);
  });

  test('a blank key or model is left out, not stored empty', () => {
    const result = validateProvider(
      { id: 'p', name: 'N', provider: 'ollama', baseUrl: 'http://x', apiKey: '  ', model: '' },
      ''
    );
    expect('apiKey' in result).toBe(false);
    expect('model' in result).toBe(false);
  });

  test('the base URL is stored the way the adapters expect it', () => {
    expect(normaliseProviderBaseUrl('ollama', 'http://localhost:11434/')).toBe(
      'http://localhost:11434'
    );
    expect(normaliseProviderBaseUrl('ollama', 'http://h//')).toBe('http://h');
    expect(normaliseProviderBaseUrl('openai-compatible', 'https://api.example.com/v1')).toBe(
      'https://api.example.com'
    );
    expect(normaliseProviderBaseUrl('openai-compatible', 'https://api.example.com/v1/')).toBe(
      'https://api.example.com'
    );
    expect(normaliseProviderBaseUrl('openai-compatible', 'https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api'
    );
    // Ollama's own /v1 is not stripped: only an OpenAI-compatible adapter appends one.
    expect(normaliseProviderBaseUrl('ollama', 'http://h/v1')).toBe('http://h/v1');
    expect(normaliseProviderBaseUrl('ollama', 42)).toBe(42);
  });

  test('an id is made from the name and never reuses one', () => {
    expect(uniqueProviderId('Local Ollama', [])).toBe('local-ollama');
    expect(uniqueProviderId('Local Ollama', ['local-ollama'])).toBe('local-ollama-2');
    expect(uniqueProviderId('Local Ollama', ['local-ollama', 'local-ollama-2'])).toBe(
      'local-ollama-3'
    );
    expect(uniqueProviderId('  !!!  ', [])).toBe('provider');
    expect(uniqueProviderId('NVIDIA (work)', [])).toBe('nvidia-work');
  });

  test('what the browser is told about a provider never includes the key', () => {
    const stored = {
      id: 'p',
      name: 'N',
      provider: 'openai-compatible',
      baseUrl: 'https://x',
      apiKey: 'sk-secret-123',
      model: 'm',
      numCtx: 4096,
    };
    const publicView = toPublicProvider(stored);
    expect(publicView.hasApiKey).toBe(true);
    expect(JSON.stringify(publicView)).not.toContain('sk-secret-123');
    expect('apiKey' in publicView).toBe(false);
    expect(toPublicProvider({ ...stored, apiKey: undefined }).hasApiKey).toBe(false);
  });
});

describe('the Add provider form', () => {
  test('a name and a valid http(s) address are required', () => {
    expect(
      validateProviderForm({ ...emptyProviderForm(), name: 'A', baseUrl: 'http://localhost:11434' })
    ).toStrictEqual({});
    expect(validateProviderForm(emptyProviderForm()).name).toBeTruthy();
    expect(validateProviderForm(emptyProviderForm()).baseUrl).toBeTruthy();
    const wrongScheme = validateProviderForm({
      ...emptyProviderForm(),
      name: 'A',
      baseUrl: 'ftp://h',
    });
    expect(wrongScheme.baseUrl).toMatch(/http:\/\/ or https:\/\//);
    const notUrl = validateProviderForm({
      ...emptyProviderForm(),
      name: 'A',
      baseUrl: 'localhost',
    });
    expect(notUrl.baseUrl).toMatch(/not a valid address/);
  });

  test('the example address follows the kind', () => {
    expect(baseUrlPlaceholder('ollama')).toBe('http://localhost:11434');
    expect(baseUrlPlaceholder('openai-compatible')).toMatch(/^https:\/\//);
    expect(baseUrlHint('openai-compatible')).toMatch(/without the \/v1 part/);
    expect(providerKindLabel('openai-compatible')).toBe('OpenAI-compatible');
  });

  test('the request leaves blank optional fields out and trims the rest', () => {
    expect(
      providerRequestBody({
        name: ' A ',
        provider: 'ollama',
        baseUrl: ' http://h ',
        apiKey: '  ',
        model: '',
      })
    ).toStrictEqual({ name: 'A', provider: 'ollama', baseUrl: 'http://h' });
    expect(
      providerRequestBody({
        name: 'A',
        provider: 'openai-compatible',
        baseUrl: 'https://h',
        apiKey: ' k ',
        model: ' m ',
      })
    ).toStrictEqual({
      name: 'A',
      provider: 'openai-compatible',
      baseUrl: 'https://h',
      apiKey: 'k',
      model: 'm',
    });
  });

  test('after adding, the note says whether the provider answered', () => {
    const listed = {
      models: [
        { providerId: 'p', name: 'm1' },
        { providerId: 'p', name: 'm2' },
        { providerId: 'q', name: 'x' },
      ],
      errors: [],
    };
    const ok = describeAddedProvider(listed, 'p', 'Local');
    expect(ok.kind).toBe('ok');
    expect(ok.message).toMatch(/2 models available/);

    const one = describeAddedProvider(
      { models: [{ providerId: 'p', name: 'm' }], errors: [] },
      'p',
      'Local'
    );
    expect(one.message).toMatch(/1 model available/);

    const failed = describeAddedProvider(
      { models: [], errors: ['Local: connect ECONNREFUSED 127.0.0.1:11434'] },
      'p',
      'Local'
    );
    expect(failed.kind).toBe('warn');
    expect(failed.message).toMatch(/did not answer: connect ECONNREFUSED/);

    const none = describeAddedProvider({ models: [], errors: [] }, 'p', 'Local');
    expect(none.kind).toBe('warn');
    expect(none.message).toMatch(/listed no models/);

    expect(describeAddedProvider(null, 'p', 'Local').kind).toBe('warn');
  });

  test("another provider's failure is not blamed on the new one", () => {
    const note = describeAddedProvider(
      { models: [{ providerId: 'p', name: 'm' }], errors: ['Other: boom'] },
      'p',
      'Local'
    );
    expect(note.kind).toBe('ok');
  });
});

// The endpoint, in a temporary directory. The route reads `config.json` from the
// working directory, so the process moves there before the route is imported.
describe('POST /api/providers', () => {
  let tmp;
  let configFile;
  let POST;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'locopilot-providers-'));
    configFile = path.join(tmp, 'config.json');
    process.chdir(tmp);
    ({ POST } = await import('../src/app/api/providers/route.ts'));
  });

  afterAll(() => {
    process.chdir(repoRoot);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function add(body, raw = false) {
    const response = await POST(
      new Request('http://localhost/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw ? body : JSON.stringify(body),
      })
    );
    return {
      status: response.status,
      text: await response.clone().text(),
      json: await response.json(),
    };
  }
  const stored = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

  test('the first provider is added to a fresh config, and the defaults stay', async () => {
    const { status, json } = await add({
      name: 'Local Ollama',
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/',
    });
    expect(status).toBe(201);
    expect(json.provider.id).toBe('local-ollama');
    expect(json.provider.baseUrl).toBe('http://localhost:11434');
    expect(json.provider.hasApiKey).toBe(false);
    const file = stored();
    expect(file.providers).toHaveLength(1);
    expect(file.numCtx).toBe(131_072);
    expect(file.model).toBe('');
  });

  test('a key is stored but never returned, and an OpenAI-compatible /v1 is dropped', async () => {
    const { status, text, json } = await add({
      name: 'Router',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-test-key-777',
      model: 'some-model',
    });
    expect(status).toBe(201);
    expect(text).not.toContain('sk-test-key-777');
    expect(json.provider.hasApiKey).toBe(true);
    expect(json.provider.model).toBe('some-model');
    const provider = stored().providers.find((p) => p.id === 'router');
    expect(provider.apiKey).toBe('sk-test-key-777');
    expect(provider.baseUrl).toBe('https://api.example.com');
  });

  test('the stored provider passes the same validation the config route uses', () => {
    for (const [index, provider] of stored().providers.entries()) {
      expect(typeof validateProvider(provider, `providers[${index}]`)).toBe('object');
    }
  });

  test('a provider with the same name is refused, whatever the case, and nothing changes', async () => {
    const before = sha(configFile);
    const { status, json } = await add({
      name: 'LOCAL OLLAMA',
      provider: 'ollama',
      baseUrl: 'http://other:11434',
    });
    expect(status).toBe(409);
    expect(json.error).toMatch(/already exists/);
    expect(sha(configFile)).toBe(before);
  });

  test('an id that would collide gets a number, not an overwrite', async () => {
    const { status, json } = await add({
      name: 'Local-Ollama!',
      provider: 'ollama',
      baseUrl: 'http://third:11434',
    });
    expect(status).toBe(201);
    expect(json.provider.id).toBe('local-ollama-2');
    expect(stored().providers.filter((p) => p.id === 'local-ollama')).toHaveLength(1);
  });

  test('fields the form does not offer are ignored', async () => {
    const { status, json } = await add({
      name: 'Sneaky',
      provider: 'ollama',
      baseUrl: 'http://sneaky:11434',
      id: 'local-ollama',
      numCtx: 5,
    });
    expect(status).toBe(201);
    expect(json.provider.id).toBe('sneaky');
    expect('numCtx' in stored().providers.find((p) => p.id === 'sneaky')).toBe(false);
  });

  test('bad input is refused with the reason, and the file is untouched', async () => {
    const before = sha(configFile);
    const cases = [
      [{ provider: 'ollama', baseUrl: 'http://h' }, /name must be a non-empty string/],
      [
        { name: 'X', provider: 'openai', baseUrl: 'http://h' },
        /provider must be 'ollama' or 'openai-compatible'/,
      ],
      [{ name: 'X', provider: 'ollama', baseUrl: 'nope' }, /baseUrl is not a valid URL/],
      [{ name: 'X', provider: 'ollama', baseUrl: 'ftp://h' }, /http: or https: scheme/],
      [
        { name: 'X', provider: 'ollama', baseUrl: 'http://h', apiKey: 5 },
        /apiKey must be a string/,
      ],
      [{ name: 'X', provider: 'ollama' }, /baseUrl must be a non-empty string/],
    ];
    for (const [body, pattern] of cases) {
      const { status, json } = await add(body);
      expect(status).toBe(400);
      expect(json.error).toMatch(pattern);
    }
    const notJson = await add('{ not json', true);
    expect(notJson.status).toBe(400);
    const notObject = await add([1, 2], false);
    expect(notObject.status).toBe(400);
    expect(sha(configFile)).toBe(before);
  });

  test('an unreadable config.json is refused and never overwritten', async () => {
    fs.writeFileSync(configFile, '{ "providers": [ ');
    const before = sha(configFile);
    const { status, json } = await add({
      name: 'Late',
      provider: 'ollama',
      baseUrl: 'http://late:11434',
    });
    expect(status).toBe(503);
    expect(json.error).toMatch(/will not overwrite it/);
    expect(sha(configFile)).toBe(before);
  });
});

describe('the form is wired into Settings', () => {
  test('Settings shows the providers section and takes its default model', () => {
    const settings = read('src/components/SettingsModal/SettingsModal.tsx');
    expect(settings).toContain('<ProviderSection onProviderAdded={handleProviderAdded} />');
    expect(settings).toContain("import ProviderSection from './ProviderSection'");
  });

  test('the form posts to /api/providers, hides the key, and refreshes the models', () => {
    const section = read('src/components/SettingsModal/ProviderSection.tsx');
    expect(section).toContain("fetch('/api/providers'");
    expect(section).toContain('type="password"');
    expect(section).toContain('fetchModelList()');
    expect(section).toContain("type: 'SET_MODELS'");
    expect(section).toContain("type: 'SET_PROVIDERS'");
    // The key the user TYPES is `fields.apiKey`; no provider object's stored key is read.
    expect(codeOnly(section)).not.toMatch(
      /\b(?:p|provider|added|data\.provider|state\.providers)\.apiKey\b/
    );
  });

  test('the page loads models and the form refreshes them through the same function', () => {
    expect(read('src/app/hooks/useDataLoaders.ts')).toContain('await fetchModelList()');
    expect(read('src/app/lib/modelsClient.ts')).toContain("fetch('/api/models')");
  });

  test('the config route validates providers with the shared module, not a copy', () => {
    const route = read('src/app/api/config/route.ts');
    expect(route).toContain("from '@/services/providerValidation'");
    expect(route).not.toMatch(/function validateProvider\(/);
    expect(route).toContain('validateProvider(item, `providers[${index}]`)');
  });

  test('with no provider, chat tells the owner to add one first', () => {
    expect(read('src/app/hooks/useChatStream.ts')).toMatch(
      /Open Settings, add a provider, and choose a model/
    );
    expect(read('src/services/contextWindow/configProblem.ts')).toMatch(
      /add a provider if there is none/
    );
  });
});

// cleanup
