/**
 * Unit tests for the tool-aware compaction summariser input.
 *
 * No network, no live server, no Ollama — the tests exercise the pure
 * functions in src/services/compact/{summarize,reduce,split,serialize}.ts and
 * the local tokenizer.
 *
 * Focus: the summariser must be told WHAT the tools did (the command that
 * ran, the file that was written), not just what they returned — the chunker
 * must keep the serialised input inside the safe input budget — and the
 * user's redaction setting must reach every compaction call site.
 */

import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeEffectiveInputBudget,
  computeSafeInputBudget,
} from '../src/services/compact/budget.ts';
import { estimateSerializedMessageTokens } from '../src/services/compact/reduce.ts';
import {
  buildToolNameMap,
  serializeHistoryForSummaryText,
} from '../src/services/compact/serialize.ts';
import {
  splitHistoryForCompaction,
  splitHistoryIntoChunks,
} from '../src/services/compact/split.ts';
import {
  buildCompactSystemPrompt,
  buildSummarisationInput,
  countSummarisationPromptTokens,
} from '../src/services/compact/summarize.ts';
import { countMessagesTokens, countTextTokens } from '../src/services/tokenizer.ts';

const MODEL = 'gpt-4o';
const BUDGET = { targetSummaryTokens: 500, minSummaryTokens: 300, maxSummaryTokens: 800 };

/**
 * The budget the production path fits the history into.
 *
 * It is NOT the safe input budget: the instruction prompt is part of the
 * request, so it is paid for out of the safe budget before the history is
 * fitted into what is left. The chunker is given the REMAINDER, so the
 * chunk-sizing checks below have to measure against the same number.
 */
const EFFECTIVE_INPUT_BUDGET = computeEffectiveInputBudget(
  computeSafeInputBudget(8192),
  countSummarisationPromptTokens(
    {
      targetSummaryTokens: BUDGET.targetSummaryTokens,
      minSummaryTokens: BUDGET.minSummaryTokens,
      maxSummaryTokens: BUDGET.maxSummaryTokens,
      preservedRecentTokens: 0,
      numCtx: 8192,
    },
    MODEL
  )
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoFile = (...segments) => fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');

/** Convenience builder for an assistant row that issued one tool call. */
function assistantCall(toolName, toolCallId, args) {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: toolCallId, function: { name: toolName, arguments: args } }],
  };
}

/** The user message of a summarisation request. */
function summaryUserContent(input) {
  const userMessage = input.messages.find((message) => message.role === 'user');
  expect(userMessage).toBeTruthy();
  return userMessage.content;
}

/** Builds a history of `turns` tool-using turns. */
function makeLargeHistory(turns) {
  const messages = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push(
      { role: 'user', content: `request ${index}: ${'x'.repeat(180)}` },
      { role: 'assistant', content: `working on ${index}: ${'y'.repeat(180)}` },
      assistantCall('run_command', `call_${index}`, { command: `npm test -- ${index}` }),
      {
        role: 'tool',
        content: `output ${index}: ${'z'.repeat(280)}`,
        tool_call_id: `call_${index}`,
      }
    );
  }
  return messages;
}

