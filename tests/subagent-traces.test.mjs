/**
 * Sub-agent traces live on the tool message that answers the `run_subagents`
 * call (`ChatMessage.subagentTraces`), not in rows of their own.
 *
 * WHY: a trace used to be a sibling `subagent_log` row whose only "position" was
 * its index in the array. Compaction rebuilt the array from a filtered copy, so
 * the logs were either put back at the END of the conversation (manual
 * `/compact`) or lost (auto-compact). Hung on the tool message, a trace is kept
 * and dropped with the message it belongs to, so compaction needs no special
 * case. This file pins the properties that design depends on:
 *
 *  - it is NEVER sent to a model (the one wire projection, `toWireMessages`),
 *    and it is not counted as tokens;
 *  - it survives a save/load round trip through the staging table;
 *  - compaction keeps it with a preserved tool message and drops it with a
 *    summarised one, and the summariser never sees it.
 *
 * ISOLATION: `DB_PATH` is `process.cwd()`-relative, so the history tests chdir
 * into a scratch directory BEFORE importing `history.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { runScenario } from './helpers/compactionHarness.mjs';
import { enterScratchCwd, startFakeOllama } from './helpers/fakeOllama.mjs';

const MODEL = 'test-model';
const TRACE_TEXT = 'TRACE-MARKER researcher read 3 files and wrote nothing';

let scratch;
let SubagentTraceBook;
let isChatMessage;
let toWireMessages;
let sendLlmChat;
let sanitizeChatMessage;
let countMessagesTokens;
let compactHistory;
let TOOL_DISTILL_SYSTEM_PROMPT;
let createSession;
let updateSessionMessages;
let loadSessionMessages;

beforeAll(async () => {
  scratch = enterScratchCwd('locopilot-subagent-traces');
  ({ SubagentTraceBook } = await import('../src/services/subagentTraces.ts'));
  ({ isChatMessage } = await import('../src/services/chatMessageGuard.ts'));
  ({ toWireMessages } = await import('../src/services/wireMessages.ts'));
  ({ sendLlmChat } = await import('../src/services/llm.ts'));
  ({ sanitizeChatMessage } = await import('../src/services/textUtils.ts'));
  ({ countMessagesTokens } = await import('../src/services/tokenizer.ts'));
  ({ compactHistory } = await import('../src/services/compact/orchestrate.ts'));
  ({ TOOL_DISTILL_SYSTEM_PROMPT } = await import('../src/services/compact/constants.ts'));
  ({ createSession, updateSessionMessages, loadSessionMessages } =
    await import('../src/services/history.ts'));
});

afterAll(() => {
  scratch?.leave();
});

const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });
const traces = () => [
  { agentId: 'researcher', content: TRACE_TEXT },
  { agentId: 'writer', content: 'wrote the summary' },
];

/** The turn a `run_subagents` call leaves behind: the call, then its result with the traces. */
const subagentTurn = (id = 'call-sub') => [
  { role: 'assistant', content: '', tool_calls: [call(id, 'run_subagents')] },
  {
    role: 'tool',
    content: 'RESULT: two agents finished',
    tool_call_id: id,
    subagentTraces: traces(),
  },
];

/** Varied text, so the tokenizer sees real words. */
const lines = (label, count) =>
  Array.from({ length: count }, (_, index) => `${label} line ${index}: value=${index * 7919}`).join(
    '\n'
  );

