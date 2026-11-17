/**
 * Tests for the MID-TURN MODEL SWITCH: what the client sends, and what it
 * does with a refusal.
 *
 * WHY this exists: a mid-turn switch is the side channel that lets the user
 * change the model of a turn that is ALREADY streaming. It carried three
 * separate defects:
 *
 *  - it sent an EMPTY request when the user picked "Use the default" as the
 *    compaction model, so the route refused it with HTTP 400 ("At least one
 *    of \"model\", \"compaction\", or \"providerId\" is required");
 *  - it threw the server's answer away, so a refusal looked exactly like a
 *    successful switch (the "(switching...)" badge appeared and vanished and
 *    nothing said so);
 *  - the server applied the pair it named without checking that the provider
 *    carries the model, which is how the global compaction model "beam" still
 *    reached NVIDIA (CONFIRMATIONS C-025).
 *
 * The server half of the third defect is in `tests/model-index.test.mjs`
 * (`planModelSwitch`) and `tests/sse-routing.test.mjs` (the refusal phase).
 * This file covers the CLIENT half: the payload it builds, and what it does
 * with what the server says.
 *
 * The route is called IN PROCESS. The working directory is moved before the
 * route is imported, so the database it opens is a scratch file - the
 * owner's `locopilot.db` is never touched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
/** Resolves a repo-relative module against this script, not against the cwd. */
const moduleUrl = (relative) => pathToFileURL(path.join(here, relative)).href;

let tmp;
let POST;
let peekModelSwitch;
let registerActiveTurn;
let unregisterActiveTurn;
let buildMidTurnSwitch;
let isEmptyMidTurnSwitch;
let readErrorMessage;
let requestMidTurnModelSwitch;
let switchFailureMessage;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'locopilot-mid-turn-switch-'));
  // `history.ts` builds `DB_PATH` at module load, so the cwd moves FIRST.
  process.chdir(tmp);
  ({ POST } = await import(moduleUrl('../src/app/api/chat/switch-model/route.ts')));
  ({ peekModelSwitch, registerActiveTurn, unregisterActiveTurn } = await import(
    moduleUrl('../src/app/lib/modelSwitchRegistry.ts')
  ));
  ({
    buildMidTurnSwitch,
    isEmptyMidTurnSwitch,
    readErrorMessage,
    requestMidTurnModelSwitch,
    switchFailureMessage,
  } = await import(moduleUrl('../src/app/lib/switchModelClient.ts')));
});

afterAll(() => {
  process.chdir(repoRoot);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while `history.ts` holds it open.
  }
});

beforeEach(() => {
  jest.restoreAllMocks();
});

/** The switch route, called in process. */
async function postSwitch(body) {
  return POST(
    new Request('http://localhost/api/chat/switch-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {}
  );
}

describe('the switch payload is never empty', () => {
  test('a pick of "Use the default" carries the selection, so the request is not empty', () => {
    // The union can say "inherit the global default". The OLD flat pair
    // could not (`null` meant "not sent"), so the pick used to be dropped
    // and what was left was an empty request.
    const payload = buildMidTurnSwitch({ compaction: { kind: 'inherit-default' } });
    expect(payload).toStrictEqual({ compaction: { kind: 'inherit-default' } });
    expect(isEmptyMidTurnSwitch(payload)).toBe(false);
  });

  test('a half that did not change is left out, and the payload says so', () => {
    expect(buildMidTurnSwitch({ compaction: undefined })).toStrictEqual({});
    expect(isEmptyMidTurnSwitch(buildMidTurnSwitch({ compaction: undefined }))).toBe(true);
  });

  test('a blank model or provider is not sent', () => {
    expect(buildMidTurnSwitch({ model: '   ', providerId: null })).toStrictEqual({});
  });

  test('the compaction selection travels in the body, whole', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    await requestMidTurnModelSwitch(7, { compaction: { kind: 'inherit-default' } });
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body)).toStrictEqual({
      sessionId: 7,
      compaction: { kind: 'inherit-default' },
    });
  });
});

describe('an empty payload sends NO request at all', () => {
  test('the route would refuse it, so nothing is sent', async () => {
    // THE PROOF of the bug: the pre-fix client ALWAYS fetched, and the
    // route answered HTTP 400, and the client threw the answer away.
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 400, text: async () => '' });

    const result = await requestMidTurnModelSwitch(7, {});
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toStrictEqual({ accepted: false, message: null });
  });
});

