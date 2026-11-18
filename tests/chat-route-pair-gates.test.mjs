/**
 * The chat route's provider/pair gates, driven END TO END (bug hunt A7).
 *
 * These behaviours used to be pinned by reading the route's SOURCE
 * (`expect(chatRoute).toContain('providerNotConfiguredMessage')`), which
 * passes even if the gate is deleted, and by comparing the position of
 * strings in the file. Here the route's real `POST` handler is called
 * in-process, in a temporary working directory, against two scripted
 * providers, and what is asserted is what a client and a provider actually
 * see: the HTTP status and message, the SSE frames, and which provider
 * received the model call and with which model.
 *
 * The mid-turn switch is registered through the real registry BEFORE the
 * turn starts; the route consumes it at the top of its first loop iteration,
 * which is before any model call.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { enterScratchCwd, startFakeOllama } from './helpers/fakeOllama.mjs';

const MAIN_MODEL = 'main-model';
const GOOD_MODEL = 'good-model';
const REFUSED_MODEL = 'beam';

/** Per-test scripted replies, by provider. Reset before every test. */
const scripts = { a: null, b: null };

let scratch;
let fakeHome;
let stopMCPConfigWatcher;
let getClientManager;
let providerA;
let providerB;
let POST;
let createSession;
let registerActiveTurn;
let unregisterActiveTurn;
let requestModelSwitch;
let recordProviderModels;
let invalidateModelIndex;
let setModelIndexDeps;
let providerNotConfiguredMessage;

beforeAll(async () => {
  scratch = enterScratchCwd('locopilot-chat-gates');
  // The route starts the user's MCP servers and loads their skills from the
  // home directory. Against the real one, the suite connected to whatever the
  // developer has configured (OAuth servers, subprocesses) and then never
  // exited. An empty home keeps it hermetic.
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'locopilot-chat-gates-home-'));
  jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  // A test may script a provider's replies (`scripts.b = (call) => ...`);
  // without a script it answers with a fixed text.
  providerA = await startFakeOllama((call) =>
    scripts.a ? scripts.a(call) : { text: 'ANSWER-FROM-A' }
  );
  providerB = await startFakeOllama((call) =>
    scripts.b ? scripts.b(call) : { text: 'ANSWER-FROM-B' }
  );
  fs.writeFileSync(
    `${scratch.dir}/config.json`,
    JSON.stringify({
      providers: [
        { id: 'a', name: 'Provider A', provider: 'ollama', baseUrl: providerA.baseUrl },
        { id: 'b', name: 'Provider B', provider: 'ollama', baseUrl: providerB.baseUrl },
      ],
      model: MAIN_MODEL,
      numCtx: 8192,
      chatTimeoutMs: 20_000,
      yolo: true,
      thinkingEnabled: false,
      promptTimestamps: false,
      citeSources: false,
      redactSecrets: true,
      webSearch: {},
      completionMode: 'normal',
      maxPromptLoopIterations: 3,
    })
  );
  // The route reaches `jsdom` only through the web tools (HTML extraction),
  // which these tests never call. jsdom's dependency `@exodus/bytes` is
  // ESM-only, and Jest can `require()` it only on Node 24.9+, so on an older
  // Node (the Windows development machine runs 22) merely IMPORTING the route
  // failed with "Must use import to load ES Module" and the whole suite was
  // lost. A stub keeps the suite runnable everywhere and changes nothing it
  // asserts. It must be registered before the route is imported.
  jest.unstable_mockModule('jsdom', () => ({
    JSDOM: class {},
    VirtualConsole: class {},
  }));
  ({ POST } = await import('../src/app/api/chat/route.ts'));
  ({ stopMCPConfigWatcher } = await import('../src/mcp/configWatcher.ts'));
  ({ getClientManager } = await import('../src/mcp/clientManager.ts'));
  ({ createSession } = await import('../src/services/history.ts'));
  ({ registerActiveTurn, unregisterActiveTurn, requestModelSwitch } =
    await import('../src/app/lib/modelSwitchRegistry.ts'));
  ({ recordProviderModels, invalidateModelIndex, setModelIndexDeps } =
    await import('../src/services/modelIndex.ts'));
  ({ providerNotConfiguredMessage } =
    await import('../src/services/contextWindow/configProblem.ts'));
  // The background refresh must tell the truth about what each provider serves.
  setModelIndexDeps({
    fetchModels: async (provider) => (provider.id === 'a' ? [MAIN_MODEL] : [GOOD_MODEL]),
  });
}, 60_000);

