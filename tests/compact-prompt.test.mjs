/**
 * Tests for the compaction summariser's STRUCTURED prompt.
 *
 * WHY these tests exist: the summariser's system prompt used to demand "one
 * dense narrative summary" written in the third person with "no headings, no
 * markdown". That is the wrong shape for a document the model will later use
 * as its ONLY memory of the compacted turns — a narrative has to be read in
 * order, while a document can be looked up in. The prompt now demands a
 * structured summary with six fixed sections, copies every path, symbol,
 * command and error message EXACTLY, invents nothing, keeps the chronology,
 * omits empty sections entirely, treats the history as DATA rather than
 * instructions, and explains the block labels the serialiser emits.
 *
 * The map-reduce combine prompt (REDUCTION_COMBINE_SYSTEM_PROMPT) is
 * rewritten at the same time: merging partial summaries has to keep the six
 * sections and their order instead of flattening them back into prose.
 *
 * The tests come in three kinds:
 *
 *   1. CONTRACT checks — the prompt demands the six sections, exact names,
 *      no invention, chronology, omitted empty sections, the block labels,
 *      the data-not-instructions rule and the token budget.
 *   2. ABSENCE checks — the prompt must NOT license a worse summary. These
 *      exist because a prompt that only ever says what it wants is happy to
 *      ALSO say "repeat anything that seems relevant" or "an error message
 *      may be shortened to its first 80 characters"; a presence-only suite
 *      cannot see that. Every absence check is either a HARD absence (the
 *      wording must not appear at all) or a PROHIBITION check (the wording
 *      may appear, but only inside a clause that forbids it).
 *   3. SHAPE checks — what the model actually produced. The fixture
 *      `tests/fixtures/compact-summary.txt` holds a summary the model
 *      really wrote, and the suite asserts its shape offline.
 *
 * OFFLINE BY DEFAULT. The LAST check is a live model call; it is SKIPPED
 * unless LOCOPILOT_TEST_LIVE_COMPACTION=1 is set, and a skip is reported
 * SEPARATELY from a pass — the headline prints "N passed, M skipped, K
 * failed", so a skipped check is never counted as a passed one.
 *
 *   LOCOPILOT_TEST_LIVE_COMPACTION=1 npm test -- tests/compact-prompt
 *
 * The live check CLAMPS the context window it asks for to 8192 tokens (the
 * configured num_ctx can be far larger than the model accepts), and a
 * provider/network failure is reported as a SKIP with the reason — not as a
 * failure of this repository. Run it from the repo root, because the config
 * is read from the working directory.
 *
 * The fixture is regenerated with:
 *
 *   LOCOPILOT_TEST_LIVE_COMPACTION=1 LOCOPILOT_TEST_LIVE_WRITE_FIXTURE=1 \
 *     npm test -- tests/compact-prompt
 *
 * MUTATION HARNESS (development aid, off by default). Setting
 * LOCOPILOT_TEST_PROMPT_MUTATION=<name> applies a KNOWN-WORSE prompt on
 * purpose and the suite is then expected to FAIL — that is how the absence
 * checks are proven to bite:
 *
 *   LOCOPILOT_TEST_PROMPT_MUTATION=repeat npm test -- tests/compact-prompt
 *
 * Optional overrides: LOCOPILOT_TEST_LIVE_PROVIDER_ID, LOCOPILOT_TEST_LIVE_MODEL.
 */

import { beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildReductionCombineSystemPrompt,
  REDUCTION_COMBINE_SYSTEM_PROMPT,
  SUMMARY_SECTIONS,
} from '../src/services/compact/constants.ts';
import {
  buildToolNameMap,
  serializeHistoryForSummaryText,
} from '../src/services/compact/serialize.ts';
import {
  buildCompactSystemPrompt,
  buildRetrySystemPrompt,
  buildSummarisationInput,
  summariseChunk,
} from '../src/services/compact/summarize.ts';
import { loadConfig } from '../src/services/configManager.ts';
import { buildProviderRequestContext, resolveProvider } from '../src/services/providerResolver.ts';
import { withContext } from './helpers/withContext.mjs';

/**
 * The six sections, in the order they must appear. Hard-coded on purpose:
 * the constant in the source is asserted AGAINST this list, so a change to
 * the constant cannot silently redefine what the tests accept.
 */
const EXPECTED_SECTIONS = ['Goal', 'Changes', 'Decisions', 'Constraints', 'Open work', 'Key data'];

const BUDGET = { targetSummaryTokens: 500, minSummaryTokens: 300, maxSummaryTokens: 800 };
const PRESERVED_RECENT_TOKENS = 1234;
const NUM_CTX = 8192;

const PROMPT_PARAMS = {
  targetSummaryTokens: BUDGET.targetSummaryTokens,
  minSummaryTokens: BUDGET.minSummaryTokens,
  maxSummaryTokens: BUDGET.maxSummaryTokens,
  preservedRecentTokens: PRESERVED_RECENT_TOKENS,
  numCtx: NUM_CTX,
};

/** The parameters of the SHORT prompt (the empty-response retry). */
const RETRY_PARAMS = {
  targetSummaryTokens: BUDGET.targetSummaryTokens,
  minSummaryTokens: BUDGET.minSummaryTokens,
  maxSummaryTokens: BUDGET.maxSummaryTokens,
  numCtx: NUM_CTX,
};

// The golden transcript: one file path, one command, one error message

const GOLDEN_PATH = 'src/services/compact/statusBar.tsx';
const GOLDEN_COMMAND = 'npm run test:compact-prompt';
const GOLDEN_ERROR = "TypeError: Cannot read properties of undefined (reading 'render')";

const GOLDEN_HISTORY = [
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
          arguments: { path: GOLDEN_PATH, content: 'export const StatusBar = () => null;\n' },
        },
      },
    ],
  },
  { role: 'tool', content: 'wrote 1 file', tool_call_id: 'call_write' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_run',
        function: { name: 'run_command', arguments: { command: GOLDEN_COMMAND } },
      },
    ],
  },
  { role: 'tool', content: `FAILED ${GOLDEN_ERROR}`, tool_call_id: 'call_run' },
];

// The prompt under test

/**
 * The known-worse prompts the mutation harness can apply. Each one is a
 * strict REGRESSION of the prompt: it licenses a summary that is worse than
 * the one the contract asks for. The suite must FAIL on every one of them.
 */
const MUTATIONS = {
  repeat: (prompt) =>
    `${prompt}\n\nWrite as much as you can in every section, and repeat anything that seems relevant.`,
  'shorten-errors': (prompt) =>
    `${prompt}\n\nAn error message may be shortened to its first 80 characters.`,
  background: (prompt) =>
    prompt.replace(
      /^Goal: .*$/m,
      'Goal: what the user is trying to achieve, plus every fact you happen to know about the topic'
    ),
  markdown: (prompt) => `${prompt}\n\nUse markdown headings (##) for the sections.`,
  placeholder: (prompt) =>
    prompt.replace('Never write "None" or "N/A".', 'Write "None" in every section that is empty.'),
};

/**
 * The two checks that compare the prompt against the UNMUTATED builder
 * output. Under a mutation they are meaningless (the mutation is applied to
 * the prompt, not to the builder), so they are skipped instead of failing.
 */
const MUTATION_EXEMPT_LABELS = new Set([
  'the summarisation request carries the prompt as its system message',
  'the system message is byte-identical to the exported prompt builder',
]);

const MUTATION = process.env['LOCOPILOT_TEST_PROMPT_MUTATION'] ?? '';

