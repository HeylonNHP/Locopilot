#!/usr/bin/env node
/**
 * Tests for reading, creating and refusing `config.json` (Phase 3.1 and 3.3).
 *
 * Run with: npx tsx scripts/test-config-load.mjs
 *
 * Works in a temporary directory, never in the owner's project folder: the
 * loader takes a path, so no test touches the real config.json.
 *
 * What is pinned:
 *   - a MISSING file is created with defaults, and the window default is
 *     written only at that moment;
 *   - an EXISTING file that cannot be read or parsed is never overwritten;
 *   - a fresh config cannot run a turn (no model chosen), and a config with no
 *     context size cannot either: the refusal messages say what to do;
 *   - no server code path defaults the window (DEFAULT_NUM_CTX is gone).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRESH_CONFIG_NUM_CTX } from '../src/services/configDefaults.ts';
import { buildFreshConfig, readConfig } from '../src/services/configManager.ts';
import {
  configProblemFor,
  CONTEXT_SIZE_NOT_SET_MESSAGE,
  MODEL_NOT_CHOSEN_MESSAGE,
  requestProblemFor,
  requireWindow,
} from '../src/services/contextWindow/configProblem.ts';

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
const root = path.join(here, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locopilot-config-'));
const fileIn = (name) => path.join(dir, name);

// ── missing file: created with defaults ──────────────────────────────────

console.log('a missing config.json is created with defaults');

await check('the first read creates the file and says so', async () => {
  const file = fileIn('missing.json');
  const result = await readConfig(file);
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.ok(fs.existsSync(file), 'no file was written');
});

await check(
  'the created file holds the defaults, with no provider and no model chosen',
  async () => {
    const file = fileIn('defaults.json');
    const { config } = await readConfig(file);
    assert.deepEqual(config.providers, []);
    assert.equal(config.model, '');
    assert.equal(config.numCtx, FRESH_CONFIG_NUM_CTX);
    assert.equal(config.numCtx, 131_072);
    assert.equal(config.yolo, false);
    assert.equal(config.retry.maxAttempts, 3);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(onDisk, config, 'the file on disk differs from what was returned');
  }
);

await check('a second read returns the same file and creates nothing', async () => {
  const file = fileIn('second.json');
  await readConfig(file);
  const before = sha(file);
  const again = await readConfig(file);
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(sha(file), before, 'the file changed on a plain read');
});

await check('an existing file without a window is read as it is, not given one', async () => {
  const file = fileIn('no-window.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'm', providers: [] }));
  const result = await readConfig(file);
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal('numCtx' in result.config, false, 'a window was invented');
});

await check(
  'buildFreshConfig carries the window default, and only the fresh-file path uses it',
  () => {
    assert.equal(buildFreshConfig().numCtx, FRESH_CONFIG_NUM_CTX);
  }
);

// ── existing file that cannot be read: never overwritten ────────────────

console.log('an existing config.json that cannot be read is never overwritten');

for (const [label, text] of [
  ['invalid JSON', '{"model": "m", "providers": [ '],
  ['an empty file', ''],
  ['a JSON array', '[1, 2, 3]'],
  ['a JSON null', 'null'],
]) {
  await check(`${label} is reported, and the bytes are left alone`, async () => {
    const file = fileIn(`bad-${label.replaceAll(/\W+/g, '-')}.json`);
    fs.writeFileSync(file, text);
    const before = sha(file);
    const result = await readConfig(file);
    assert.equal(result.ok, false, 'an unreadable file was accepted');
    assert.match(result.message, /will not overwrite it/);
    assert.equal(sha(file), before, 'the unreadable file was changed');
  });
}

await check('the owner-facing message names the file and says what to do', async () => {
  const file = fileIn('message.json');
  fs.writeFileSync(file, '{ not json');
  const result = await readConfig(file);
  assert.match(result.message, /^config\.json exists but could not be read/);
  assert.match(result.message, /fix or restore the file by hand/);
});

// ── a config that cannot run a turn says why ─────────────────────────────

console.log('a config that cannot run a turn says what to do');

await check('a fresh config refuses a chat until a model is chosen in Settings', () => {
  assert.equal(configProblemFor(buildFreshConfig(), undefined, ''), MODEL_NOT_CHOSEN_MESSAGE);
  assert.match(MODEL_NOT_CHOSEN_MESSAGE, /Open Settings and choose a model/);
});

await check('a provider with a model and a global window can run a turn', () => {
  const config = {
    ...buildFreshConfig(),
    providers: [{ id: 'p1', name: 'P', provider: 'ollama', baseUrl: 'http://x', model: 'm' }],
    model: 'm',
    activeProviderId: 'p1',
  };
  assert.equal(configProblemFor(config, 'p1', 'm'), null);
});

await check(
  'no context size anywhere refuses the turn, and the message says where to fix it',
  () => {
    const config = {
      providers: [{ id: 'p1', name: 'P', provider: 'ollama', baseUrl: 'http://x', model: 'm' }],
    };
    assert.equal(configProblemFor(config, 'p1', 'm'), CONTEXT_SIZE_NOT_SET_MESSAGE);
    assert.match(CONTEXT_SIZE_NOT_SET_MESSAGE, /Open Settings and set Context Size/);
  }
);

await check("a provider's own window is enough when the global one is missing", () => {
  const config = {
    providers: [
      { id: 'p1', name: 'P', provider: 'ollama', baseUrl: 'http://x', model: 'm', numCtx: 42_000 },
    ],
  };
  assert.equal(configProblemFor(config, 'p1', 'm'), null);
});

await check('a compaction provider named in the body is checked, and refused when it has no window', () => {
  const config = {
    numCtx: 131_072,
    providers: [
      { id: 'p1', name: 'P', provider: 'ollama', baseUrl: 'http://x', model: 'm' },
      { id: 'p2', name: 'Q', provider: 'ollama', baseUrl: 'http://y', model: 'n' },
    ],
  };
  assert.equal(requestProblemFor(config, { providerId: 'p1', model: 'm' }), null);
  const problem = requestProblemFor(config, {
    providerId: 'p1',
    model: 'm',
    compactionProviderId: 'p2',
    compactionModel: 'n',
  });
  assert.equal(problem, null, 'the global window covers p2 too');
  const noGlobal = { ...config, numCtx: undefined };
  assert.equal(
    requestProblemFor(noGlobal, { providerId: 'p1', model: 'm', compactionProviderId: 'p2' }),
    CONTEXT_SIZE_NOT_SET_MESSAGE
  );
});

await check('requireWindow throws the clear message instead of assuming a window', () => {
  assert.equal(requireWindow(40_960), 40_960);
  assert.throws(() => requireWindow(null), { message: CONTEXT_SIZE_NOT_SET_MESSAGE });
});

// ── wiring: the server has no window default left, and the routes refuse ─

console.log('the server has no window default, and the routes refuse first');

const SERVER_FILES = [
  'src/app/api/chat/route.ts',
  'src/app/api/compact/route.ts',
  'src/app/api/title/route.ts',
  'src/app/api/dump/route.ts',
  'src/app/api/config/route.ts',
  'src/app/api/numctx/route.ts',
  'src/app/api/diagnostics/numctx/route.ts',
  'src/services/providerResolver.ts',
  'src/services/capResolver.ts',
  'src/services/contextWindow/resolveNumCtx.ts',
];

const codeOnly = (source) =>
  source.replaceAll(/\/\*[\S\s]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

await check('no server file uses DEFAULT_NUM_CTX in code', () => {
  for (const file of SERVER_FILES) {
    assert.ok(!/DEFAULT_NUM_CTX/.test(codeOnly(read(file))), `${file} still uses DEFAULT_NUM_CTX`);
  }
  assert.ok(
    !/DEFAULT_NUM_CTX/.test(codeOnly(read('src/constants.ts'))),
    'the constant is still defined'
  );
});

await check(
  'the chat, compact, title and dump routes read the saved config and refuse first',
  () => {
    for (const file of [
      'src/app/api/chat/route.ts',
      'src/app/api/compact/route.ts',
      'src/app/api/title/route.ts',
      'src/app/api/dump/route.ts',
    ]) {
      const source = read(file);
      assert.ok(source.includes('await readConfig()'), `${file} does not read the saved config`);
      assert.ok(source.includes('status: 503'), `${file} does not refuse an unreadable config`);
      assert.ok(
        /configProblemFor\(|requestProblemFor\(/.test(source),
        `${file} does not refuse a config that cannot run the request`
      );
    }
  }
);

await check(
  'the config PUT refuses an unreadable file before it saves, and writes no window',
  () => {
    const route = read('src/app/api/config/route.ts');
    const refuse = route.indexOf('if (!current.ok)');
    const save = route.indexOf('await saveConfig(updatedConfig)');
    assert.ok(refuse !== -1, 'the PUT does not check the read');
    assert.ok(save !== -1 && refuse < save, 'the save can run on an unreadable file');
    assert.ok(route.includes('delete defaults.numCtx;'), 'the PUT still defaults the window');
    assert.ok(route.includes('status: 503'), 'the PUT does not answer 503');
  }
);

await check('GET /api/config reports an unreadable file as an error, not an empty config', () => {
  const route = read('src/app/api/config/route.ts');
  assert.ok(
    !route.includes('NextResponse.json({ config: {} })'),
    'the empty-config fallback is back'
  );
  assert.ok(route.includes('readConfig()'), 'GET does not read through readConfig');
});

await check('the config loader creates the file only when it is absent', () => {
  const source = codeOnly(read('src/services/configManager.ts'));
  assert.ok(source.includes("flag: 'wx'"), 'the creation does not refuse to overwrite');
  assert.ok(!source.includes("flag: 'w'"), 'a plain write could replace an existing file');
});

// ── cleanup ──────────────────────────────────────────────────────────────

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
