/**
 * The one-time move of legacy `subagent_log` rows onto the tool message of their
 * call (src/services/subagentLogMigration.ts, applied by `history.ts` at import).
 *
 * Three layouts exist in real databases, and the planner has to tell them apart
 * without being told which one it has:
 *
 *  1. logs BEFORE their call (the server's own layout);
 *  2. logs AFTER everything (a manual `/compact` appended them at the tail);
 *  3. logs with no call at all.
 *
 * A log is only ever attached to a call whose ARGUMENTS name its agent, so an
 * agent id that is reused across calls cannot pull a trace onto the wrong one.
 *
 * The second half runs the real migration against a legacy database file:
 * `history.ts` migrates when it is imported, so the scratch directory holds a
 * hand-built old-schema database BEFORE the import. (`DB_PATH` is
 * `process.cwd()`-relative; importing first would touch the checkout's own
 * ./locopilot.db.)
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import Database from 'better-sqlite3';
import path from 'node:path';

import { planSubagentLogMigration } from '../src/services/subagentLogMigration.ts';
import { enterScratchCwd } from './helpers/fakeOllama.mjs';

const row = (id, role, extra = {}) => ({
  id,
  role,
  content: '',
  subagentId: '',
  toolCalls: '[]',
  toolCallId: '',
  ...extra,
});
const runCall = (id, agents) => ({
  id,
  function: {
    name: 'run_subagents',
    arguments: JSON.stringify({ agents: agents.map((agent) => ({ id: agent, prompt: 'p' })) }),
  },
});
const assistant = (id, ...calls) => row(id, 'assistant', { toolCalls: JSON.stringify(calls) });
const result = (id, callId) => row(id, 'tool', { toolCallId: callId, content: 'RESULT' });
const log = (id, agent, content) => row(id, 'subagent_log', { subagentId: agent, content });

const tracesOn = (plan, rowId) => plan.traces.get(rowId);

describe('layout 1: the log is saved before its call', () => {
  test('each log goes to the next call that names its agent, in the order it was logged', () => {
    const plan = planSubagentLogMigration([
      row(1, 'user'),
      log(2, 'a', 'A-1'),
      log(3, 'b', 'B-1'),
      assistant(4, runCall('c1', ['a', 'b'])),
      result(5, 'c1'),
      row(6, 'assistant'),
    ]);
    expect(tracesOn(plan, 5)).toStrictEqual([
      { agentId: 'a', content: 'A-1' },
      { agentId: 'b', content: 'B-1' },
    ]);
    expect(plan.deleteIds).toStrictEqual([2, 3]);
    expect(plan).toMatchObject({ attached: 2, dropped: 0 });
  });

  test('an agent id reused in a later turn goes to that turn’s call, not the earlier one', () => {
    const plan = planSubagentLogMigration([
      row(1, 'user'),
      log(2, 'a', 'FIRST'),
      assistant(3, runCall('c1', ['a'])),
      result(4, 'c1'),
      row(5, 'user'),
      log(6, 'a', 'SECOND'),
      assistant(7, runCall('c2', ['a'])),
      result(8, 'c2'),
    ]);
    expect(tracesOn(plan, 4)).toStrictEqual([{ agentId: 'a', content: 'FIRST' }]);
    expect(tracesOn(plan, 8)).toStrictEqual([{ agentId: 'a', content: 'SECOND' }]);
  });

  test('two calls of one turn that reuse an id each get their own log', () => {
    const plan = planSubagentLogMigration([
      row(1, 'user'),
      log(2, 'a', 'ONE'),
      log(3, 'a', 'TWO'),
      assistant(4, runCall('c1', ['a']), runCall('c2', ['a'])),
      result(5, 'c1'),
      result(6, 'c2'),
    ]);
    expect(tracesOn(plan, 5)).toStrictEqual([{ agentId: 'a', content: 'ONE' }]);
    expect(tracesOn(plan, 6)).toStrictEqual([{ agentId: 'a', content: 'TWO' }]);
  });
});

describe('layout 2: every log was appended after everything', () => {
  // [summary, the surviving turns..., then the logs of ALL calls ever made].
  // Calls 1 and 2 were summarised away, so their logs have no call any more.
  const rows = () => [
    row(1, 'assistant', { content: 'SUMMARY' }),
    row(2, 'user'),
    assistant(3, runCall('c3', ['a'])),
    result(4, 'c3'),
    assistant(5, runCall('c4', ['a'])),
    result(6, 'c4'),
    row(7, 'assistant'),
    log(8, 'a', 'FOR-C1'),
    log(9, 'a', 'FOR-C2'),
    log(10, 'a', 'FOR-C3'),
    log(11, 'a', 'FOR-C4'),
  ];

  test('the last log is the last call’s, and so on backwards', () => {
    const plan = planSubagentLogMigration(rows());
    expect(tracesOn(plan, 4)).toStrictEqual([{ agentId: 'a', content: 'FOR-C3' }]);
    expect(tracesOn(plan, 6)).toStrictEqual([{ agentId: 'a', content: 'FOR-C4' }]);
  });

  test('the logs of summarised calls are dropped, and every log row is deleted', () => {
    const plan = planSubagentLogMigration(rows());
    expect(plan).toMatchObject({ attached: 2, dropped: 2 });
    expect(plan.deleteIds).toStrictEqual([8, 9, 10, 11]);
  });

  test('a call goes to the agents that its arguments name', () => {
    const plan = planSubagentLogMigration([
      row(1, 'user'),
      assistant(2, runCall('c1', ['a'])),
      result(3, 'c1'),
      assistant(4, runCall('c2', ['b'])),
      result(5, 'c2'),
      log(6, 'a', 'A'),
      log(7, 'b', 'B'),
    ]);
    expect(tracesOn(plan, 3)).toStrictEqual([{ agentId: 'a', content: 'A' }]);
    expect(tracesOn(plan, 5)).toStrictEqual([{ agentId: 'b', content: 'B' }]);
  });

  test('a call’s agents keep the order they were logged in', () => {
    const plan = planSubagentLogMigration([
      row(1, 'user'),
      assistant(2, runCall('c1', ['a', 'b'])),
      result(3, 'c1'),
      log(4, 'a', 'A'),
      log(5, 'b', 'B'),
    ]);
    expect(tracesOn(plan, 3).map((trace) => trace.agentId)).toStrictEqual(['a', 'b']);
  });
});

describe('layout 3 and the edge cases', () => {
  test('a log with no call at all is dropped and deleted', () => {
    const plan = planSubagentLogMigration([
      row(1, 'user'),
      log(2, 'a', 'ORPHAN'),
      row(3, 'assistant'),
    ]);
    expect(plan.traces.size).toBe(0);
    expect(plan).toMatchObject({ attached: 0, dropped: 1, deleteIds: [2] });
  });

  test('a log is never attached to a call that does not name its agent', () => {
    const plan = planSubagentLogMigration([
      row(1, 'user'),
      assistant(2, runCall('c1', ['a'])),
      result(3, 'c1'),
      log(4, 'zzz', 'STRANGER'),
    ]);
    expect(plan.traces.size).toBe(0);
    expect(plan.dropped).toBe(1);
  });

  test('a log is never attached to a call that comes AFTER it in the tail', () => {
    // Pass 2 is for logs that trail their call; a log before every call that
    // could own it, in another turn, is not pulled backwards onto one.
    const plan = planSubagentLogMigration([
      log(1, 'a', 'EARLY'),
      row(2, 'user'),
      assistant(3, runCall('c1', ['a'])),
      result(4, 'c1'),
    ]);
    expect(plan.traces.size).toBe(0);
    expect(plan.dropped).toBe(1);
  });

  test('a call whose arguments cannot be read accepts any agent', () => {
    const plan = planSubagentLogMigration([
      row(1, 'user'),
      log(2, 'a', 'A'),
      row(3, 'assistant', {
        toolCalls: JSON.stringify([
          { id: 'c1', function: { name: 'run_subagents', arguments: '{oops' } },
        ]),
      }),
      result(4, 'c1'),
    ]);
    expect(tracesOn(plan, 4)).toStrictEqual([{ agentId: 'a', content: 'A' }]);
  });

  test('a session with no legacy rows plans nothing', () => {
    const plan = planSubagentLogMigration([row(1, 'user'), row(2, 'assistant')]);
    expect(plan).toStrictEqual({ traces: new Map(), deleteIds: [], attached: 0, dropped: 0 });
  });
});

describe('the migration, against a legacy database file', () => {
  let scratch;
  let loadSessionMessages;
  let updateSessionMessages;
  let db;

  beforeAll(async () => {
    scratch = enterScratchCwd('locopilot-traces-migration');
    // An OLD database: no `subagent_traces` column, a `subagent_log` row per agent.
    db = new Database(path.join(scratch.dir, 'locopilot.db'));
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, model TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', thinking TEXT NOT NULL DEFAULT '',
        tool_calls TEXT NOT NULL DEFAULT '[]', images TEXT NOT NULL DEFAULT '[]',
        subagent_id TEXT NOT NULL DEFAULT '', tool_call_id TEXT NOT NULL DEFAULT '', created_at DATETIME,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      INSERT INTO sessions (id, name, model) VALUES (1, 'legacy', 'm');
    `);
    const insert = db.prepare(
      'INSERT INTO messages (session_id, role, content, tool_calls, subagent_id, tool_call_id) VALUES (1, ?, ?, ?, ?, ?)'
    );
    const call = JSON.stringify([runCall('c1', ['researcher'])]);
    insert.run('user', 'research it', '[]', '', '');
    insert.run('subagent_log', 'the researcher read 3 files', '[]', 'researcher', '');
    insert.run('assistant', '', call, '', '');
    insert.run('tool', 'RESULT', '[]', '', 'c1');
    insert.run('assistant', 'here you go', '[]', '', '');
    db.close();

    ({ loadSessionMessages, updateSessionMessages } = await import('../src/services/history.ts'));
  });

  afterAll(() => {
    scratch?.leave();
  });

  test('the log is now a trace on its call’s tool message, and the row is gone', () => {
    const messages = loadSessionMessages(1);
    expect(messages.map((m) => m.role)).toStrictEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messages[2].subagentTraces).toStrictEqual([
      { agentId: 'researcher', content: 'the researcher read 3 files' },
    ]);
  });

  test('the trace is kept by the next save (the staging table has the column)', () => {
    updateSessionMessages(1, loadSessionMessages(1));
    expect(loadSessionMessages(1)[2].subagentTraces).toStrictEqual([
      { agentId: 'researcher', content: 'the researcher read 3 files' },
    ]);
  });
});