/** `count` alternating user/assistant messages of ~190 tokens each. */
const chatter = (count, label = 'm') =>
  Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${index + 1}.\n${lines(`${label}${index}`, 14)}`,
  }));

describe('SubagentTraceBook: the server’s copy, per call', () => {
  test('an agent id reused in another call is a trace of its own', () => {
    const book = new SubagentTraceBook();
    book.appendChunk('call-1', 'researcher', 'old');
    book.appendChunk('call-2', 'researcher', 'new');
    expect(book.take('call-1')).toStrictEqual([{ agentId: 'researcher', content: 'old' }]);
    expect(book.take('call-2')).toStrictEqual([{ agentId: 'researcher', content: 'new' }]);
  });

  test('taking a call forgets it, and an unknown call has no traces', () => {
    const book = new SubagentTraceBook();
    book.appendLine('call-1', 'a', 'x');
    book.take('call-1');
    expect(book.take('call-1')).toStrictEqual([]);
    expect(book.take('never-seen')).toStrictEqual([]);
  });

  test('agents come out in the order they first wrote', () => {
    const book = new SubagentTraceBook();
    book.appendChunk('c', 'second-id-but-first-write', '1');
    book.appendChunk('c', 'a', '2');
    book.appendChunk('c', 'second-id-but-first-write', '3');
    expect(book.take('c').map((t) => t.agentId)).toStrictEqual(['second-id-but-first-write', 'a']);
  });

  test('lines are separated by one newline, none before the first; chunks are raw', () => {
    const book = new SubagentTraceBook();
    book.appendLine('c', 'a', 'L1');
    book.appendChunk('c', 'a', 'CHUNK');
    book.appendLine('c', 'a', 'L2');
    expect(book.take('c')[0].content).toBe('L1CHUNK\nL2');
  });

  describe('dropTail: the failed turn that is being re-issued', () => {
    test('drops only the last turn’s text and returns what remains', () => {
      const book = new SubagentTraceBook();
      book.appendChunk('c', 'a', 'EARLIER');
      book.appendChunk('c', 'a', 'FAILED');
      expect(book.dropTail('c', 'a', 'FAILED'.length)).toBe('EARLIER');
      expect(book.take('c')[0].content).toBe('EARLIER');
    });

    test('dropping everything removes the agent', () => {
      const book = new SubagentTraceBook();
      book.appendChunk('c', 'a', 'FAILED');
      expect(book.dropTail('c', 'a', 100)).toBe('');
      expect(book.take('c')).toStrictEqual([]);
    });

    test.each([
      ['nothing to drop', 0],
      ['a negative count', -5],
      ['not a number', Number.NaN],
    ])('%s changes nothing and says so (no event should be sent)', (_label, dropChars) => {
      const book = new SubagentTraceBook();
      book.appendChunk('c', 'a', 'TEXT');
      expect(book.dropTail('c', 'a', dropChars)).toBeNull();
      expect(book.take('c')[0].content).toBe('TEXT');
    });

    test('an unknown call or agent changes nothing', () => {
      const book = new SubagentTraceBook();
      book.appendChunk('c', 'a', 'TEXT');
      expect(book.dropTail('other', 'a', 2)).toBeNull();
      expect(book.dropTail('c', 'nobody', 2)).toBeNull();
    });

    test('it only touches the agent of that call', () => {
      const book = new SubagentTraceBook();
      book.appendChunk('c1', 'a', 'ONE');
      book.appendChunk('c2', 'a', 'TWO');
      book.dropTail('c1', 'a', 3);
      expect(book.take('c2')[0].content).toBe('TWO');
    });
  });
});

describe('isChatMessage: what the routes accept from the page', () => {
  test.each([
    ['a user message', { role: 'user', content: 'hi' }],
    ['a tool message with traces', subagentTurn()[1]],
    ['a tool message with an empty trace list', { role: 'tool', content: 'x', subagentTraces: [] }],
  ])('accepts %s', (_label, message) => {
    expect(isChatMessage(message)).toBe(true);
  });

  test.each([
    ['no role', { content: 'x' }],
    ['an unknown role', { role: 'robot', content: 'x' }],
    ['the retired subagent_log role', { role: 'subagent_log', content: 'x', subagentId: 'a' }],
    ['non-string content', { role: 'user', content: 5 }],
    ['traces that are not a list', { role: 'tool', content: 'x', subagentTraces: 'nope' }],
    ['a trace with no content', { role: 'tool', content: 'x', subagentTraces: [{ agentId: 'a' }] }],
    [
      'a trace with a non-string agent id',
      { role: 'tool', content: 'x', subagentTraces: [{ agentId: 7, content: 'c' }] },
    ],
    ['null', null],
  ])('refuses %s', (_label, message) => {
    expect(isChatMessage(message)).toBe(false);
  });
});

describe('toWireMessages: the one projection every LLM request goes through', () => {
  test('drops the traces and keeps every protocol field', () => {
    const [, tool] = subagentTurn();
    const [wire] = toWireMessages([tool]);
    expect(wire).not.toHaveProperty('subagentTraces');
    expect(wire).toMatchObject({
      role: 'tool',
      content: 'RESULT: two agents finished',
      tool_call_id: 'call-sub',
    });
  });

  test('never mutates the conversation it was given', () => {
    const [, tool] = subagentTurn();
    toWireMessages([tool]);
    expect(tool.subagentTraces).toStrictEqual(traces());
  });

  test('hands back the same array, and the same messages, when nothing needs dropping', () => {
    const messages = chatter(4);
    expect(toWireMessages(messages)).toBe(messages);
    const mixed = [...messages, ...subagentTurn()];
    const wire = toWireMessages(mixed);
    expect(wire[0]).toBe(mixed[0]);
  });
});

describe('what a provider is sent', () => {
  test('a request carrying a traced tool message reaches the provider without the traces', async () => {
    const fake = await startFakeOllama(() => ({ text: 'ok' }));
    try {
      await sendLlmChat(
        { baseUrl: fake.baseUrl },
        {
          model: MODEL,
          messages: [{ role: 'user', content: 'go' }, ...subagentTurn()],
          tools: [],
          numCtx: 4096,
        }
      );
      expect(fake.requests).toHaveLength(1);
      const sent = JSON.stringify(fake.requests[0].body);
      expect(sent).not.toContain('subagentTraces');
      expect(sent).not.toContain('TRACE-MARKER');
      // The tool result itself is still sent: only the UI-only field is dropped.
      expect(sent).toContain('RESULT: two agents finished');
    } finally {
      await fake.close();
    }
  });
});

describe('the traces are not tokens', () => {
  test('a message counts the same with and without its traces', () => {
    const [, withTraces] = subagentTurn();
    const { subagentTraces: _traces, ...without } = withTraces;
    expect(countMessagesTokens([withTraces], MODEL)).toBe(countMessagesTokens([without], MODEL));
  });
});

describe('sanitising', () => {
  test('keeps the traces and strips special tokens from their text and agent ids', () => {
    const sanitized = sanitizeChatMessage({
      role: 'tool',
      content: 'done',
      tool_call_id: 'c1',
      subagentTraces: [{ agentId: 'a<|endoftext|>', content: 'x<|endoftext|>y' }],
    });
    expect(sanitized.subagentTraces).toStrictEqual([{ agentId: 'a', content: 'xy' }]);
  });

  test('a message without traces gets no empty field', () => {
    const sanitized = sanitizeChatMessage({ role: 'tool', content: 'done', tool_call_id: 'c1' });
    expect(sanitized).not.toHaveProperty('subagentTraces');
  });
});

describe('persistence', () => {
  const SELECTION = {
    model: MODEL,
    providerId: null,
    compactionModel: null,
    compactionProviderId: null,
    reasoningEffort: null,
    compactionReasoningEffort: null,
  };

  test('a trace survives a save and a load, in place, and again after a second save', () => {
    const id = createSession('traces', SELECTION);
    const history = [
      { role: 'user', content: 'research this' },
      ...subagentTurn('call-1'),
      { role: 'assistant', content: 'here is what they found' },
    ];
    updateSessionMessages(id, history);

    const loaded = loadSessionMessages(id);
    expect(loaded.map((m) => m.role)).toStrictEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(loaded[2].subagentTraces).toStrictEqual(traces());
    // Only the tool row that answers the call carries them.
    expect(loaded.filter((m) => m.subagentTraces !== undefined)).toHaveLength(1);

    // A second save replaces every row through the staging table: a column
    // missing there would drop the traces here, and nowhere else.
    updateSessionMessages(id, loaded);
    expect(loadSessionMessages(id)[2].subagentTraces).toStrictEqual(traces());
  });

  test('a tool message with no traces loads without the field', () => {
    const id = createSession('no traces', SELECTION);
    updateSessionMessages(id, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [call('c9', 'read_file')] },
      { role: 'tool', content: 'file text', tool_call_id: 'c9' },
    ]);
    expect(loadSessionMessages(id)[2]).not.toHaveProperty('subagentTraces');
  });
});

describe('compaction', () => {
  const run = (messages) =>
    runScenario({
      distillSystemPrompt: TOOL_DISTILL_SYSTEM_PROMPT,
      respond: () => ({ text: 'SUMMARY' }),
      run: (ctx) =>
        compactHistory({ ctx, model: MODEL, messages, numCtx: 8192, redactSecrets: true }),
    });

  test('a preserved tool message keeps its traces', async () => {
    // The run_subagents turn is the LAST turn, so it sits in the preserved window.
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      ...chatter(14),
      { role: 'user', content: 'now research it' },
      ...subagentTurn(),
    ];
    const { value, error, fake } = await run(messages);
    expect(error).toBeUndefined();
    const kept = value.newMessages.find((m) => m.role === 'tool' && m.tool_call_id === 'call-sub');
    expect(kept?.subagentTraces).toStrictEqual(traces());
    // ...and nothing the summariser was sent mentions them.
    expect(JSON.stringify(fake.requests.map((request) => request.body))).not.toContain(
      'TRACE-MARKER'
    );
  });

  test('a summarised tool message takes its traces with it', async () => {
    // The run_subagents turn is the OLDEST turn, so it falls into the summarised slice.
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'research it first' },
      ...subagentTurn(),
      ...chatter(24, 'later'),
    ];
    const { value, error, fake } = await run(messages);
    expect(error).toBeUndefined();
    expect(value.newMessages.some((m) => m.subagentTraces !== undefined)).toBe(false);
    expect(JSON.stringify(fake.requests.map((request) => request.body))).not.toContain(
      'TRACE-MARKER'
    );
  });
});