describe('buildSummarisationInput', () => {
  test('the summariser input contains the tool name and the command', () => {
    const history = [
      { role: 'user', content: 'fix the failing status bar' },
      assistantCall('run_command', 't1', { command: 'npm test' }),
      { role: 'tool', content: '3 tests failed in src/StatusBar.test.ts', tool_call_id: 't1' },
    ];
    const input = buildSummarisationInput(history, BUDGET, 0, 8192, {
      toolNames: buildToolNameMap(history),
    });
    const content = summaryUserContent(input);
    expect(content).toContain('[ASSISTANT -> run_command]');
    expect(content).toContain('npm test');
    expect(content).toContain('[TOOL run_command]');
    expect(content).toContain('3 tests failed in src/StatusBar.test.ts');
  });

  test('the summariser input is the serialised history text', () => {
    const history = [
      { role: 'user', content: 'hello' },
      assistantCall('run_command', 't1', { command: 'npm test' }),
    ];
    const options = { toolNames: buildToolNameMap(history) };
    const input = buildSummarisationInput(history, BUDGET, 0, 8192, options);
    expect(input.historyText).toBe(serializeHistoryForSummaryText(history, options));
    expect(summaryUserContent(input).endsWith(input.historyText)).toBeTruthy();
  });

  test('the assistant thinking field never reaches the summariser input', () => {
    const history = [
      {
        role: 'assistant',
        content: 'I will run the tests first.',
        thinking: 'internal scratch pad about the status bar',
      },
    ];
    const input = buildSummarisationInput(history, BUDGET, 0, 8192);
    const content = summaryUserContent(input);
    expect(content).not.toContain('internal scratch pad');
    expect(content).not.toContain('thinking');
  });

  test('a write_file body never reaches the summariser input but the path does', () => {
    const body = 'export const secret = "do-not-leak";\n'.repeat(40);
    const history = [
      assistantCall('write_file', 't1', { path: 'src/StatusBar.tsx', content: body }),
    ];
    const input = buildSummarisationInput(history, BUDGET, 0, 8192, {
      toolNames: buildToolNameMap(history),
    });
    const content = summaryUserContent(input);
    expect(content).toContain('src/StatusBar.tsx');
    expect(content).not.toContain('do-not-leak');
    expect(content).not.toContain(body);
  });

  test('the summariser request carries the compaction prompt as its system message', () => {
    // The prompt is NOT expected to stay byte-identical: the summariser's
    // prompt is allowed to change shape. What must hold is that the request
    // still carries the prompt the module builds, and that the prompt still
    // carries the compaction identity — a request that lost it would send the
    // model a prompt that does not say what it is for.
    const input = buildSummarisationInput([{ role: 'user', content: 'hello' }], BUDGET, 0, 8192);
    const systemMessage = input.messages.find((message) => message.role === 'system');
    expect(systemMessage).toBeTruthy();
    expect(systemMessage.content).toBe(
      buildCompactSystemPrompt({
        targetSummaryTokens: BUDGET.targetSummaryTokens,
        minSummaryTokens: BUDGET.minSummaryTokens,
        maxSummaryTokens: BUDGET.maxSummaryTokens,
        preservedRecentTokens: 0,
        numCtx: 8192,
      })
    );
    expect(systemMessage.content.startsWith('You are a conversation summariser.')).toBeTruthy();
  });
});

describe('tool-name map threading', () => {
  test('a tool row whose owning assistant is outside the slice keeps its tool name', () => {
    const fullHistory = [
      { role: 'user', content: 'fix the status bar' },
      assistantCall('run_command', 't1', { command: 'npm test' }),
      { role: 'tool', content: '3 tests failed', tool_call_id: 't1' },
      { role: 'assistant', content: 'looking into it' },
    ];
    // The map is built from the FULL conversation...
    const toolNames = buildToolNameMap(fullHistory);
    // ...but the summarised slice starts at the tool row, so the owning
    // assistant is NOT part of it.
    const slice = fullHistory.slice(2);
    const text = serializeHistoryForSummaryText(slice, { toolNames });
    expect(text).toContain('[TOOL run_command]');
    expect(text).not.toContain('unknown_tool');
  });

  test('without the full-history map the same tool row is labelled unknown_tool', () => {
    const fullHistory = [
      assistantCall('run_command', 't1', { command: 'npm test' }),
      { role: 'tool', content: '3 tests failed', tool_call_id: 't1' },
    ];
    const slice = fullHistory.slice(1);
    const withoutMap = serializeHistoryForSummaryText(slice);
    expect(withoutMap).toContain('[TOOL unknown_tool]');
    const withMap = serializeHistoryForSummaryText(slice, {
      toolNames: buildToolNameMap(fullHistory),
    });
    expect(withMap).toContain('[TOOL run_command]');
  });

  test('every tool row in the summarised slice keeps its tool name', () => {
    const history = makeLargeHistory(12);
    const split = splitHistoryForCompaction(history, MODEL, 8192, 1);
    const toolNames = buildToolNameMap(history);
    const text = serializeHistoryForSummaryText(split.messagesToSummarise, { toolNames });
    expect(text).toContain('[TOOL run_command]');
    expect(text).not.toContain('unknown_tool');
  });
});

