/**
 * The chat route, end to end, for a turn that calls `run_subagents`.
 *
 * WHY: every other test of the traces covers one piece (the book, the reducer,
 * the database, the migration). What none of them can show is that the route
 * wires the pieces together: the call id reaching the SSE events, the sink
 * filing text under it, and the trace being saved ON the tool message that
 * answers the call — in order, in the database, with no `subagent_log` row.
 *
 * The route's real `POST` handler is called in-process, in a TEMPORARY working
 * directory (the config and the database are `process.cwd()`-relative, so the
 * scratch directory is entered before anything is imported). The provider is a
 * scripted Ollama on 127.0.0.1: the main model asks for `run_subagents`, the
 * sub-agent answers, the main model finishes. No network, no real model.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { enterScratchCwd } from './helpers/fakeOllama.mjs';

const MODEL = 'test-model';
const SUBAGENT_TEXT = 'SUBAGENT-FOUND-IT';
const FINAL_TEXT = 'ALL-DONE';

let scratch;
let server;
let baseUrl;
let POST;
let POST_COMPACT;
let loadSessionMessages;
let requests;

/** The scripted provider: told apart by what the request carries. */
function reply(body) {
  const messages = body.messages ?? [];
  const toolNames = (body.tools ?? []).map((tool) => tool.function?.name);
  const last = messages.at(-1);
  // A turn that must not start another batch asks for a plain answer.
  if (JSON.stringify(messages).includes('JUST-ANSWER') && last?.role === 'user') {
    return { content: FINAL_TEXT };
  }
  if (toolNames.includes('run_subagents') && last?.role === 'user') {
    return {
      tool_calls: [
        {
          // Real Ollama assigns the call an id; a tool result without one is
          // display-only by design and is never saved.
          id: 'call_run_subagents_1',
          function: {
            name: 'run_subagents',
            arguments: { agents: [{ id: 'researcher', prompt: 'find the thing' }] },
          },
        },
      ],
    };
  }
  if (last?.role === 'tool') return { content: FINAL_TEXT };
  if (!toolNames.includes('run_subagents') && toolNames.length > 0) {
    return { content: SUBAGENT_TEXT };
  }
  return { content: 'T' };
}

