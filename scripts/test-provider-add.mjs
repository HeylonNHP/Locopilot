#!/usr/bin/env node
/**
 * Tests for adding a provider from Settings: the shared validation, the form's
 * own rules, and `POST /api/providers` itself.
 *
 * Run with: npx tsx scripts/test-provider-add.mjs
 *
 * The endpoint is called in-process, in a TEMPORARY directory: the working
 * directory is changed before the route is imported, so its config path points
 * at a scratch file. The owner's config.json is never read or written.
 */

import assert from 'node:assert/strict';
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

let pass = 0;
let fail = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message.split('\n').join('\n        ')}`);
    fail += 1;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const codeOnly = (source) =>
  source.replaceAll(/\/\*[\S\s]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

// ── validation shared by the config route and the endpoint ────────────────

console.log('provider validation');

await check('a valid provider is accepted and trimmed', () => {
  const result = validateProvider(
    { id: ' p1 ', name: ' Local ', provider: 'ollama', baseUrl: ' http://localhost:11434 ' },
    ''
  );
  assert.deepEqual(result, {
    id: 'p1',
    name: 'Local',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
  });
});

await check(
  'messages carry the list position when there is one, and are plain when there is not',
  () => {
    const bad = { id: 'p', name: '', provider: 'ollama', baseUrl: 'http://x' };
    assert.equal(
      validateProvider(bad, 'providers[2]'),
      'providers[2].name must be a non-empty string'
    );
    assert.equal(validateProvider(bad, ''), 'name must be a non-empty string');
  }
);

await check('the kind, the address and its scheme are checked', () => {
  const base = { id: 'p', name: 'N', provider: 'ollama', baseUrl: 'http://x' };
  assert.match(
    validateProvider({ ...base, provider: 'openai' }, ''),
    /provider must be 'ollama' or 'openai-compatible'/
  );
  assert.match(
    validateProvider({ ...base, baseUrl: 'not a url' }, ''),
    /baseUrl is not a valid URL/
  );
  assert.match(
    validateProvider({ ...base, baseUrl: 'ftp://x' }, ''),
    /must use http: or https: scheme/
  );
  assert.match(
    validateProvider({ ...base, baseUrl: '' }, ''),
    /baseUrl must be a non-empty string/
  );
  assert.match(validateProvider({ ...base, apiKey: 5 }, ''), /apiKey must be a string/);
});

await check('a blank key or model is left out, not stored empty', () => {
  const result = validateProvider(
    { id: 'p', name: 'N', provider: 'ollama', baseUrl: 'http://x', apiKey: '  ', model: '' },
    ''
  );
  assert.equal('apiKey' in result, false);
  assert.equal('model' in result, false);
});

await check('the base URL is stored the way the adapters expect it', () => {
  assert.equal(
    normaliseProviderBaseUrl('ollama', 'http://localhost:11434/'),
    'http://localhost:11434'
  );
  assert.equal(normaliseProviderBaseUrl('ollama', 'http://h//'), 'http://h');
  assert.equal(
    normaliseProviderBaseUrl('openai-compatible', 'https://api.example.com/v1'),
    'https://api.example.com'
  );
  assert.equal(
    normaliseProviderBaseUrl('openai-compatible', 'https://api.example.com/v1/'),
    'https://api.example.com'
  );
  assert.equal(
    normaliseProviderBaseUrl('openai-compatible', 'https://openrouter.ai/api/v1'),
    'https://openrouter.ai/api'
  );
  // Ollama's own /v1 is not stripped: only an OpenAI-compatible adapter appends one.
  assert.equal(normaliseProviderBaseUrl('ollama', 'http://h/v1'), 'http://h/v1');
  assert.equal(normaliseProviderBaseUrl('ollama', 42), 42);
});

await check('an id is made from the name and never reuses one', () => {
  assert.equal(uniqueProviderId('Local Ollama', []), 'local-ollama');
  assert.equal(uniqueProviderId('Local Ollama', ['local-ollama']), 'local-ollama-2');
  assert.equal(
    uniqueProviderId('Local Ollama', ['local-ollama', 'local-ollama-2']),
    'local-ollama-3'
  );
  assert.equal(uniqueProviderId('  !!!  ', []), 'provider');
  assert.equal(uniqueProviderId('NVIDIA (work)', []), 'nvidia-work');
});

await check('what the browser is told about a provider never includes the key', () => {
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
  assert.equal(publicView.hasApiKey, true);
  assert.ok(!JSON.stringify(publicView).includes('sk-secret-123'), 'the key is in the public view');
  assert.equal('apiKey' in publicView, false);
  assert.equal(toPublicProvider({ ...stored, apiKey: undefined }).hasApiKey, false);
});

// ── the form's own rules ──────────────────────────────────────────────────

console.log('the Add provider form');

await check('a name and a valid http(s) address are required', () => {
  assert.deepEqual(
    validateProviderForm({ ...emptyProviderForm(), name: 'A', baseUrl: 'http://localhost:11434' }),
    {}
  );
  assert.ok(validateProviderForm(emptyProviderForm()).name, 'a blank name was accepted');
  assert.ok(validateProviderForm(emptyProviderForm()).baseUrl, 'a blank address was accepted');
  const wrongScheme = validateProviderForm({
    ...emptyProviderForm(),
    name: 'A',
    baseUrl: 'ftp://h',
  });
  assert.match(wrongScheme.baseUrl, /http:\/\/ or https:\/\//);
  const notUrl = validateProviderForm({ ...emptyProviderForm(), name: 'A', baseUrl: 'localhost' });
  assert.match(notUrl.baseUrl, /not a valid address/);
});

await check('the example address follows the kind', () => {
  assert.equal(baseUrlPlaceholder('ollama'), 'http://localhost:11434');
  assert.match(baseUrlPlaceholder('openai-compatible'), /^https:\/\//);
  assert.match(baseUrlHint('openai-compatible'), /without the \/v1 part/);
  assert.equal(providerKindLabel('openai-compatible'), 'OpenAI-compatible');
});

await check('the request leaves blank optional fields out and trims the rest', () => {
  assert.deepEqual(
    providerRequestBody({
      name: ' A ',
      provider: 'ollama',
      baseUrl: ' http://h ',
      apiKey: '  ',
      model: '',
    }),
    { name: 'A', provider: 'ollama', baseUrl: 'http://h' }
  );
  assert.deepEqual(
    providerRequestBody({
      name: 'A',
      provider: 'openai-compatible',
      baseUrl: 'https://h',
      apiKey: ' k ',
      model: ' m ',
    }),
    { name: 'A', provider: 'openai-compatible', baseUrl: 'https://h', apiKey: 'k', model: 'm' }
  );
});

await check('after adding, the note says whether the provider answered', () => {
  const listed = {
    models: [
      { providerId: 'p', name: 'm1' },
      { providerId: 'p', name: 'm2' },
      { providerId: 'q', name: 'x' },
    ],
    errors: [],
  };
  const ok = describeAddedProvider(listed, 'p', 'Local');
  assert.equal(ok.kind, 'ok');
  assert.match(ok.message, /2 models available/);

  const one = describeAddedProvider(
    { models: [{ providerId: 'p', name: 'm' }], errors: [] },
    'p',
    'Local'
  );
  assert.match(one.message, /1 model available/);

  const failed = describeAddedProvider(
    { models: [], errors: ['Local: connect ECONNREFUSED 127.0.0.1:11434'] },
    'p',
    'Local'
  );
  assert.equal(failed.kind, 'warn');
  assert.match(failed.message, /did not answer: connect ECONNREFUSED/);

  const none = describeAddedProvider({ models: [], errors: [] }, 'p', 'Local');
  assert.equal(none.kind, 'warn');
  assert.match(none.message, /listed no models/);

  assert.equal(describeAddedProvider(null, 'p', 'Local').kind, 'warn');
});

await check("another provider's failure is not blamed on the new one", () => {
  const note = describeAddedProvider(
    { models: [{ providerId: 'p', name: 'm' }], errors: ['Other: boom'] },
    'p',
    'Local'
  );
  assert.equal(note.kind, 'ok');
});

// ── the endpoint, in a temporary directory ────────────────────────────────

console.log('POST /api/providers');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'locopilot-providers-'));
const configFile = path.join(tmp, 'config.json');
process.chdir(tmp);
const { POST } = await import('../src/app/api/providers/route.ts');

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

await check('the first provider is added to a fresh config, and the defaults stay', async () => {
  const { status, json } = await add({
    name: 'Local Ollama',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434/',
  });
  assert.equal(status, 201);
  assert.equal(json.provider.id, 'local-ollama');
  assert.equal(json.provider.baseUrl, 'http://localhost:11434');
  assert.equal(json.provider.hasApiKey, false);
  const file = stored();
  assert.equal(file.providers.length, 1);
  assert.equal(file.numCtx, 131_072, 'the fresh config lost its defaults');
  assert.equal(file.model, '');
});

await check(
  'a key is stored but never returned, and an OpenAI-compatible /v1 is dropped',
  async () => {
    const { status, text, json } = await add({
      name: 'Router',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-test-key-777',
      model: 'some-model',
    });
    assert.equal(status, 201);
    assert.ok(!text.includes('sk-test-key-777'), 'the key was in the response');
    assert.equal(json.provider.hasApiKey, true);
    assert.equal(json.provider.model, 'some-model');
    const provider = stored().providers.find((p) => p.id === 'router');
    assert.equal(provider.apiKey, 'sk-test-key-777', 'the key was not stored');
    assert.equal(provider.baseUrl, 'https://api.example.com');
  }
);

await check('the stored provider passes the same validation the config route uses', () => {
  for (const [index, provider] of stored().providers.entries()) {
    assert.equal(typeof validateProvider(provider, `providers[${index}]`), 'object');
  }
});

await check(
  'a provider with the same name is refused, whatever the case, and nothing changes',
  async () => {
    const before = sha(configFile);
    const { status, json } = await add({
      name: 'LOCAL OLLAMA',
      provider: 'ollama',
      baseUrl: 'http://other:11434',
    });
    assert.equal(status, 409);
    assert.match(json.error, /already exists/);
    assert.equal(sha(configFile), before);
  }
);

await check('an id that would collide gets a number, not an overwrite', async () => {
  const { status, json } = await add({
    name: 'Local-Ollama!',
    provider: 'ollama',
    baseUrl: 'http://third:11434',
  });
  assert.equal(status, 201);
  assert.equal(json.provider.id, 'local-ollama-2');
  assert.equal(stored().providers.filter((p) => p.id === 'local-ollama').length, 1);
});

await check('fields the form does not offer are ignored', async () => {
  const { status, json } = await add({
    name: 'Sneaky',
    provider: 'ollama',
    baseUrl: 'http://sneaky:11434',
    id: 'local-ollama',
    numCtx: 5,
  });
  assert.equal(status, 201);
  assert.equal(json.provider.id, 'sneaky');
  assert.equal('numCtx' in stored().providers.find((p) => p.id === 'sneaky'), false);
});

await check('bad input is refused with the reason, and the file is untouched', async () => {
  const before = sha(configFile);
  const cases = [
    [{ provider: 'ollama', baseUrl: 'http://h' }, /name must be a non-empty string/],
    [
      { name: 'X', provider: 'openai', baseUrl: 'http://h' },
      /provider must be 'ollama' or 'openai-compatible'/,
    ],
    [{ name: 'X', provider: 'ollama', baseUrl: 'nope' }, /baseUrl is not a valid URL/],
    [{ name: 'X', provider: 'ollama', baseUrl: 'ftp://h' }, /http: or https: scheme/],
    [{ name: 'X', provider: 'ollama', baseUrl: 'http://h', apiKey: 5 }, /apiKey must be a string/],
    [{ name: 'X', provider: 'ollama' }, /baseUrl must be a non-empty string/],
  ];
  for (const [body, pattern] of cases) {
    const { status, json } = await add(body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.match(json.error, pattern);
  }
  const notJson = await add('{ not json', true);
  assert.equal(notJson.status, 400);
  const notObject = await add([1, 2], false);
  assert.equal(notObject.status, 400);
  assert.equal(sha(configFile), before, 'a refused request changed the file');
});

await check('an unreadable config.json is refused and never overwritten', async () => {
  fs.writeFileSync(configFile, '{ "providers": [ ');
  const before = sha(configFile);
  const { status, json } = await add({
    name: 'Late',
    provider: 'ollama',
    baseUrl: 'http://late:11434',
  });
  assert.equal(status, 503);
  assert.match(json.error, /will not overwrite it/);
  assert.equal(sha(configFile), before);
});

// ── wiring ────────────────────────────────────────────────────────────────

console.log('the form is wired into Settings');

await check('Settings shows the providers section and takes its default model', () => {
  const settings = read('src/components/SettingsModal/SettingsModal.tsx');
  assert.ok(settings.includes('<ProviderSection onProviderAdded={handleProviderAdded} />'));
  assert.ok(settings.includes("import ProviderSection from './ProviderSection'"));
});

await check('the form posts to /api/providers, hides the key, and refreshes the models', () => {
  const section = read('src/components/SettingsModal/ProviderSection.tsx');
  assert.ok(section.includes("fetch('/api/providers'"), 'does not post to the endpoint');
  assert.ok(section.includes('type="password"'), 'the key field is not masked');
  assert.ok(section.includes('fetchModelList()'), 'the models are not fetched again');
  assert.ok(section.includes("type: 'SET_MODELS'"), 'the new models are not stored');
  assert.ok(section.includes("type: 'SET_PROVIDERS'"), 'the new provider is not stored');
  // The key the user TYPES is `fields.apiKey`; no provider object's stored key is read.
  assert.ok(
    !/\b(?:p|provider|added|data\.provider|state\.providers)\.apiKey\b/.test(codeOnly(section)),
    'the form reads a stored key'
  );
});

await check('the page loads models and the form refreshes them through the same function', () => {
  assert.ok(read('src/app/hooks/useDataLoaders.ts').includes('await fetchModelList()'));
  assert.ok(read('src/app/lib/modelsClient.ts').includes("fetch('/api/models')"));
});

await check('the config route validates providers with the shared module, not a copy', () => {
  const route = read('src/app/api/config/route.ts');
  assert.ok(route.includes("from '@/services/providerValidation'"));
  assert.ok(!/function validateProvider\(/.test(route), 'a second copy of the validator is back');
  assert.ok(route.includes('validateProvider(item, `providers[${index}]`)'));
});

await check('with no provider, chat tells the owner to add one first', () => {
  assert.match(
    read('src/app/hooks/useChatStream.ts'),
    /Open Settings, add a provider, and choose a model/
  );
  assert.match(
    read('src/services/contextWindow/configProblem.ts'),
    /add a provider if there is none/
  );
});

// ── cleanup ──────────────────────────────────────────────────────────────

process.chdir(repoRoot);
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
