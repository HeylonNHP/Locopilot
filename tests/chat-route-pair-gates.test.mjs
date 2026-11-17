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

import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';

import { enterScratchCwd, startFakeOllama } from './helpers/fakeOllama.mjs';

const MAIN_MODEL = 'main-model';
const GOOD_MODEL = 'good-model';
const REFUSED_MODEL = 'beam';

let scratch;
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
  providerA = await startFakeOllama(() => ({ text: 'ANSWER-FROM-A' }));
  providerB = await startFakeOllama(() => ({ text: 'ANSWER-FROM-B' }));
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
  ({ POST } = await import('../src/app/api/chat/route.ts'));
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
  scratch?.leave();
});

beforeEach(() => {
  invalidateModelIndex();
  // The index KNOWS what each provider serves: A serves the main model, B
  // serves only `good-model`.
  recordProviderModels('a', providerA.baseUrl, [MAIN_MODEL]);
  recordProviderModels('b', providerB.baseUrl, [GOOD_MODEL]);
  providerA.requests.length = 0;
  providerB.requests.length = 0;
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
});