beforeAll(async () => {
  scratch = enterScratchCwd('locopilot-traces-route');
  requests = [];
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/api/chat') {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        requests.push(body);
        const message = { role: 'assistant', content: '', ...reply(body) };
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message, done: false })}\n`);
        res.end(
          `${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 50, eval_count: 5 })}\n`
        );
        return;
      }
      // Model probes (/api/show, /api/tags, /api/ps): nothing to say.
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
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  scratch?.leave();
});

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

async function runTurn(extra = {}) {
  const response = await POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'research it' }],
        model: MODEL,
        providerId: 'fake',
        ...extra,
      }),
    })
  );
  return parseSse(await response.text());
}

describe('a turn that calls run_subagents', () => {
  let events;
  let sessionId;
  let saved;

  beforeAll(async () => {
    events = await runTurn();
    sessionId = events.find(([event]) => event === 'session_created')?.[1]?.sessionId;
    saved = loadSessionMessages(sessionId);
  }, 60_000);

  test('the turn completes with the main model’s final answer', () => {
    expect(events.some(([event]) => event === 'error')).toBe(false);
    expect(events.some(([event]) => event === 'done')).toBe(true);
    expect(saved.at(-1)).toMatchObject({ role: 'assistant', content: FINAL_TEXT });
  });

  test('the live events carry the id of the call they belong to', () => {
    const callId = events.find(([event]) => event === 'tool_call')?.[1]?.toolCallId;
    expect(typeof callId).toBe('string');
    const subagentEvents = events.filter(([event]) => event.startsWith('subagent_'));
    expect(subagentEvents.length).toBeGreaterThan(0);
    for (const [, data] of subagentEvents) {
      expect(data.toolCallId).toBe(callId);
      expect(data.agentId).toBe('researcher');
    }
  });

  test('the trace is saved ON the tool message that answers the call', () => {
    const tool = saved.find((message) => message.role === 'tool');
    expect(tool).toBeDefined();
    expect(tool.subagentTraces).toHaveLength(1);
    expect(tool.subagentTraces[0].agentId).toBe('researcher');
    expect(tool.subagentTraces[0].content).toContain(SUBAGENT_TEXT);
    // The id the events announced is the id of the saved result.
    const callId = events.find(([event]) => event === 'tool_call')?.[1]?.toolCallId;
    expect(tool.tool_call_id).toBe(callId);
  });

  test('the saved order is user, call, result, answer — no separate log row', () => {
    expect(saved.map((message) => message.role)).toStrictEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  test('no request to the provider ever carried the traces', () => {
    expect(requests.length).toBeGreaterThanOrEqual(3);
    const sent = JSON.stringify(requests);
    expect(sent).not.toContain('subagentTraces');
  });
});

describe('a manual /compact after that turn', () => {
  // The original bug: /compact took every sub-agent log out of the history,
  // compacted the rest, and put the logs back at the END of the conversation —
  // after the model's final answer. Now the trace is on its tool message, so
  // there is nothing to put back.
  const lines = (label, count) =>
    Array.from({ length: count }, (_, i) => `${label} line ${i}: value=${i * 7919}`).join('\n');

  test('the trace stays on its call, and no trace trails the final answer', async () => {
    const events = await runTurn();
    const sessionId = events.find(([event]) => event === 'session_created')?.[1]?.sessionId;
    const turn = loadSessionMessages(sessionId);

    // Older chatter first, so the sub-agent turn is the RECENT part that is kept.
    const older = Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i + 1}.\n${lines(`older${i}`, 14)}`,
    }));

    const response = await POST_COMPACT(
      new Request('http://localhost/api/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [...older, ...turn],
          model: MODEL,
          providerId: 'fake',
          sessionId,
        }),
      })
    );
    const compacted = parseSse(await response.text());
    expect(compacted.find(([event]) => event === 'error')).toBeUndefined();
    expect(compacted.some(([event]) => event === 'compact')).toBe(true);

    const after = loadSessionMessages(sessionId);
    const tool = after.find((message) => message.role === 'tool');
    expect(tool?.subagentTraces?.[0]?.agentId).toBe('researcher');
    expect(tool?.subagentTraces?.[0]?.content).toContain(SUBAGENT_TEXT);
    // The conversation still ends with the model's own answer, not with a log.
    expect(after.at(-1)).toMatchObject({ role: 'assistant', content: FINAL_TEXT });
    // And the compacted history the page receives carries the same trace.
    const sent = compacted.find(([event]) => event === 'compact')[1].messages;
    expect(sent.find((message) => message.role === 'tool')?.subagentTraces).toHaveLength(1);
  }, 60_000);
});

describe('auto-compaction in the middle of a later turn', () => {
  // The other half of the original bug: the chat route replaced the stored
  // history with an array that never held the logs, so auto-compact DELETED
  // them. Now the traces are on the tool messages the array does hold.
  const lines = (label, count) =>
    Array.from({ length: count }, (_, i) => `${label} line ${i}: value=${i * 7919}`).join('\n');

  test('a preserved tool message keeps its trace through an automatic compaction', async () => {
    const first = await runTurn();
    const sessionId = first.find(([event]) => event === 'session_created')?.[1]?.sessionId;
    const turn = loadSessionMessages(sessionId);

    // About 7,500 tokens of older chatter in an 8,192-token window crosses the
    // compaction trigger before the next model call.
    const older = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i + 1}.\n${lines(`older${i}`, 14)}`,
    }));

    const events = await runTurn({
      sessionId,
      messages: [...older, ...turn, { role: 'user', content: 'JUST-ANSWER: thanks' }],
    });

    expect(events.some(([event]) => event === 'error')).toBe(false);
    // The branch proof: the automatic compaction really ran.
    expect(events.some(([event]) => event === 'compact')).toBe(true);

    const after = loadSessionMessages(sessionId);
    const tool = after.find((message) => message.role === 'tool');
    expect(tool?.subagentTraces?.[0]?.content).toContain(SUBAGENT_TEXT);
    expect(after.at(-1)).toMatchObject({ role: 'assistant', content: FINAL_TEXT });
  }, 60_000);
});