describe('a refusal is reported, not swallowed', () => {
  test("the server's own message is reported", async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: 'At least one of "model", "compaction", or "providerId" is required',
        }),
    });

    const result = await requestMidTurnModelSwitch(7, { compaction: { kind: 'inherit-default' } });
    expect(result.accepted).toBe(false);
    expect(result.message).toContain('At least one of');
    // and it says what the refusal means
    expect(result.message).toContain('keeps the model and the compaction it has');
  });

  test('a body that is not JSON is still read', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });

    const result = await requestMidTurnModelSwitch(7, { model: 'x' });
    expect(result.message).toContain('boom');
  });

  test('no streaming turn is not an error', async () => {
    // The turn had already finished: the selection is saved, and the next
    // turn runs on it. There is nothing to report.
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'No streaming turn for that session' }),
    });

    const result = await requestMidTurnModelSwitch(7, { model: 'x' });
    expect(result).toStrictEqual({ accepted: false, message: null });
  });

  test('a request the user aborted with Stop says nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('aborted'));

    const result = await requestMidTurnModelSwitch(7, { model: 'x' }, controller.signal);
    expect(result).toStrictEqual({ accepted: false, message: null });
  });

  test('a request that never reached the server says so', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await requestMidTurnModelSwitch(7, { model: 'x' });
    expect(result.accepted).toBe(false);
    expect(result.message).toContain('could not be sent');
  });

  test('the message names the cause in its first line', () => {
    // The error banner shows the FIRST line as the headline, so the cause
    // has to be in it.
    const message = switchFailureMessage(
      'The model switch was refused',
      'NVIDIA does not serve it'
    );
    expect(message.split('\n')[0]).toContain('NVIDIA does not serve it');
  });
  test('only a request that never got an answer promises the next turn', () => {
    const refused = switchFailureMessage('The model switch was refused', 'nope', {
      outcome: 'refused',
      runningModel: 'm1',
    });
    expect(refused).not.toContain('applies from the next turn');
    expect(refused).toContain('"m1"');
    const notSent = switchFailureMessage('The model switch could not be sent', null, {
      outcome: 'not-sent',
    });
    expect(notSent).toContain('applies from the next turn');
  });

  test('a refused HTTP response is reported as a refusal, not as a promise', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'bad' }),
    });
    const result = await requestMidTurnModelSwitch(7, { model: 'x' });
    expect(result.accepted).toBe(false);
    expect(result.message).not.toContain('applies from the next turn');
  });

  test('the error field is read out of a JSON body, and a plain body is read as it is', async () => {
    expect(
      await readErrorMessage({ text: async () => JSON.stringify({ error: 'named cause' }) })
    ).toBe('named cause');
    expect(await readErrorMessage({ text: async () => 'plain text' })).toBe('plain text');
    expect(await readErrorMessage({ text: async () => '   ' })).toBeNull();
  });
});

describe('the route accepts the selection the client now sends', () => {
  test('the route accepts "inherit the global default" and keeps it whole', async () => {
    registerActiveTurn(4243, 'probe');
    const response = await postSwitch({ sessionId: 4243, compaction: { kind: 'inherit-default' } });
    expect(response.status).toBe(200);
    expect(peekModelSwitch(4243)).toStrictEqual({ compaction: { kind: 'inherit-default' } });
    unregisterActiveTurn(4243);
  });

  test('the route still refuses an empty body', async () => {
    registerActiveTurn(4244, 'probe');
    const response = await postSwitch({ sessionId: 4244 });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('At least one of');
    unregisterActiveTurn(4244);
  });

  test('a legacy provider-only pin is paired with the main model when no global one is set', async () => {
    // Bug hunt A1: this route used to pair it with the switched-to model
    // WITHOUT looking at the global compaction model, so the same body
    // resolved differently here than on /api/chat.
    registerActiveTurn(4246, 'probe');
    const response = await postSwitch({
      sessionId: 4246,
      model: 'main-m',
      compactionProviderId: 'p1',
    });
    expect(response.status).toBe(200);
    expect(peekModelSwitch(4246)?.compaction).toStrictEqual({
      kind: 'explicit',
      model: 'main-m',
      providerId: 'p1',
    });
    unregisterActiveTurn(4246);
  });

  test('a legacy provider-only pin is paired with the GLOBAL compaction model when one is set', async () => {
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ compactionModel: 'global-c' }));
    try {
      registerActiveTurn(4247, 'probe');
      const response = await postSwitch({
        sessionId: 4247,
        model: 'main-m',
        compactionProviderId: 'p1',
      });
      expect(response.status).toBe(200);
      expect(peekModelSwitch(4247)?.compaction).toStrictEqual({
        kind: 'explicit',
        model: 'global-c',
        providerId: 'p1',
      });
      unregisterActiveTurn(4247);
    } finally {
      fs.rmSync(configPath, { force: true });
    }
  });

  test('the route still refuses a half-pair', async () => {
    registerActiveTurn(4245, 'probe');
    const response = await postSwitch({
      sessionId: 4245,
      compactionModel: 'beam',
      compactionProviderId: null,
    });
    expect(response.status).toBe(400);
    unregisterActiveTurn(4245);
  });
});

describe('the components carry the selection and report a refusal', () => {
  // Source-text assertions, in the style this repo already uses for the
  // route's wiring. They pin the SHAPE of the fix, not its behaviour - the
  // behaviour is pinned by the tests above and by `tests/model-index.test.mjs`.
  const modelSelector = fs.readFileSync(
    path.join(repoRoot, 'src/components/ModelSelector/ModelSelector.tsx'),
    'utf8'
  );
  const settingsModal = fs.readFileSync(
    path.join(repoRoot, 'src/components/SettingsModal/SettingsModal.tsx'),
    'utf8'
  );

  test('the compaction picker no longer drops the selection for "Use the default"', () => {
    expect(modelSelector).not.toMatch(
      /nextCompactionModel === null \? {} : { compaction: picked }/
    );
    expect(modelSelector).toMatch(/buildMidTurnSwitch\({ compaction:/);
  });

  test('the settings modal no longer drops the selection for "Use the default"', () => {
    expect(settingsModal).not.toMatch(
      /pickedCompaction\.kind === 'inherit-default' \? undefined : pickedCompaction/
    );
    expect(settingsModal).toMatch(/compaction: compactionChanged \? pickedCompaction : undefined/);
  });

  test('neither caller swallows a refusal any more', () => {
    for (const source of [modelSelector, settingsModal]) {
      expect(source).not.toMatch(/const accepted = await requestMidTurnModelSwitch/);
      expect(source).toMatch(/result\.message !== null/);
      expect(source).toMatch(/type: 'SET_ERROR'/);
    }
  });
});
