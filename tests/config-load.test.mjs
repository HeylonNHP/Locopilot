/**
 * Tests for reading, creating and refusing `config.json` (Phase 3.1 and 3.3).
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

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const codeOnly = (source) =>
  source.replaceAll(/\/\*[\S\s]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

let dir;
const fileIn = (name) => path.join(dir, name);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locopilot-config-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a missing config.json is created with defaults', () => {
  test('the first read creates the file and says so', async () => {
    const file = fileIn('missing.json');
    const result = await readConfig(file);
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('the created file holds the defaults, with no provider and no model chosen', async () => {
    const file = fileIn('defaults.json');
    const { config } = await readConfig(file);
    expect(config.providers).toStrictEqual([]);
    expect(config.model).toBe('');
    expect(config.numCtx).toBe(FRESH_CONFIG_NUM_CTX);
    expect(config.numCtx).toBe(131_072);
    expect(config.yolo).toBe(false);
    expect(config.retry.maxAttempts).toBe(3);
    // the file on disk is what was returned
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toStrictEqual(config);
  });

  test('a second read returns the same file and creates nothing', async () => {
    const file = fileIn('second.json');
    await readConfig(file);
    const before = sha(file);
    const again = await readConfig(file);
    expect(again.ok).toBe(true);
    expect(again.created).toBe(false);
    // the file did not change on a plain read
    expect(sha(file)).toBe(before);
  });

  test('an existing file without a window is read as it is, not given one', async () => {
    const file = fileIn('no-window.json');
    fs.writeFileSync(file, JSON.stringify({ model: 'm', providers: [] }));
    const result = await readConfig(file);
    expect(result.ok).toBe(true);
    expect(result.created).toBe(false);
    expect(result.config).not.toHaveProperty('numCtx');
  });

  test('buildFreshConfig carries the window default, and only the fresh-file path uses it', () => {
    expect(buildFreshConfig().numCtx).toBe(FRESH_CONFIG_NUM_CTX);
  });
});

describe('an existing config.json that cannot be read is never overwritten', () => {
  test.each([
    ['invalid JSON', '{"model": "m", "providers": [ '],
    ['an empty file', ''],
    ['a JSON array', '[1, 2, 3]'],
    ['a JSON null', 'null'],
  ])('%s is reported, and the bytes are left alone', async (label, text) => {
    const file = fileIn(`bad-${label.replaceAll(/\W+/g, '-')}.json`);
    fs.writeFileSync(file, text);
    const before = sha(file);

    const result = await readConfig(file);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/will not overwrite it/);
    expect(sha(file)).toBe(before);
  });

  test('the owner-facing message names the file and says what to do', async () => {
    const file = fileIn('message.json');
    fs.writeFileSync(file, '{ not json');
    const result = await readConfig(file);
    expect(result.message).toMatch(/^config\.json exists but could not be read/);
    expect(result.message).toMatch(/fix or restore the file by hand/);
  });
});

describe('a config that cannot run a turn says what to do', () => {
  const provider = (extra = {}) => ({
    id: 'p1',
    name: 'P',
    provider: 'ollama',
    baseUrl: 'http://x',
    model: 'm',
    ...extra,
  });

  test('a fresh config refuses a chat until a model is chosen in Settings', () => {
    expect(configProblemFor(buildFreshConfig(), undefined, '')).toBe(MODEL_NOT_CHOSEN_MESSAGE);
    expect(MODEL_NOT_CHOSEN_MESSAGE).toMatch(
      /Open Settings, add a provider if there is none, and choose a model/
    );
  });

  test('a provider with a model and a global window can run a turn', () => {
    const config = {
      ...buildFreshConfig(),
      providers: [provider()],
      model: 'm',
      activeProviderId: 'p1',
    };
    expect(configProblemFor(config, 'p1', 'm')).toBeNull();
  });

  test('no context size anywhere refuses the turn, and the message says where to fix it', () => {
    const config = { providers: [provider()] };
    expect(configProblemFor(config, 'p1', 'm')).toBe(CONTEXT_SIZE_NOT_SET_MESSAGE);
    expect(CONTEXT_SIZE_NOT_SET_MESSAGE).toMatch(/Open Settings and set Context Size/);
  });

  test("a provider's own window is enough when the global one is missing", () => {
    const config = { providers: [provider({ numCtx: 42_000 })] };
    expect(configProblemFor(config, 'p1', 'm')).toBeNull();
  });

  test('a compaction provider named in the body is checked, and refused when it has no window', () => {
    const config = {
      numCtx: 131_072,
      providers: [provider(), provider({ id: 'p2', name: 'Q', baseUrl: 'http://y', model: 'n' })],
    };
    expect(requestProblemFor(config, { providerId: 'p1', model: 'm' })).toBeNull();
    // the global window covers p2 too
    expect(
      requestProblemFor(config, {
        providerId: 'p1',
        model: 'm',
        compactionProviderId: 'p2',
        compactionModel: 'n',
      })
    ).toBeNull();

    const noGlobal = { ...config, numCtx: undefined };
    expect(
      requestProblemFor(noGlobal, { providerId: 'p1', model: 'm', compactionProviderId: 'p2' })
    ).toBe(CONTEXT_SIZE_NOT_SET_MESSAGE);
  });

  test('requireWindow throws the clear message instead of assuming a window', () => {
    expect(requireWindow(40_960)).toBe(40_960);
    expect(() => requireWindow(null)).toThrow(new Error(CONTEXT_SIZE_NOT_SET_MESSAGE));
  });
});

describe('the server has no window default, and the routes refuse first', () => {
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

  test.each(SERVER_FILES)('%s does not use DEFAULT_NUM_CTX in code', (file) => {
    expect(codeOnly(read(file))).not.toMatch(/DEFAULT_NUM_CTX/);
  });

  test('the DEFAULT_NUM_CTX constant is gone', () => {
    expect(codeOnly(read('src/constants.ts'))).not.toMatch(/DEFAULT_NUM_CTX/);
  });

  test.each([
    'src/app/api/chat/route.ts',
    'src/app/api/compact/route.ts',
    'src/app/api/title/route.ts',
    'src/app/api/dump/route.ts',
  ])('%s reads the saved config and refuses first', (file) => {
    const source = read(file);
    // it reads the saved config
    expect(source).toContain('await readConfig()');
    // it refuses an unreadable config
    expect(source).toContain('status: 503');
    // it refuses a config that cannot run the request
    expect(source).toMatch(/configProblemFor\(|requestProblemFor\(/);
  });

  test('the config PUT refuses an unreadable file before it saves, and writes no window', () => {
    const route = read('src/app/api/config/route.ts');
    const refuse = route.indexOf('if (!current.ok)');
    const save = route.indexOf('await saveConfig(updatedConfig)');
    expect(refuse).not.toBe(-1);
    // the save must not be able to run on an unreadable file
    expect(save).toBeGreaterThan(refuse);
    // the PUT must not default the window
    expect(route).toContain('delete defaults.numCtx;');
    expect(route).toContain('status: 503');
  });

  test('GET /api/config reports an unreadable file as an error, not an empty config', () => {
    const route = read('src/app/api/config/route.ts');
    expect(route).not.toContain('NextResponse.json({ config: {} })');
    expect(route).toContain('readConfig()');
  });

  test('the config loader creates the file only when it is absent', () => {
    const source = codeOnly(read('src/services/configManager.ts'));
    // the creation refuses to overwrite
    expect(source).toContain("flag: 'wx'");
    // a plain write could replace an existing file
    expect(source).not.toContain("flag: 'w'");
  });
});