afterAll(async () => {
  setModelIndexDeps(null);
  await providerA?.close();
  await providerB?.close();
  // The route starts the MCP config watcher and client manager, and both
  // outlive the tests. They must stop BEFORE the fake home goes away and the
  // real one comes back: deleting the home fires the watcher, which would
  // reload `mcp.json` from the real home and connect to its servers.
  stopMCPConfigWatcher?.();
  await getClientManager?.().closeAll();
  scratch?.leave();
  jest.restoreAllMocks();
  try {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    // Best effort: it is an empty directory in the OS temp folder.
  }
});

beforeEach(() => {
  invalidateModelIndex();
  // The index KNOWS what each provider serves: A serves the main model, B
  // serves only `good-model`.
  recordProviderModels('a', providerA.baseUrl, [MAIN_MODEL]);
  recordProviderModels('b', providerB.baseUrl, [GOOD_MODEL]);
  providerA.requests.length = 0;
  providerB.requests.length = 0;
  scripts.a = null;
  scripts.b = null;
});

/**
 * A conversation with a non-default name. A turn without a `sessionId` creates
 * a session with the DEFAULT name, and the route then starts a fire-and-forget
 * title generation: non-streaming model calls to the provider that arrive
 * AFTER the test body returns and land in the next test's request log. Every
 * turn here runs on a named session, so no title is ever generated.
 */
function namedSession() {
  return createSession('gates', {
    model: MAIN_MODEL,
    providerId: 'a',
    compaction: { kind: 'inherit-default' },
    reasoningEffort: null,
    compactionReasoningEffort: null,
  });
}

/** The models the turn's own (streaming) calls named, in order. */
const chatModels = (provider) =>
  provider.requests.filter((request) => request.body.stream === true).map((r) => r.body.model);

/** Parse an SSE body into `[event, data]` pairs. */
function parseSse(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      return [event, data === undefined ? undefined : JSON.parse(data)];
    });
}

async function turn(extra = {}) {
  const response = await POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        model: MAIN_MODEL,
        providerId: 'a',
        ...extra,
      }),
    })
  );
  return { status: response.status, events: parseSse(await response.text()) };
}

describe('a provider id the config does not know', () => {
  test('is refused with a 409 that names it, and no provider is called', async () => {
    const { status, events } = await turn({ providerId: 'gone' });

    expect(status).toBe(409);
    const error = events.find(([event]) => event === 'error')?.[1];
    expect(error.message).toBe(providerNotConfiguredMessage('gone'));
    // Refused BEFORE any model call: neither provider saw a request, so the
    // turn was not quietly sent somewhere else.
    expect(providerA.requests).toHaveLength(0);
    expect(providerB.requests).toHaveLength(0);
  });

  test('a blank id is "no id", not a stale one', async () => {
    // The gate and the call read the same id: a whitespace-only id must not
    // be refused as a ghost provider in one place and ignored in the other.
    const { status, events } = await turn({
      providerId: '   ',
      model: MAIN_MODEL,
      sessionId: namedSession(),
    });

    expect(status).toBe(200);
    expect(events.some(([event]) => event === 'error')).toBe(false);
  }, 30_000);
});

