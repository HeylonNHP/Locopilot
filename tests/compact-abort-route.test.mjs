/**
 * A `/compact` the user stopped is never saved.
 *
 * The compact route's real `POST` handler is called in-process against a
 * scripted Ollama. The compaction's database write is held behind another
 * operation on the same session (the write queue is FIFO per session), the
 * request is aborted while the write waits, and the queue is released: the
 * stored conversation must be exactly what it was, and the stream must not
 * report a finished compaction. The abort is checked INSIDE the write's
 * critical section, which is the only place a check can be current when the
 * write was queued behind another one.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { enterScratchCwd } from './helpers/fakeOllama.mjs';

const MODEL = 'test-model';

let scratch;
let server;
let baseUrl;
let POST;
let POST_COMPACT;
let loadSessionMessages;
let enqueueSessionOperation;
let providerCalls = 0;

beforeAll(async () => {
  scratch = enterScratchCwd('locopilot-compact-abort');
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/api/chat') {
        providerCalls += 1;
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: 'T' }, done: false })}\n`
        );
        res.end(
          `${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 50, eval_count: 5 })}\n`
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model_info: {}, capabilities: [], models: [] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  fs.writeFileSync(
    path.join(scratch.dir, 'config.json'),
    JSON.stringify({
      providers: [{ id: 'fake', name: 'Fake', provider: 'ollama', baseUrl, model: MODEL }],
      model: MODEL,
      compactionModel: '',
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
  ({ POST: POST_COMPACT } = await import('../src/app/api/compact/route.ts'));
  ({ loadSessionMessages } = await import('../src/services/history.ts'));
  ({ enqueueSessionOperation } = await import('../src/app/lib/sessionWriteQueue.ts'));
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  scratch?.leave();
});

function parseSse(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => [/^event: (.*)$/m.exec(frame)?.[1]]);
}

const lines = (label, count) =>
  Array.from({ length: count }, (_, i) => `${label} line ${i}: value=${i * 7919}`).join('\n');

const history = () =>
  Array.from({ length: 14 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i + 1}.\n${lines(`older${i}`, 14)}`,
  }));

async function createSavedSession() {
  const response = await POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [...history(), { role: 'user', content: 'hello' }],
        model: MODEL,
        providerId: 'fake',
      }),
    })
  );
  const text = await response.text();
  const sessionId = /"sessionId":(\d+)/.exec(text)?.[1];
  expect(sessionId).toBeDefined();
  return Number(sessionId);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a compaction stopped while its write waits', () => {
  test('is not saved, and the stream does not report it as done', async () => {
    const sessionId = await createSavedSession();
    const before = loadSessionMessages(sessionId);

    // Hold the session's write queue, so the compaction's write waits behind it.
    let release;
    const held = enqueueSessionOperation(
      sessionId,
      () => new Promise((resolve) => (release = resolve))
    );

    const controller = new AbortController();
    const callsBefore = providerCalls;
    const response = await POST_COMPACT(
      new Request('http://localhost/api/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: before, model: MODEL, providerId: 'fake', sessionId }),
        signal: controller.signal,
      })
    );
    const body = response.text();

    // Wait until the summariser has been called and answered, so the route is
    // at (or waiting for) its write, then stop it.
    const deadline = Date.now() + 15_000;
    while (providerCalls === callsBefore && Date.now() < deadline) await sleep(25);
    expect(providerCalls).toBeGreaterThan(callsBefore);
    await sleep(500);
    controller.abort();
    release();
    await held;
    const events = parseSse(await body).map(([event]) => event);

    expect(events).not.toContain('compact');
    expect(loadSessionMessages(sessionId)).toStrictEqual(before);
  }, 60_000);

  test('the same compaction, not stopped, is saved', async () => {
    const sessionId = await createSavedSession();
    const before = loadSessionMessages(sessionId);
    const response = await POST_COMPACT(
      new Request('http://localhost/api/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: before, model: MODEL, providerId: 'fake', sessionId }),
      })
    );
    const events = parseSse(await response.text()).map(([event]) => event);
    expect(events).toContain('compact');
    expect(loadSessionMessages(sessionId)).not.toStrictEqual(before);
  }, 60_000);
});