/** A test that is skipped, rather than failed, while a mutated prompt is under test. */
const promptTest = (label, fn) =>
  (MUTATION && MUTATION_EXEMPT_LABELS.has(label) ? test.skip : test)(label, fn);

/**
 * The largest context window the live check asks for.
 *
 * The configured num_ctx of this repo's own config.json is far larger than
 * what a provider accepts, so the live check clamps it.
 */
const LIVE_MAX_NUM_CTX = 8192;

/** The prompt exactly as the source builds it. */
const BUILT_PROMPT = buildCompactSystemPrompt(PROMPT_PARAMS);

/** The prompt under test — the built one, or a deliberately worse variant. */
const PROMPT = MUTATION ? applyMutation(BUILT_PROMPT, MUTATION) : BUILT_PROMPT;

/**
 * The note a user might type after `/compact` — the second prompt under test.
 *
 * WHY it contains none of the words the prohibition lists look for: the whole
 * point of those lists is that a FOCUSED prompt must forbid exactly what the
 * plain one forbids. A note that itself contained "repeat" or "markdown"
 * would make the focused run fail for the wrong reason, and a note that used
 * the six section names would collide with the section-order checks.
 */
const FOCUS = 'keep the auth refactor details and the failing test output';

/**
 * The opening words of the focus paragraph.
 *
 * WHY it is a constant and not an inline string: the label is a SHAPE, and the
 * shape is the thing under test (see "the focus label is not a section"). The
 * old label opened with `WHAT MATTERS MOST (a note …):`, which is the same
 * `Name: purpose` shape as the six section lines one blank line above it, so a
 * model could plausibly emit it as a seventh section — and a section is what
 * reaches the persisted summary.
 */
const FOCUS_LABEL = 'IMPORTANT —';

/**
 * A line that is shaped like a section heading: a capitalised name, optionally
 * a few more capitalised words, optionally a parenthetical, then a colon.
 *
 * This is the shape the six section lines have (`Goal: …`), and the shape the
 * focus label must NOT have.
 */
const SECTION_SHAPED_HEAD = /^[A-Z][A-Za-z]*(?: [A-Za-z]+){0,6}(?: \([^)]*\))?:\s/;

/** The FOCUSED prompt as the source builds it. */
const BUILT_FOCUSED_PROMPT = buildCompactSystemPrompt({ ...PROMPT_PARAMS, focus: FOCUS });

/**
 * The focused prompt under test. The mutation harness applies its mutation to
 * this prompt too, so the prohibition lists below are proven to bite on the
 * prompt the user's note actually produces — not only on the focus-free one.
 */
const FOCUSED_PROMPT = MUTATION
  ? applyMutation(BUILT_FOCUSED_PROMPT, MUTATION)
  : BUILT_FOCUSED_PROMPT;

/**
 * Applies a named mutation to the prompt.
 *
 * @param {string} prompt - the prompt as the source builds it.
 * @param {string} name - the name of the mutation.
 * @returns {string} the mutated prompt.
 */
function applyMutation(prompt, name) {
  if (!Object.hasOwn(MUTATIONS, name)) {
    throw new Error(`unknown mutation "${name}" — known: ${Object.keys(MUTATIONS).join(', ')}`);
  }
  console.warn(`mutation "${name}" applied — the suite is EXPECTED to fail`);
  return MUTATIONS[name](prompt);
}

// The fixture: a summary the model really produced

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'compact-summary.txt');
const FIXTURE_HEADER_START = '=== FIXTURE HEADER ===';
const FIXTURE_HEADER_END = '=== END FIXTURE HEADER ===';

/**
 * Splits the fixture into its provenance header and the summary itself.
 *
 * The header is DELIMITED, not guessed: the summary body is everything after
 * the closing sentinel, so a summary that happens to start with a capitalised
 * word cannot be mistaken for a header, and the header can never be mistaken
 * for a section of the summary.
 *
 * @param {string} raw - the whole fixture file.
 * @returns {{header: string, body: string}} the header and the summary.
 */
function splitFixture(raw) {
  const start = raw.indexOf(FIXTURE_HEADER_START);
  const end = raw.indexOf(FIXTURE_HEADER_END);
  expect(start).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  const header = raw.slice(start + FIXTURE_HEADER_START.length, end).trim();
  const body = raw.slice(end + FIXTURE_HEADER_END.length).replace(/^\r?\n/, '');
  return { header, body };
}

/**
 * A line that opens one of the SIX sections.
 *
 * WHY it names the six and not "any capitalised label": a summary may
 * legitimately contain a line that starts with a capitalised word and a colon
 * — "Error: TypeError: Cannot read …" or "Note: the build was skipped" —
 * and such a line is NOT a section label. Only a line that starts with one of
 * the six section names can break the section contract, so only such a line
 * may fail the shape check.
 */
const SECTION_LABEL_LINE = new RegExp(`^(${EXPECTED_SECTIONS.map(escapeRegExp).join('|')}):`);