describe('a mid-turn switch', () => {
  /** A conversation and a pending switch, then a turn on it. */
  async function turnWithSwitch(switchRequest) {
    const sessionId = namedSession();
    registerActiveTurn(sessionId, 'probe');
    try {
      expect(requestModelSwitch(sessionId, switchRequest)).toBe(true);
      return await turn({ sessionId });
    } finally {
      unregisterActiveTurn(sessionId, 'probe');
    }
  }

  test('onto a provider that does not serve the model is REFUSED: announced, and the turn stays where it was', async () => {
    const { events } = await turnWithSwitch({ providerId: 'b', model: REFUSED_MODEL });

    const refused = events.find(
      ([event, data]) => event === 'status' && data.phase === 'model_switch_refused'
    )?.[1];
    expect(refused).toBeDefined();
    expect(refused.reason).toMatch(/does not serve the model "beam"/);
    // The refusal says which model the turn CONTINUES on.
    expect(refused.model).toBe(MAIN_MODEL);
    // It is not announced as a landed switch, and the turn is not failed.
    expect(events.some(([, data]) => data?.phase === 'model_switched')).toBe(false);
    expect(events.some(([event]) => event === 'error')).toBe(false);
    expect(events.some(([event]) => event === 'done')).toBe(true);
    // The model call went to the OLD provider with the OLD model; the
    // refused provider was never called.
    expect(providerB.requests).toHaveLength(0);
    expect(chatModels(providerA)).toStrictEqual([MAIN_MODEL]);
  }, 30_000);

  test('onto a provider that serves the model is APPLIED: the model call goes there', async () => {
    const { events } = await turnWithSwitch({ providerId: 'b', model: GOOD_MODEL });

    expect(
      events.some(([event, data]) => event === 'status' && data.phase === 'model_switched')
    ).toBe(true);
    expect(events.some(([, data]) => data?.phase === 'model_switch_refused')).toBe(false);
    expect(providerA.requests).toHaveLength(0);
    expect(chatModels(providerB)).toStrictEqual([GOOD_MODEL]);
  }, 30_000);

  test('onto a provider id that names nothing is REFUSED, and the turn stays where it was', async () => {
    const { events } = await turnWithSwitch({ providerId: 'ghost-provider', model: GOOD_MODEL });

    const refused = events.find(
      ([event, data]) => event === 'status' && data.phase === 'model_switch_refused'
    )?.[1];
    expect(refused?.reason).toContain('ghost-provider');
    expect(chatModels(providerA)).toStrictEqual([MAIN_MODEL]);
  }, 30_000);

  test('a refused switch does not apply its compaction selection either (A7)', async () => {
    // The switch is refused for its MAIN half (provider B does not serve
    // `beam`), but its compaction half is perfectly valid: GOOD_MODEL on B.
    // A refused switch is refused WHOLE, so the compaction must stay what the
    // conversation had - inherit-default, which with no global compaction
    // model means the main model on the main provider (A). The history is
    // long enough to fire the auto-compaction at the top of the loop, which
    // is a real model call whose destination shows what was applied.
    const filler = (word) => Array.from({ length: 5000 }, (_, i) => `${word}${i}`).join(' ');
    const sessionId = namedSession();
    registerActiveTurn(sessionId, 'probe');
    let events;
    try {
      expect(
        requestModelSwitch(sessionId, {
          providerId: 'b',
          model: REFUSED_MODEL,
          compaction: { kind: 'explicit', model: GOOD_MODEL, providerId: 'b' },
        })
      ).toBe(true);
      ({ events } = await turn({
        sessionId,
        messages: [
          { role: 'user', content: filler('alpha') },
          { role: 'assistant', content: filler('beta') },
          { role: 'user', content: 'hello' },
        ],
      }));
    } finally {
      unregisterActiveTurn(sessionId, 'probe');
    }

    expect(
      events.some(([event, data]) => event === 'status' && data.phase === 'model_switch_refused')
    ).toBe(true);
    // The compaction really ran (otherwise this test proves nothing)...
    expect(events.some(([event]) => event === 'compact')).toBe(true);
    // ...and every call it made, like the turn's own, went to A on the main
    // model. B, the provider of the refused compaction selection, saw nothing.
    expect(providerB.requests).toHaveLength(0);
    expect(new Set(providerA.requests.map((request) => request.body.model))).toStrictEqual(
      new Set([MAIN_MODEL])
    );
  }, 60_000);

  test('a refused switch does not make the turn forget its provider (A7)', async () => {
    // The turn runs on provider B. The first switch asks for a model that
    // provider A does not serve, and is refused. While the first model call
    // is in flight a SECOND switch names a model and NO provider: it must
    // move the model on the provider the turn is still on. Had the refusal
    // cleared the turn's provider, the model-only switch would resolve its
    // provider from the model name and land on A (the first provider).
    const SECOND_MODEL = 'good-model-2';
    recordProviderModels('b', providerB.baseUrl, [GOOD_MODEL, SECOND_MODEL]);
    const sessionId = createSession('gates-forget', {
      model: GOOD_MODEL,
      providerId: 'b',
      compaction: { kind: 'inherit-default' },
      reasoningEffort: null,
      compactionReasoningEffort: null,
    });
    registerActiveTurn(sessionId, 'probe');
    scripts.b = (call) => {
      if (call.body.stream !== true) return { text: 'ANSWER-FROM-B' };
      if (call.index === 1) {
        // Iteration 1's model call: queue the second switch, then ask for a
        // tool so the loop comes round again and applies it.
        requestModelSwitch(sessionId, { model: SECOND_MODEL });
        return {
          toolCalls: [{ id: 'call_unknown_1', function: { name: 'no_such_tool', arguments: {} } }],
        };
      }
      return { text: 'ANSWER-FROM-B' };
    };
    let events;
    try {
      expect(requestModelSwitch(sessionId, { providerId: 'a', model: REFUSED_MODEL })).toBe(true);
      ({ events } = await turn({ sessionId, model: GOOD_MODEL, providerId: 'b' }));
    } finally {
      unregisterActiveTurn(sessionId, 'probe');
    }

    const phases = events
      .filter(([event]) => event === 'status')
      .map(([, data]) => data.phase)
      .filter((phase) => phase === 'model_switch_refused' || phase === 'model_switched');
    expect(phases).toStrictEqual(['model_switch_refused', 'model_switched']);
    // Both model calls went to B: the first on the old model, the second on
    // the model the second switch asked for. A never saw a request.
    expect(chatModels(providerB)).toStrictEqual([GOOD_MODEL, SECOND_MODEL]);
    expect(providerA.requests).toHaveLength(0);
  }, 30_000);
});
