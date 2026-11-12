/**
 * Golden copies of every prompt the compaction sends to a model.
 *
 * WHY this file exists: no other test pins the prompt BYTES. `compact-prompt`
 * compares the builder's output with itself and checks substrings, so a changed
 * space, a swapped word or a moved rule would pass while changing what the
 * summariser is asked to do. The refactor in docs/COMPACTION_REFACTOR_PLAN.md
 * moves the prompt text into its own module and builds repeated rules from one
 * constant; this file is the proof that the bytes did not change.
 *
 * The expected strings live in tests/fixtures/compact-prompts.golden.json and
 * were generated from the code as it stood before the refactor. A deliberate
 * prompt change regenerates them:
 *
 *   LOCOPILOT_TEST_WRITE_GOLDEN=1 npm test -- tests/compact-prompt-golden
 *
 * and the diff of that fixture is then the review of the new wording.
 *
 * Covered: the full summariser prompt (preserved-tokens undefined / 0 / set,
 * whole history or one chunk of three, with and without a focus note), the
 * short prompt, the reduction combine prompt, the tool-output distiller's
 * system prompt, the complete summarisation request messages (system plus the
 * serialised history) in both modes, and the web-page compaction prompt for
 * each attempt.
 *
 * No network, no model.
 */

import { beforeAll, describe, expect, test } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  buildReductionCombineSystemPrompt,
  TOOL_DISTILL_SYSTEM_PROMPT,
} from '../src/services/compact/constants.ts';
import { buildSummarisationInput } from '../src/services/compact/summarize.ts';
import {
  buildCompactSystemPrompt,
  buildRetrySystemPrompt,
  SUMMARY_REQUEST_USER_PREFIX,
} from '../src/services/compact/summaryPrompt.ts';
import { buildCompactionPrompt } from '../src/tools/impl/contentCompactor.ts';

const GOLDEN_PATH = new URL('fixtures/compact-prompts.golden.json', import.meta.url);

const WRITE_GOLDEN = process.env['LOCOPILOT_TEST_WRITE_GOLDEN'] === '1';

const BUDGET = { targetSummaryTokens: 500, minSummaryTokens: 300, maxSummaryTokens: 800 };
const NUM_CTX = 8192;
const FOCUS = 'keep the auth refactor details and the failing test output';

/** A history with one write, one command and one error, so the serialiser's wrapper is pinned too. */
const HISTORY = [
  { role: 'user', content: 'The status bar crashes on mount — please fix it.' },
  { role: 'assistant', content: 'I will patch the component and run the test suite.' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_write',
        function: {
          name: 'write_file',
          arguments: {
            path: 'src/statusBar.tsx',
            content: 'export const StatusBar = () => null;\n',
          },
        },
      },
    ],
  },
  { role: 'tool', content: 'wrote 1 file', tool_call_id: 'call_write' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_run', function: { name: 'run_command', arguments: { command: 'npm test' } } },
    ],
  },
  {
    role: 'tool',
    content: "FAILED TypeError: Cannot read properties of undefined (reading 'render')",
    tool_call_id: 'call_run',
  },
];

const withFocus = (focus) => (focus === undefined ? {} : { focus });

/** Every prompt under test, by a stable name. */
function buildCases() {
  const cases = {};

  // The full prompt: 3 values of preservedRecentTokens x whole/chunk x focus/none.
  for (const preservedRecentTokens of [undefined, 0, 1234]) {
    for (const chunk of [undefined, { chunkCount: 3, chunkIndex: 2 }]) {
      for (const focus of [undefined, FOCUS]) {
        const name = [
          'full',
          `preserved=${preservedRecentTokens === undefined ? 'unknown' : preservedRecentTokens}`,
          chunk === undefined ? 'whole' : 'chunk-2-of-3',
          focus === undefined ? 'no-focus' : 'focus',
        ].join(' | ');
        cases[name] = buildCompactSystemPrompt({
          ...BUDGET,
          numCtx: NUM_CTX,
          ...(preservedRecentTokens === undefined ? {} : { preservedRecentTokens }),
          ...chunk,
          ...withFocus(focus),
        });
      }
    }
  }

  // The short prompt (the empty-response retry and the small-window fallback).
  for (const focus of [undefined, FOCUS]) {
    cases[`short | ${focus === undefined ? 'no-focus' : 'focus'}`] = buildRetrySystemPrompt({
      ...BUDGET,
      numCtx: NUM_CTX,
      ...withFocus(focus),
    });
  }

  // The reduction combine prompt.
  for (const focus of [undefined, FOCUS]) {
    cases[`combine | ${focus === undefined ? 'no-focus' : 'focus'}`] =
      buildReductionCombineSystemPrompt(focus);
  }

  cases['distiller system prompt'] = TOOL_DISTILL_SYSTEM_PROMPT;
  cases['summarisation request user prefix'] = SUMMARY_REQUEST_USER_PREFIX;

  // The complete request: system prompt + the serialised history.
  cases['request messages | full, chunk 2 of 3, focus'] = JSON.stringify(
    buildSummarisationInput(
      HISTORY,
      BUDGET,
      1234,
      NUM_CTX,
      { redactSecrets: true },
      {
        chunkCount: 3,
        chunkIndex: 2,
        focus: FOCUS,
      }
    ).messages,
    null,
    2
  );
  cases['request messages | short, no focus'] = JSON.stringify(
    buildSummarisationInput(
      HISTORY,
      BUDGET,
      undefined,
      NUM_CTX,
      { redactSecrets: true },
      {
        promptMode: 'short',
      }
    ).messages,
    null,
    2
  );

  // The web-page compaction prompt (src/tools/impl/contentCompactor.ts).
  const page = 'First line of the page.\nSecond line, with $& and {charLimit} in it.';
  for (const attempt of [1, 2, 3]) {
    cases[`web compaction | attempt ${attempt}`] = buildCompactionPrompt(page, 1000, attempt);
  }

  return cases;
}

const CASES = buildCases();

describe('the compaction prompts are byte-identical to the golden copies', () => {
  let golden;

  beforeAll(() => {
    if (WRITE_GOLDEN) {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(CASES, null, 2)}\n`);
    }
    golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  });

  test.each(Object.keys(CASES))('%s', (name) => {
    expect(golden[name]).toBeDefined();
    expect(CASES[name]).toBe(golden[name]);
  });

  test('the golden file has no stale entries', () => {
    expect(Object.keys(golden).sort()).toStrictEqual(Object.keys(CASES).sort());
  });

  test('every prompt is non-trivial, so an empty golden cannot match an empty prompt', () => {
    const lengths = Object.entries(CASES).map(([name, text]) => ({
      name,
      long: text.length > 40,
    }));
    expect(lengths.filter((entry) => !entry.long)).toStrictEqual([]);
  });
});