describe('redaction threading', () => {
  test('a secret in a tool result is redacted out of the summariser input', () => {
    const secret = 'sk-live-' + 'ABCDEF1234567890';
    const history = [
      assistantCall('read_file', 't1', { path: '.env' }),
      { role: 'tool', content: `OPENAI_API_KEY=${secret}`, tool_call_id: 't1' },
    ];
    const input = buildSummarisationInput(history, BUDGET, 0, 8192, {
      toolNames: buildToolNameMap(history),
      redactSecrets: true,
    });
    const content = summaryUserContent(input);
    expect(content).not.toContain(secret);
    expect(content).toContain('[REDACTED]');
  });

  test('with redaction off the summariser input keeps the raw text', () => {
    const secret = 'sk-live-' + 'ABCDEF1234567890';
    const history = [
      assistantCall('run_command', 't1', { command: `export TOKEN=${secret}` }),
      { role: 'tool', content: `token=${secret}`, tool_call_id: 't1' },
    ];
    const input = buildSummarisationInput(history, BUDGET, 0, 8192, {
      toolNames: buildToolNameMap(history),
      redactSecrets: false,
    });
    const content = summaryUserContent(input);
    expect(content).toContain(secret);
    expect(content).not.toContain('[REDACTED]');
  });

  test('every compaction call site passes the user redaction setting', () => {
    const chatRoute = repoFile('src', 'app', 'api', 'chat', 'route.ts');
    const compactRoute = repoFile('src', 'app', 'api', 'compact', 'route.ts');
    const subAgentTool = repoFile('src', 'tools', 'impl', 'subAgentTool.ts');
    const toolRegistry = repoFile('src', 'tools', 'toolRegistry.ts');

    expect(chatRoute).toMatch(/compactHistory\([\S\s]*?config\?\.redactSecrets \?\? true/);
    expect(compactRoute).toMatch(/compactHistory\([\S\s]*?config\?\.redactSecrets \?\? true/);
    expect(subAgentTool).toMatch(/compactHistory\([\S\s]*?config\.redactSecrets \?\? true/);
    expect(toolRegistry).toMatch(
      /export interface SubAgentConfig[\S\s]*?redactSecrets\?: boolean;/
    );
    expect(chatRoute).toMatch(
      /subAgent: {[\S\s]*?redactSecrets: config\?\.redactSecrets \?\? true/
    );
  });
});

describe('chunking budget', () => {
  test('the chunker splits a large history into several chunks', () => {
    const history = makeLargeHistory(100);
    const toolNames = buildToolNameMap(history);
    const chunks = splitHistoryIntoChunks(history, EFFECTIVE_INPUT_BUDGET, MODEL, (message) =>
      estimateSerializedMessageTokens(message, { toolNames }, MODEL)
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('each chunk stays inside the effective input budget once serialised', () => {
    const history = makeLargeHistory(100);
    const toolNames = buildToolNameMap(history);
    const chunks = splitHistoryIntoChunks(history, EFFECTIVE_INPUT_BUDGET, MODEL, (message) =>
      estimateSerializedMessageTokens(message, { toolNames }, MODEL)
    );
    for (const chunk of chunks) {
      const serialized = serializeHistoryForSummaryText(chunk, { toolNames });
      const tokens = countTextTokens(serialized, MODEL);
      expect(tokens).toBeLessThanOrEqual(EFFECTIVE_INPUT_BUDGET);
    }
  });

  test('the chunker measures the serialised history, not the raw messages', () => {
    // Big write_file bodies: the raw messages are huge, but the serialiser
    // drops the body and keeps only the path, so the summariser's real input
    // is small enough for a single pass.
    const body = 'export const x = 1;\n'.repeat(500);
    const history = [];
    for (let index = 0; index < 8; index += 1) {
      history.push(
        assistantCall('write_file', `call_${index}`, {
          path: `src/file${index}.ts`,
          content: body,
        }),
        { role: 'tool', content: 'applied', tool_call_id: `call_${index}` }
      );
    }
    const toolNames = buildToolNameMap(history);

    const rawChunks = splitHistoryIntoChunks(history, EFFECTIVE_INPUT_BUDGET, MODEL);
    expect(rawChunks.length).toBeGreaterThan(1);

    const serializedChunks = splitHistoryIntoChunks(
      history,
      EFFECTIVE_INPUT_BUDGET,
      MODEL,
      (message) => estimateSerializedMessageTokens(message, { toolNames }, MODEL)
    );
    expect(serializedChunks).toHaveLength(1);

    const serializedTokens = countTextTokens(
      serializeHistoryForSummaryText(serializedChunks[0], { toolNames }),
      MODEL
    );
    expect(serializedTokens).toBeLessThanOrEqual(EFFECTIVE_INPUT_BUDGET);
  });

  test('a huge tool result does not blow the chunk budget', () => {
    // A 120 KB tool row: the tool result is the only unbounded part of the
    // serialised input, so it is capped to a budget-derived number of
    // characters before the chunk boundaries are drawn.
    const safeInputBudget = computeSafeInputBudget(8192);
    const maxToolResultChars = Math.max(2000, safeInputBudget);
    const history = [
      assistantCall('run_command', 't1', { command: 'npm test' }),
      { role: 'tool', content: 'x'.repeat(120_000), tool_call_id: 't1' },
    ];
    const toolNames = buildToolNameMap(history);
    const options = { toolNames, maxToolResultChars };
    const chunks = splitHistoryIntoChunks(history, EFFECTIVE_INPUT_BUDGET, MODEL, (message) =>
      estimateSerializedMessageTokens(message, options, MODEL)
    );
    const serialized = serializeHistoryForSummaryText(chunks[0], options);
    const tokens = countTextTokens(serialized, MODEL);
    expect(tokens).toBeLessThanOrEqual(EFFECTIVE_INPUT_BUDGET);
    expect(serialized).toContain('characters omitted');
  });

  test('a chunk never starts on a tool message', () => {
    const history = makeLargeHistory(100);
    const toolNames = buildToolNameMap(history);
    const chunks = splitHistoryIntoChunks(history, EFFECTIVE_INPUT_BUDGET, MODEL, (message) =>
      estimateSerializedMessageTokens(message, { toolNames }, MODEL)
    );
    for (const chunk of chunks) {
      expect(chunk[0]?.role).not.toBe('tool');
    }
  });
});

describe('the summary budget', () => {
  test('the summary budget is sized against the serialised estimate', () => {
    // The raw estimate counts the whole `tool_calls` argument bodies (a
    // `write_file` body is megabytes of source code the summariser never
    // sees), so sizing the summary against it asks for a summary of something
    // the model was never given.
    const source = repoFile('src', 'services', 'compact', 'reduce.ts');
    const start = source.indexOf('export async function produceConversationSummary');
    const end = source.indexOf('export async function reduceSummaryGroups');
    expect(start !== -1 && end > start).toBeTruthy();
    const body = source.slice(start, end);
    expect(body).toMatch(
      /computeSummaryBudget\(\s*numCtx,\s*aggressiveFactor,\s*serializedEstimate\s*\)/
    );
    expect(body).toMatch(
      /computeSummaryBudget\(\s*numCtx,\s*aggressiveFactor,\s*chunkSerializedEstimate\s*\)/
    );
    expect(body).not.toMatch(/countMessagesTokens\(preparedHistoryMessages/);
  });

  test('the serialised estimate is far smaller than the raw one for file writes', () => {
    const body = 'export const x = 1;\n'.repeat(500);
    const history = [];
    for (let index = 0; index < 8; index += 1) {
      history.push(
        assistantCall('write_file', `call_${index}`, {
          path: `src/file${index}.ts`,
          content: body,
        }),
        { role: 'tool', content: 'applied', tool_call_id: `call_${index}` }
      );
    }
    const rawEstimate = countMessagesTokens(history, MODEL);
    const serializedEstimate = countTextTokens(
      serializeHistoryForSummaryText(history, { toolNames: buildToolNameMap(history) }),
      MODEL
    );
    expect(rawEstimate).toBeGreaterThan(serializedEstimate * 10);
  });
});