/** A line that looks like one of the serialiser's block labels. */
const BLOCK_LABEL_LINE = /^\[(?:USER|ASSISTANT|TOOL|Distilled)\b/;

/**
 * Asserts the SHAPE CONTRACT of a summary produced by the model.
 *
 * Shared by the offline fixture check and the live check, so the live run
 * asserts the same contract the checked-in fixture does.
 *
 * @param {string} summary - the summary text.
 * @param {Array<[string, string]>} facts - the label/value pairs that must
 *   appear verbatim.
 */
function assertSummaryShape(summary, facts) {
  const lines = summary.split(/\r?\n/);

  expect(summary.trim().length).toBeGreaterThan(0);

  // The section labels that are present are a subset of the six, in order.
  let previous = -1;
  const seen = [];
  for (const line of lines) {
    const match = SECTION_LABEL_LINE.exec(line);
    if (!match) continue;
    const label = match[1];
    const index = EXPECTED_SECTIONS.indexOf(label);
    expect(index).not.toBe(-1);
    expect(index).toBeGreaterThan(previous);
    previous = index;
    seen.push(label);
  }
  expect(seen.length).toBeGreaterThan(0);

  // No markdown heading, no serialiser block label, no placeholder.
  for (const line of lines) {
    expect(line).not.toMatch(/^\s*#{1,6}\s/);
    expect(BLOCK_LABEL_LINE.test(line)).toBeFalsy();
    const trimmed = line.trim().toLowerCase();
    expect(trimmed !== 'none' && trimmed !== 'n/a').toBeTruthy();
  }

  // The facts of the scripted history survive verbatim.
  for (const [, value] of facts) {
    expect(summary).toContain(value);
  }

  // The model did not echo its instructions back.
  expect(summary).not.toContain('You are a conversation summariser');
  expect(summary).not.toMatch(/^\s*Rules:/m);
}

// Assertion helpers

/** Escapes a literal for use inside a RegExp. */
function escapeRegExp(text) {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

/**
 * Asserts that the text matches AT LEAST ONE of the patterns. The patterns
 * are alternatives of the same requirement, so the assertion pins the
 * BEHAVIOUR ("the prompt demands exactness") without pinning one wording.
 *
 * @param {string} text - the text to search.
 * @param {RegExp[]} patterns - the alternatives.
 * @param {string} message - the failure message.
 */
function assertMatchesAny(text, patterns, message) {
  const flags = [...new Set(patterns.flatMap((pattern) => [...pattern.flags]))].join('');
  const anyOf = new RegExp(patterns.map((pattern) => `(?:${pattern.source})`).join('|'), flags);
  withContext(message, () => {
    expect(text).toMatch(anyOf);
  });
}

/**
 * The bounds of the clause around a mention: bounded by the nearest
 * sentence boundary (a full stop or a line break) on either side. A
 * prohibition has to live in the SAME clause as the phrase it forbids — a
 * "not" that belongs to a different rule must not excuse it.
 *
 * @param {string} text - the whole text.
 * @param {number} index - the index of the mention.
 * @param {number} length - the length of the mention.
 * @returns {{start: number, end: number}} the clause bounds.
 */
function clauseBounds(text, index, length) {
  let start = index - 1;
  while (start >= 0 && text[start] !== '.' && text[start] !== '\n') {
    start -= 1;
  }
  let end = index + length;
  while (end < text.length && text[end] !== '.' && text[end] !== '\n') {
    end += 1;
  }
  return { start: start + 1, end };
}

/** A negation — the word that turns a clause into a prohibition. */
const NEGATION = /\b(?:never|not|no|nor|without|instead of|rather than|avoid|omit)\b/i;

/**
 * How close the negation has to be to the phrase it forbids.
 *
 * The negation must be in the SAME clause AND immediately before the phrase:
 * "no markdown syntax" forbids markdown, while "Do not summarise briefly;
 * write as much as you can and repeat" does NOT forbid the repeat — the
 * clause heuristic would excuse it if the negation were allowed to be
 * anywhere in the clause.
 *
 * The window is deliberately generous (80 characters). A tight window
 * punished harmless rewording: "Do not paraphrase, shorten, reformat" and
 * "never paraphrase, shorten, reformat" are the same rule, but the second
 * puts the negation further from the word it governs. The clause boundary
 * still does the real work — a mutation that appends its own sentence (the
 * mutation harness) has no negation in its clause at all, so it still fails.
 */
const NEGATION_WINDOW = 80;

/**
 * Asserts that every occurrence of a phrase in the text sits in a
 * PROHIBITING context: the negation has to appear in the same clause, AND
 * before the phrase, AND close to it. A phrase that is merely mentioned in
 * a prohibition is allowed ("no markdown syntax"); a phrase that is DEMANDED
 * is not ("use markdown").
 *
 * @param {string} text - the text to search.
 * @param {RegExp} pattern - the phrase.
 * @param {string} label - what the phrase is, for the failure message.
 */
function assertOnlyProhibited(text, pattern, label) {
  const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  const mentions = [...text.matchAll(global)];
  for (const mention of mentions) {
    withContext(`${label}: "${mention[0]}" is mentioned outside a prohibition`, () => {
      const { start } = clauseBounds(text, mention.index, mention[0].length);
      const before = text.slice(start, mention.index);
      const negation = [...before.matchAll(new RegExp(NEGATION.source, 'gi'))].at(-1);
      expect(negation).toBeTruthy();
      const distance = mention.index - start - (negation.index + negation[0].length);
      expect(distance).toBeLessThanOrEqual(NEGATION_WINDOW);
    });
  }
}

/**
 * Asserts that none of the wordings appears in the text AT ALL.
 *
 * @param {string} text - the text to search.
 * @param {Array<[RegExp, string]>} wordings - the pattern and what it is.
 */
function assertNoneOf(text, wordings) {
  const found = wordings
    .filter(([pattern]) => pattern.test(text))
    .map(([pattern, what]) => `${what} (${pattern})`);
  expect(found).toHaveLength(0);
}

/** The index of the line that starts with `section` followed by a colon. */
function sectionLineIndex(text, section) {
  const match = new RegExp(`^${escapeRegExp(section)}:`, 'm').exec(text);
  return match ? match.index : -1;
}

/** The whole line that starts with `section` followed by a colon. */
function sectionLine(text, section) {
  const index = sectionLineIndex(text, section);
  if (index === -1) {
    return '';
  }
  return text.slice(index).split('\n')[0];
}

/**
 * Wordings that must appear NOWHERE in a summariser prompt, grouped by the
 * defect they would license.
 *
 * They live here — as data — because they have to be run against MORE THAN
 * ONE prompt: the plain one and the focused one. A list inlined inside a
 * single check can only ever police a single text, and the focused prompt is
 * the one a user's own words are spliced into, i.e. exactly the text where a
 * worse instruction could slip in unnoticed.
 */
const FORBIDDEN_GROUPS = {
  'padding or elaborating': [
    [/\belaborat(?:e|es|ed|ing|ion)\b/i, 'an instruction to elaborate'],
    [/\bpad(?:ding|s|ded)?\b/i, 'an instruction to pad'],
    [/as much as you can/i, 'an instruction to write as much as possible'],
    [/as detailed as possible/i, 'an instruction to be as detailed as possible'],
  ],
  'shortening an identifier or an error message': [
    [/may be shortened/i, 'a licence to shorten a name'],
    [/\btruncate[ds]? the\b/i, 'a licence to truncate a name'],
    [/\bfirst \d+ characters\b/i, 'a licence to cut a name to a length'],
  ],
  'material that is not in the history': [
    [/\byou happen to know\b/i, 'an instruction to add background knowledge'],
    [/\bfeel free\b/i, 'an invitation to add material'],
    [/\badd (?:anything|whatever|extra|more)\b/i, 'an instruction to add material'],
    [/\bmake up\b/i, 'an instruction to invent'],
    [/\bfabricat(?:e|es|ed|ing|ion)\b/i, 'an instruction to fabricate'],
    [/\bhallucinat(?:e|es|ed|ing|ion)\b/i, 'an instruction to hallucinate'],
    [/\bplausible\b/i, 'an invitation to make a plausible guess'],
  ],
  'markdown syntax': [
    [/```/, 'a fenced code block'],
    [/\*\*[^\n*]+\*\*/, 'bold markup'],
    [/^[\t ]*#{1,6}[\t ]/m, 'a markdown heading'],
    [/^[\t ]*[*+-][\t ]/m, 'a markdown bullet list'],
  ],
  'a placeholder for an empty section': [
    [/\bplaceholder\b/i, 'an instruction to write a placeholder'],
    [/\bTBD\b/, 'an instruction to write a placeholder'],
    [/\bTODO\b/, 'an instruction to write a placeholder'],
  ],
};

/**
 * Phrases that may appear ONLY inside a clause that forbids them.
 *
 * Same reasoning as {@link FORBIDDEN_GROUPS}: one list, run against every
 * prompt under test.
 */
const ONLY_PROHIBITED_PHRASES = [
  [/\brepeat(?:s|ed|ing)?\b/i, 'repeat'],
  [/\bshorten(?:s|ed|ing)?\b/i, 'shorten'],
  [/\bbackground knowledge\b/i, 'background knowledge'],
  [/\binvent(?:s|ed|ing)?\b/i, 'invent'],
  [/\bparaphras(?:e|es|ed|ing)\b/i, 'paraphrase'],
  [/\bmarkdown\b/i, 'markdown'],
  [/\bbullets?\b/i, 'bullets'],
  [/\bbold\b/i, 'bold'],
  [/\bcode fences?\b/i, 'code fences'],
  [/\bheadings?\b/i, 'headings'],
  [/\bnone\b|\bn\/a\b/i, 'None/N/A'],
  [/\bthird person/i, 'third person'],
  [/\bnarrative/i, 'narrative'],
];

describe('the section contract', () => {
  test('the section list is exactly the six sections, in order', () => {
    expect([...SUMMARY_SECTIONS]).toStrictEqual(EXPECTED_SECTIONS);
  });

  test.each(EXPECTED_SECTIONS)(
    'the prompt names every section at the start of a line, followed by a colon (%p)',
    (section) => {
      const index = sectionLineIndex(PROMPT, section);
      expect(index).not.toBe(-1);
      const line = sectionLine(PROMPT, section);
      expect(line.length).toBeGreaterThan(section.length + 1);
    }
  );

  test('the prompt lists the six sections in the required order', () => {
    let previous = -1;
    for (const section of EXPECTED_SECTIONS) {
      const index = sectionLineIndex(PROMPT, section);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  });

  test('every section says what belongs in it', () => {
    // One list of alternatives per section: the prompt has to state the PURPOSE
    // of a section, not only its name.
    const purposes = {
      Goal: [[/achieve/i], [/ultimate|trying to|goal/i]],
      Changes: [[/file/i], [/symbol|changed/i]],
      Decisions: [[/decided|decision/i], [/\bwhy\b|reason/i], [/reject|option|alternative/i]],
      Constraints: [[/requirement/i], [/version/i], [/convention/i]],
      'Open work': [[/unfinished|not finished|remaining|still to/i], [/next step/i]],
      'Key data': [[/command/i], [/error/i], [/not be lost|must not be lost|lose/i]],
    };
    for (const section of EXPECTED_SECTIONS) {
      const line = sectionLine(PROMPT, section);
      expect(line).not.toBe('');
      for (const alternatives of purposes[section]) {
        assertMatchesAny(
          line,
          alternatives,
          `the "${section}" section does not say what belongs in it: ${JSON.stringify(line)}`
        );
      }
    }
  });
});

describe('exactness', () => {
  test('the prompt demands that names are copied exactly, character for character', () => {
    assertMatchesAny(
      PROMPT,
      [/character[ -]for[ -]character/i],
      'the prompt does not demand character-for-character copying'
    );
    assertMatchesAny(PROMPT, [/\bexactly\b/i], 'the prompt does not say "exactly"');
  });

  test('the prompt names the kinds of things that must be copied exactly', () => {
    assertMatchesAny(PROMPT, [/file path/i], 'the prompt does not mention file paths');
    assertMatchesAny(
      PROMPT,
      [/function name|type name|symbol|identifier/i],
      'the prompt does not mention symbol names'
    );
    assertMatchesAny(PROMPT, [/\bcommand\b/i], 'the prompt does not mention commands');
    assertMatchesAny(PROMPT, [/\bflag\b/i], 'the prompt does not mention flags');
    assertMatchesAny(PROMPT, [/error message/i], 'the prompt does not mention error messages');
  });

  test('the prompt says an unreproducible name is flagged instead of guessed', () => {
    assertMatchesAny(PROMPT, [/guess/i], 'the prompt does not forbid guessing');
    assertMatchesAny(
      PROMPT,
      [
        /cannot be reproduced|cannot be copied|can not be reproduced|cannot recall|not sure/i,
        /say so plainly|say so instead|flag it|state that|instead of guessing/i,
      ],
      'the prompt does not say what to do with a name it cannot reproduce'
    );
  });
});

describe('no invention, chronology', () => {
  test('the prompt forbids inventing anything that is not in the history', () => {
    assertMatchesAny(
      PROMPT,
      [/invent/i, /state nothing that is not|nothing that is not in/i, /not in the history/i],
      'the prompt does not forbid invention'
    );
    assertMatchesAny(
      PROMPT,
      [/do not infer|infer intent|do not add|background knowledge/i],
      'the prompt does not forbid inferring or adding background'
    );
  });

  test('the prompt asks for the chronology to be kept inside a section', () => {
    assertMatchesAny(PROMPT, [/chronolog/i], 'the prompt does not mention chronology');
    assertMatchesAny(
      PROMPT,
      [/order in which|order things happened|order of/i],
      'the prompt does not ask for the order of events'
    );
  });
});

describe('empty sections', () => {
  test('the prompt says a section with nothing in it is omitted entirely', () => {
    assertMatchesAny(PROMPT, [/omit/i], 'the prompt does not talk about omitting sections');
    assertMatchesAny(
      PROMPT,
      [/leave it out entirely/i, /omit[^\n.]*entirely/i],
      'the prompt does not say the empty section is left out entirely'
    );
  });

  test('the prompt never tells the model to write None or N/A for an empty section', () => {
    // Word boundaries on purpose: a bare /none/i also matches "Nonetheless",
    // which would make this check fire on innocent prose.
    const mentions = [...PROMPT.matchAll(/\bnone\b|\bn\/a\b/gi)];
    if (mentions.length > 0) {
      assertOnlyProhibited(PROMPT, /\bnone\b|\bn\/a\b/gi, 'None/N/A');
      return;
    }
    // The prompt never names None/N/A — then it has to forbid a placeholder
    // for an empty section some other way.
    assertMatchesAny(
      PROMPT,
      [
        /never write[^\n.]*placeholder/i,
        /do not write[^\n.]*placeholder/i,
        /never write[^\n.]*(empty|blank|nothing)/i,
        /omit[^\n.]*entirely/i,
      ],
      'the prompt neither forbids None/N/A nor a placeholder for an empty section'
    );
  });

  test('the prompt says a short conversation produces a short summary', () => {
    assertMatchesAny(
      PROMPT,
      [/(short conversation|short history|short input)[^.]*short summary/i],
      'the prompt does not say that a short conversation gives a short summary'
    );
  });
});

describe('the input format', () => {
  test('the prompt explains the four block labels the serialiser emits', () => {
    for (const label of ['[USER]', '[ASSISTANT]', '[ASSISTANT -> <tool>]', '[TOOL <tool>]']) {
      expect(PROMPT).toContain(label);
    }
    expect(PROMPT).toContain('[ASSISTANT ->');
    expect(PROMPT).toContain('[TOOL ');
  });

  test('the prompt explains what the tool-call and tool-output blocks carry', () => {
    assertMatchesAny(
      PROMPT,
      [/arguments/i],
      'the prompt does not say the tool-call block carries the arguments'
    );
    assertMatchesAny(
      PROMPT,
      [/output/i],
      'the prompt does not say the tool block carries the output'
    );
  });
});

describe('the prompt tells the truth about the input', () => {
  test('the prompt does not claim that the newer turns are preserved verbatim', () => {
    // The preserved window is distilled too (orchestrate.ts runs
    // `distillToolMessages` over it), so its tool outputs arrive as digests —
    // "verbatim" was never true.
    expect(PROMPT).not.toMatch(/preserved verbatim/i);
    assertMatchesAny(
      PROMPT,
      [/distilled digest/i, /distill/i],
      'the prompt does not say that the large tool outputs arrive as digests'
    );
  });

  test('the prompt calls the preserved-recent count an estimate', () => {
    expect(PROMPT).toMatch(/estimated tokens/i);
  });

  test('the Changes purpose asks for what the history can carry', () => {
    const line = sectionLine(PROMPT, 'Changes');
    expect(line).not.toBe('');
    expect(line).not.toMatch(/with the symbols that changed/i);
    assertMatchesAny(
      line,
      [/path/i, /size/i],
      `the Changes purpose does not say what the history gives: ${JSON.stringify(line)}`
    );
  });

  test('the prompt says a distilled digest can end mid-sentence', () => {
    assertMatchesAny(
      PROMPT,
      [/end mid-sentence/i, /mid-sentence/i],
      'the prompt does not say that a digest can end mid-sentence'
    );
  });

  test('the distiller marks a cut digest instead of stopping mid-sentence', () => {
    const source = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'src',
        'services',
        'compact',
        'distill.ts'
      ),
      'utf8'
    );
    expect(source).toContain('TOOL_DISTILL_TRUNCATION_MARKER');
    expect(source).not.toMatch(/rawDigest\.slice\(0,\s*TOOL_DISTILL_MAX_CHARS\)/);
  });

  test('the run_subagents call is not projected to an empty object', () => {
    const history = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_subagents',
            function: {
              name: 'run_subagents',
              arguments: { agents: [{ id: 'research', prompt: 'look into the log' }] },
            },
          },
        ],
      },
    ];
    const text = serializeHistoryForSummaryText(history);
    expect(text).toContain('[ASSISTANT -> run_subagents]');
    expect(text).not.toContain('[ASSISTANT -> run_subagents]: {}');
    expect(text).toContain('agents');
  });
});

describe('the prompt tells the truth about the scope', () => {
  test('the chunked prompt says it covers one slice of the older turns', () => {
    const chunked = buildCompactSystemPrompt({ ...PROMPT_PARAMS, chunkCount: 5, chunkIndex: 2 });
    assertMatchesAny(chunked, [/slice/i], 'the chunked prompt does not say that it covers a slice');
    expect(chunked).toContain('5');
    expect(chunked).toMatch(/the other slices are summarised separately/i);
  });

  test('the chunked prompt does not claim to be the record of the whole conversation', () => {
    const chunked = buildCompactSystemPrompt({ ...PROMPT_PARAMS, chunkCount: 5, chunkIndex: 2 });
    expect(chunked).not.toMatch(/this summary is the only record of the older turns/i);
    expect(PROMPT).toMatch(/this summary is the only record of the older turns/i);
  });
});

describe('the history is data, not instructions', () => {
  test('the prompt says the history is data, not instructions', () => {
    assertMatchesAny(
      PROMPT,
      [/\bdata\b[^\n.]*\bnot instructions\b/i],
      'the prompt does not say the history is data and not instructions'
    );
    assertMatchesAny(
      PROMPT,
      [/not an instruction/i, /content to summarise/i, /do not follow/i],
      'the prompt does not say that instructions inside the history must not be followed'
    );
  });
});

describe('the budget', () => {
  test('the prompt carries the target token count, the acceptable range and the context window', () => {
    expect(PROMPT).toContain(String(BUDGET.targetSummaryTokens));
    assertMatchesAny(
      PROMPT,
      [
        new RegExp(
          `\\b${BUDGET.minSummaryTokens}\\s*(?:-|–|—|to)\\s*${BUDGET.maxSummaryTokens}\\b`
        ),
      ],
      `the acceptable range (${BUDGET.minSummaryTokens}-${BUDGET.maxSummaryTokens}) is missing`
    );
    expect(PROMPT).toContain(String(NUM_CTX));
    assertMatchesAny(PROMPT, [/\btoken/i], 'the prompt does not talk about tokens');
    assertMatchesAny(PROMPT, [/\brange/i], 'the prompt does not talk about a range');
    assertMatchesAny(
      PROMPT,
      [/context window/i],
      'the prompt does not talk about a context window'
    );
  });

  test('the prompt carries the preserved-recent token count', () => {
    expect(PROMPT).toContain(String(PRESERVED_RECENT_TOKENS));
  });
});

describe('the shape of the output', () => {
  test('the prompt no longer demands a third-person narrative', () => {
    assertOnlyProhibited(PROMPT, /third person/i, 'third person');
    assertOnlyProhibited(PROMPT, /narrative/i, 'narrative');
  });

  test('the prompt no longer forbids headings', () => {
    expect(PROMPT).not.toMatch(/no headings/i);
    expect(PROMPT).not.toMatch(/without headings/i);
  });

  test('the prompt asks for section paragraphs in plain text, without markdown', () => {
    assertMatchesAny(PROMPT, [/\bsection/i], 'the prompt does not ask for sections');
    assertMatchesAny(PROMPT, [/paragraph/i], 'the prompt does not ask for paragraphs');
    assertMatchesAny(PROMPT, [/plain (summary )?text/i], 'the prompt does not ask for plain text');
    assertMatchesAny(PROMPT, [/no markdown/i], 'the prompt does not forbid markdown syntax');
  });
});

describe('the prompt must not license a worse summary', () => {
  test('the prompt never asks the model to repeat, pad or elaborate beyond the history', () => {
    assertNoneOf(PROMPT, FORBIDDEN_GROUPS['padding or elaborating']);
    // "repeat" may appear — but only in a clause that forbids it.
    assertOnlyProhibited(PROMPT, /\brepeat(?:s|ed|ing)?\b/i, 'repeat');
  });

  test('the prompt never licenses shortening an identifier or an error message', () => {
    assertNoneOf(PROMPT, FORBIDDEN_GROUPS['shortening an identifier or an error message']);
    // "shorten" itself may appear — but only in a clause that forbids it.
    assertOnlyProhibited(PROMPT, /\bshorten(?:s|ed|ing)?\b/i, 'shorten');
  });

  test('the prompt never asks for material that is not in the history', () => {
    assertNoneOf(PROMPT, FORBIDDEN_GROUPS['material that is not in the history']);
    // "background knowledge" may appear — but only in a clause that forbids it.
    assertOnlyProhibited(PROMPT, /\bbackground knowledge\b/i, 'background knowledge');
    assertOnlyProhibited(PROMPT, /\binvent(?:s|ed|ing)?\b/i, 'invent');
    assertOnlyProhibited(PROMPT, /\bparaphras(?:e|es|ed|ing)\b/i, 'paraphrase');
  });

  test('the prompt never asks for markdown', () => {
    // The word "markdown" may appear — but only in a clause that forbids it.
    assertOnlyProhibited(PROMPT, /\bmarkdown\b/i, 'markdown');
    assertOnlyProhibited(PROMPT, /\bbullets?\b/i, 'bullets');
    assertOnlyProhibited(PROMPT, /\bbold\b/i, 'bold');
    assertOnlyProhibited(PROMPT, /\bcode fences?\b/i, 'code fences');
    assertOnlyProhibited(PROMPT, /\bheadings?\b/i, 'headings');
    // And no markdown syntax may be shown to the model as an example.
    assertNoneOf(PROMPT, FORBIDDEN_GROUPS['markdown syntax']);
  });

  test('the prompt never asks for a placeholder in an empty section', () => {
    assertNoneOf(PROMPT, FORBIDDEN_GROUPS['a placeholder for an empty section']);
    // "None" and "N/A" may appear — but only in a clause that forbids them.
    assertOnlyProhibited(PROMPT, /\bnone\b|\bn\/a\b/i, 'None/N/A');
  });

  test.each(EXPECTED_SECTIONS)(
    'the section purposes ask for what the history states, not for an inference (%p)',
    (section) => {
      const line = sectionLine(PROMPT, section);
      expect(line).not.toBe('');
      expect(line).not.toMatch(
        /\bultimate\b|\binfer(?:ring|s|red)?\b|\bintent\b|\byou happen to know\b/i
      );
    }
  );
});

describe('the prompt reaches the model', () => {
  promptTest('the summarisation request carries the prompt as its system message', () => {
    const input = buildSummarisationInput(GOLDEN_HISTORY, BUDGET, PRESERVED_RECENT_TOKENS, NUM_CTX);
    expect(input.messages[0].role).toBe('system');
    const system = input.messages.find((message) => message.role === 'system');
    expect(system).toBeTruthy();
    expect(system.content).toBe(PROMPT);
  });

  promptTest('the system message is byte-identical to the exported prompt builder', () => {
    const input = buildSummarisationInput(
      [{ role: 'user', content: 'hello' }],
      BUDGET,
      PRESERVED_RECENT_TOKENS,
      NUM_CTX
    );
    const system = input.messages.find((message) => message.role === 'system');
    expect(system).toBeTruthy();
    expect(system.content).toBe(buildCompactSystemPrompt(PROMPT_PARAMS));
  });

  test('the user message carries the serialised history', () => {
    const input = buildSummarisationInput(GOLDEN_HISTORY, BUDGET, PRESERVED_RECENT_TOKENS, NUM_CTX);
    const user = input.messages.find((message) => message.role === 'user');
    expect(user).toBeTruthy();
    expect(user.content.endsWith(input.historyText)).toBeTruthy();
  });
});

describe('the focus note (/compact <focus>)', () => {
  test('a compaction without a focus note produces a byte-identical prompt', () => {
    // The note is OPTIONAL, and dozens of assertions above pin the focus-free
    // prompt. The no-focus path therefore has to add nothing at all — not a
    // heading, not a blank line. `equal` on the whole string is the only check
    // that can say that.
    expect(buildCompactSystemPrompt({ ...PROMPT_PARAMS, focus: undefined })).toBe(BUILT_PROMPT);
    expect(BUILT_PROMPT).not.toContain(FOCUS_LABEL);
    expect(buildRetrySystemPrompt({ ...RETRY_PARAMS, focus: undefined })).toBe(
      buildRetrySystemPrompt(RETRY_PARAMS)
    );
    expect(buildRetrySystemPrompt(RETRY_PARAMS)).not.toContain('What matters most to the user');
    expect(buildReductionCombineSystemPrompt(undefined)).toBe(REDUCTION_COMBINE_SYSTEM_PROMPT);
    expect(REDUCTION_COMBINE_SYSTEM_PROMPT).not.toContain('The user left a note');
  });

  test('the focus note reaches the full prompt exactly once', () => {
    expect(FOCUSED_PROMPT.split(FOCUS).length - 1).toBe(1);
  });

  test('the focus block sits after the section list and immediately before the rules', () => {
    const focusIndex = FOCUSED_PROMPT.indexOf(FOCUS_LABEL);
    const rulesIndex = FOCUSED_PROMPT.indexOf('Rules:');
    expect(focusIndex).not.toBe(-1);
    expect(rulesIndex).not.toBe(-1);
    expect(focusIndex).toBeLessThan(rulesIndex);
    // After EVERY section line: a block that landed among them could be read as
    // a seventh section of the summary the model is asked to write.
    for (const section of EXPECTED_SECTIONS) {
      const index = sectionLineIndex(FOCUSED_PROMPT, section);
      expect(index).not.toBe(-1);
      expect(index).toBeLessThan(focusIndex);
    }
    // And the block itself carries no section label, for the same reason.
    const block = FOCUSED_PROMPT.slice(focusIndex, rulesIndex);
    for (const section of EXPECTED_SECTIONS) {
      expect(new RegExp(`^${escapeRegExp(section)}:`, 'm').test(block)).toBeFalsy();
    }
  });

  test('the focus block makes the note subordinate to the rules', () => {
    const block = FOCUSED_PROMPT.slice(
      FOCUSED_PROMPT.indexOf(FOCUS_LABEL),
      FOCUSED_PROMPT.indexOf('\n\nRules:')
    );
    expect(block).toMatch(/\bnever\b/i);
    expect(block).toMatch(/\brules\b/i);
    assertMatchesAny(
      block,
      [/not part of the history/i],
      'the focus block does not say the note is not part of the history'
    );
    // The two things the note may never license, both stated in the block: a
    // dropped fact, and a fact the history does not contain.
    assertMatchesAny(
      block,
      [/never licences leaving out|never licenses leaving out/i],
      'the focus block does not forbid dropping a fact the history states'
    );
    assertMatchesAny(
      block,
      [/never licences stating|never licenses stating/i],
      'the focus block does not forbid stating a fact the history does not contain'
    );
    assertMatchesAny(
      block,
      [/write nothing about it/i],
      'the focus block does not say what to do with a subject the history never mentions'
    );
  });

  test('the focus label is not shaped like a section', () => {
    // A seventh section is the failure mode: the prompt's own opening sentence
    // tells the model that the summary is made of sections, each starting with
    // the section name followed by a colon, and the focus paragraph sits one
    // blank line below that list. A label of the same `Name: purpose` shape is
    // therefore something the model can copy into the summary — and whatever
    // reaches the summary is persisted as history.
    const firstLine = FOCUSED_PROMPT.slice(FOCUSED_PROMPT.indexOf(FOCUS_LABEL)).split('\n')[0];
    expect(firstLine).toBeTruthy();
    expect(firstLine.startsWith(FOCUS_LABEL)).toBeTruthy();
    expect(firstLine).not.toMatch(SECTION_SHAPED_HEAD);
    // …and it names no section, at the start or after the label.
    for (const section of EXPECTED_SECTIONS) {
      expect(new RegExp(`(^|[^A-Za-z])${escapeRegExp(section)}:`, 'm').test(firstLine)).toBeFalsy();
    }
    // NON-VACUOUS: the shape test does catch the label it replaced. Without this
    // the regex could be so loose that any wording passes.
    expect(
      'WHAT MATTERS MOST (a note from the user about this compaction, not part of the history): keep the tests'
    ).toMatch(SECTION_SHAPED_HEAD);
  });

  test('the short retry prompt carries the focus note as its own rule', () => {
    const retry = buildRetrySystemPrompt({ ...RETRY_PARAMS, focus: FOCUS });
    expect(retry.split(FOCUS).length - 1).toBe(1);
    const focusIndex = retry.indexOf(FOCUS);
    expect(focusIndex).toBeLessThan(retry.indexOf('Return ONLY'));
    expect(retry.slice(retry.lastIndexOf('\n', focusIndex) + 1)).toMatch(/^\s*6\.\s/);
    assertMatchesAny(
      retry.slice(focusIndex),
      [/never relax rules 1-4/i],
      'the retry does not make the note subordinate to rules 1-4'
    );
  });

  test('the combine prompt carries the focus note, or a chunked compaction dilutes it', () => {
    const combine = buildReductionCombineSystemPrompt(FOCUS);
    expect(combine.split(FOCUS).length - 1).toBe(1);
    const focusIndex = combine.indexOf(FOCUS);
    expect(focusIndex).toBeLessThan(combine.indexOf('Return ONLY'));
    assertMatchesAny(
      combine.slice(focusIndex),
      [/never relax the rules above/i],
      'the combine prompt does not make the note subordinate to the rules above'
    );
    // The merge contract survives the addition: the six sections stay named, in
    // order, and the retention demand is still there.
    let previous = -1;
    for (const section of EXPECTED_SECTIONS) {
      const index = combine.indexOf(section);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    assertMatchesAny(
      combine,
      [/keep every decision/i],
      'the focused combine prompt lost the retention demand'
    );
  });

  test('the focused prompt forbids everything the plain one forbids', () => {
    // The note is spliced into the prompt, so the focused prompt is where a
    // worse instruction could hide: a user note that says "be as detailed as
    // possible" must not become a licence the plain prompt's absence checks
    // never look at.
    for (const [label, wordings] of Object.entries(FORBIDDEN_GROUPS)) {
      withContext(`the focused prompt and the "${label}" wordings`, () => {
        assertNoneOf(FOCUSED_PROMPT, wordings);
        expect(wordings.length).toBeGreaterThan(0);
      });
    }
    for (const [pattern, label] of ONLY_PROHIBITED_PHRASES) {
      assertOnlyProhibited(FOCUSED_PROMPT, pattern, label);
    }
  });

  test('the focused prompt keeps the sections, the exactness rule and the injection guard', () => {
    for (const section of EXPECTED_SECTIONS) {
      expect(FOCUSED_PROMPT).toContain(`${section}:`);
    }
    expect(FOCUSED_PROMPT).toMatch(/character for character/i);
    assertMatchesAny(
      FOCUSED_PROMPT,
      [/\bdata\b[^\n.]*\bnot instructions\b/i],
      'the focused prompt lost the injection guard'
    );
  });
});

describe('the map-reduce combine prompt', () => {
  test('the reduction prompt keeps the six sections, in order', () => {
    let previous = -1;
    for (const section of EXPECTED_SECTIONS) {
      const index = REDUCTION_COMBINE_SYSTEM_PROMPT.indexOf(section);
      expect(index).not.toBe(-1);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  });

  test('the reduction prompt names the six sections as one ordered list', () => {
    expect(REDUCTION_COMBINE_SYSTEM_PROMPT).toContain(EXPECTED_SECTIONS.join(', '));
  });

  test('the reduction prompt keeps names exact', () => {
    assertMatchesAny(
      REDUCTION_COMBINE_SYSTEM_PROMPT,
      [/character[ -]for[ -]character/i],
      'the reduction prompt does not demand character-for-character copying'
    );
    assertMatchesAny(
      REDUCTION_COMBINE_SYSTEM_PROMPT,
      [/\bexactly\b/i],
      'the reduction prompt does not say "exactly"'
    );
    assertMatchesAny(
      REDUCTION_COMBINE_SYSTEM_PROMPT,
      [/file path/i],
      'the reduction prompt does not mention file paths'
    );
  });

  test('the reduction prompt demands that the merge keeps every fact', () => {
    // The reduction is lossy at every level: with many partials the final
    // summary is several lossy levels deep, so the combine prompt has to
    // demand the retention explicitly.
    assertMatchesAny(
      REDUCTION_COMBINE_SYSTEM_PROMPT,
      [/keep every decision/i],
      'the reduction prompt does not demand that every decision is kept'
    );
    assertMatchesAny(
      REDUCTION_COMBINE_SYSTEM_PROMPT,
      [/unresolved task/i],
      'the reduction prompt does not mention the unresolved tasks'
    );
  });

  test('the reduction prompt does not forbid headings', () => {
    expect(REDUCTION_COMBINE_SYSTEM_PROMPT).not.toMatch(/no headings/i);
  });

  test('the reduction prompt does not flatten the parts into a narrative', () => {
    assertOnlyProhibited(REDUCTION_COMBINE_SYSTEM_PROMPT, /narrative/i, 'narrative');
    assertOnlyProhibited(REDUCTION_COMBINE_SYSTEM_PROMPT, /third person/i, 'third person');
    assertMatchesAny(
      REDUCTION_COMBINE_SYSTEM_PROMPT,
      [/section by section|keeps? the structure|keep the section/i],
      'the reduction prompt does not say the section structure is kept'
    );
    assertMatchesAny(
      REDUCTION_COMBINE_SYSTEM_PROMPT,
      [/\bsection/i],
      'the reduction prompt does not talk about sections'
    );
  });

  test('the reduction prompt still asks for plain text without markdown', () => {
    assertMatchesAny(
      REDUCTION_COMBINE_SYSTEM_PROMPT,
      [/plain (summary )?text/i],
      'the reduction prompt does not ask for plain text'
    );
    assertMatchesAny(
      REDUCTION_COMBINE_SYSTEM_PROMPT,
      [/no markdown/i],
      'the reduction prompt does not forbid markdown syntax'
    );
  });

  test('the reduction prompt does not license a worse merge', () => {
    assertNoneOf(REDUCTION_COMBINE_SYSTEM_PROMPT, [
      [/may be shortened\b/i, 'a licence to shorten a name'],
      [/\byou happen to know\b/i, 'an instruction to add background knowledge'],
      [/\btruncate[ds]? the\b/i, 'a licence to truncate a name'],
    ]);
    assertOnlyProhibited(REDUCTION_COMBINE_SYSTEM_PROMPT, /\brepeat(?:s|ed|ing)?\b/i, 'repeat');
    assertOnlyProhibited(REDUCTION_COMBINE_SYSTEM_PROMPT, /\bmarkdown\b/i, 'markdown');
    assertOnlyProhibited(REDUCTION_COMBINE_SYSTEM_PROMPT, /\bnone\b|\bn\/a\b/i, 'None/N/A');
    assertOnlyProhibited(REDUCTION_COMBINE_SYSTEM_PROMPT, /\bshorten(?:s|ed|ing)?\b/i, 'shorten');
  });
});

describe('the golden transcript', () => {
  test('the scripted history keeps the file path, the command and the error message', () => {
    const input = buildSummarisationInput(GOLDEN_HISTORY, BUDGET, PRESERVED_RECENT_TOKENS, NUM_CTX);
    const facts = [
      ['file path', GOLDEN_PATH],
      ['command', GOLDEN_COMMAND],
      ['error message', GOLDEN_ERROR],
    ];
    for (const [, value] of facts) {
      expect(input.historyText).toContain(value);
    }
  });

  test('the scripted history reaches the request as labelled blocks', () => {
    const input = buildSummarisationInput(GOLDEN_HISTORY, BUDGET, PRESERVED_RECENT_TOKENS, NUM_CTX);
    const user = input.messages.find((message) => message.role === 'user');
    expect(user).toBeTruthy();
    expect(user.content).toContain('[ASSISTANT -> write_file]');
    expect(user.content).toContain('[ASSISTANT -> run_command]');
    expect(user.content).toContain('[TOOL run_command]');
  });

  test('the prompt asks for exactly those three kinds of thing to be retained', () => {
    assertMatchesAny(PROMPT, [/file path/i], 'the prompt does not ask for file paths');
    assertMatchesAny(PROMPT, [/\bcommand\b/i], 'the prompt does not ask for commands');
    assertMatchesAny(PROMPT, [/error message/i], 'the prompt does not ask for error messages');
    assertMatchesAny(
      PROMPT,
      [/character[ -]for[ -]character/i],
      'the prompt does not tie the three kinds of thing to exact copying'
    );
  });
});

/**
 * The live check.
 *
 * Opt-in: it runs only when LOCOPILOT_TEST_LIVE_COMPACTION=1, and it spends
 * quota on the provider configured in the repo's own config.json. A
 * provider/network failure says nothing about this repository, so it is
 * reported as a SKIP with the reason (Jest cannot skip from inside a running
 * test, so the tests warn and return) — while a summary that loses a fact is a
 * FAILURE.
 */
const LIVE = process.env['LOCOPILOT_TEST_LIVE_COMPACTION'] === '1';

(LIVE ? describe : describe.skip)(
  'live summarisation (set LOCOPILOT_TEST_LIVE_COMPACTION=1; it spends quota on the configured provider)',
  () => {
    const facts = [
      ['file path', GOLDEN_PATH],
      ['command', GOLDEN_COMMAND],
      ['error message', GOLDEN_ERROR],
    ];

    let summary = '';
    /** Why the provider could not be used, or '' when it could. */
    let unavailable = '';

    /** Wraps a test body so that it is skipped (with the reason) when there is no summary. */
    const whenAvailable = (body) => () => {
      if (unavailable) {
        console.warn(`SKIP live summarisation: ${unavailable}`);
        return;
      }
      body();
    };

    beforeAll(async () => {
      const writeFixture = process.env['LOCOPILOT_TEST_LIVE_WRITE_FIXTURE'] ?? '';

      let provider;
      let model;
      let numCtx;
      try {
        const config = await loadConfig();
        const requestedProviderId =
          process.env['LOCOPILOT_TEST_LIVE_PROVIDER_ID'] || config?.activeProviderId || undefined;
        const modelName =
          process.env['LOCOPILOT_TEST_LIVE_MODEL'] || config?.compactionModel || config?.model;
        provider = resolveProvider(config, requestedProviderId, modelName);
        if (!provider) {
          provider = resolveProvider(config, undefined, modelName);
        }
        if (!provider || !provider.baseUrl) {
          unavailable = 'no usable provider in config.json';
          return;
        }
        model =
          process.env['LOCOPILOT_TEST_LIVE_MODEL'] || provider.model || config?.model || undefined;
        if (!model) {
          unavailable = 'no model configured';
          return;
        }

        // The configured num_ctx can be far larger than the model accepts (this
        // repo's own config.json asks for 13107200), and a provider that rejects
        // it would fail the suite for a reason that has nothing to do with the
        // prompt. The live check therefore asks for at most 8192 tokens.
        // This live script's own fallback, not a server default.
        numCtx = Math.min(provider.numCtx ?? config?.numCtx ?? 131_072, LIVE_MAX_NUM_CTX);
        console.info(
          `live run: provider=${provider.id} model=${model} numCtx=${numCtx} (clamped to ${LIVE_MAX_NUM_CTX})`
        );

        summary = await summariseChunk({
          ctx: buildProviderRequestContext(provider, 'compact-prompt-live-test'),
          model,
          numCtx,
          historyMessages: GOLDEN_HISTORY,
          budget: { targetSummaryTokens: 400, minSummaryTokens: 200, maxSummaryTokens: 600 },
          preservedRecentTokens: 0,
          toolNames: buildToolNameMap(GOLDEN_HISTORY),
        });
      } catch (err) {
        unavailable = `the provider call failed (${err instanceof Error ? err.message : String(err)})`;
        return;
      }

      if (writeFixture) {
        const target = writeFixture === '1' ? FIXTURE_PATH : path.resolve(writeFixture);
        const header = [
          FIXTURE_HEADER_START,
          `Produced on: ${new Date().toISOString()} (UTC)`,
          'Produced by: LOCOPILOT_TEST_LIVE_COMPACTION=1 LOCOPILOT_TEST_LIVE_WRITE_FIXTURE=1 npm test -- tests/compact-prompt',
          `Provider: ${provider.id} (${provider.provider}) — ${provider.baseUrl}`,
          `Model: ${model}`,
          `Context window used: ${numCtx} (clamped to ${LIVE_MAX_NUM_CTX} by the live check)`,
          'Scripted history: the GOLDEN_HISTORY array of tests/compact-prompt.test.mjs — a user turn about a crashing status bar, an assistant turn, a write_file call for src/services/compact/statusBar.tsx, a run_command call for npm run test:compact-prompt and the tool output carrying the TypeError.',
          'Note: the summary below is the model output verbatim; nothing was edited by hand.',
          FIXTURE_HEADER_END,
        ].join('\n');
        fs.writeFileSync(target, `${header}\n${summary}\n`, 'utf8');
        console.info(`fixture written to ${target}`);
      }
    }, 120_000);

    test(
      'the live summary keeps the file path, the command and the error message',
      whenAvailable(() => {
        for (const [, value] of facts) {
          expect(summary).toContain(value);
        }
      })
    );

    test(
      'the live summary has the shape the prompt demands',
      whenAvailable(() => {
        assertSummaryShape(summary, facts);
      })
    );
  }
);

describe('the shape the model actually produces (fixture)', () => {
  test('a legitimate "Error:" or "Note:" line is not a section label', () => {
    // The shape check must only reject a line that opens one of the SIX
    // sections. A summary that reports an error may well contain a line that
    // starts with "Error:" — that is content, not a section.
    const summary = [
      'Goal: fix the crash',
      '',
      'Key data: npm test failed.',
      "Error: TypeError: Cannot read properties of undefined (reading 'render')",
      'Note: the build was skipped',
    ].join('\n');
    assertSummaryShape(summary, []);
    const labels = summary
      .split(/\r?\n/)
      .map((line) => SECTION_LABEL_LINE.exec(line)?.[1])
      .filter((label) => label !== undefined);
    expect(labels).toStrictEqual(['Goal', 'Key data']);
  });

  const FIXTURE_RAW = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const FIXTURE = splitFixture(FIXTURE_RAW);

  test('the fixture records how it was produced', () => {
    expect(FIXTURE.header).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(FIXTURE.header).toMatch(/model/i);
    expect(FIXTURE.header).toMatch(/compact-prompt\.test\.mjs/);
  });

  test('the fixture header carries no credential', () => {
    expect(FIXTURE.header).not.toMatch(/api[_-]?key|authorization|bearer/i);
    expect(FIXTURE.header).not.toMatch(/\bsk-[\dA-Za-z]{8,}/);
    expect(FIXTURE.header).not.toMatch(/\b[\da-f]{32,}\b/i);
  });

  test('the fixture summary has the shape the prompt demands', () => {
    assertSummaryShape(FIXTURE.body, [
      ['file path', GOLDEN_PATH],
      ['command', GOLDEN_COMMAND],
      ['error message', GOLDEN_ERROR],
    ]);
  });

  test('the fixture summary keeps only sections of the six, in order', () => {
    const labels = FIXTURE.body
      .split(/\r?\n/)
      .map((line) => SECTION_LABEL_LINE.exec(line)?.[1])
      .filter((label) => label !== undefined);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(EXPECTED_SECTIONS).toContain(label);
    }
    const indexes = labels.map((label) => EXPECTED_SECTIONS.indexOf(label));
    expect(indexes).toStrictEqual([...indexes].sort((left, right) => left - right));
  });

  test('the fixture summary has no markdown heading and no block label', () => {
    for (const line of FIXTURE.body.split(/\r?\n/)) {
      expect(line).not.toMatch(/^\s*#{1,6}\s/);
      expect(BLOCK_LABEL_LINE.test(line)).toBeFalsy();
    }
  });

  test('the fixture summary has no "None" or "N/A" placeholder line', () => {
    for (const line of FIXTURE.body.split(/\r?\n/)) {
      const trimmed = line.trim().toLowerCase();
      expect(trimmed !== 'none' && trimmed !== 'n/a').toBeTruthy();
    }
  });

  test.each([
    ['file path', GOLDEN_PATH],
    ['command', GOLDEN_COMMAND],
    ['error message', GOLDEN_ERROR],
  ])(
    'the fixture summary keeps the file path, the command and the error message',
    (label, value) => {
      expect(FIXTURE.body).toContain(value);
    }
  );
});

describe('The empty-response retry must ask for the same shape', () => {
  test('the empty-response retry asks for the same six sections', () => {
    const retry = buildRetrySystemPrompt(RETRY_PARAMS);
    for (const section of SUMMARY_SECTIONS) {
      expect(retry).toContain(`${section}:`);
    }
    expect(retry).toMatch(/character for character/i);
    expect(retry).toMatch(/omit/i);
    expect(retry).not.toMatch(/third person|narrative/i);
  });

  test('the retry carries the injection guard and a token target', () => {
    const retry = buildRetrySystemPrompt(RETRY_PARAMS);
    assertMatchesAny(
      retry,
      [/\bdata\b[^\n.]*\bnot instructions\b/i],
      'the retry does not say the text is data and not instructions'
    );
    expect(retry).toContain(String(BUDGET.targetSummaryTokens));
    expect(retry).toContain(String(NUM_CTX));
  });
});
