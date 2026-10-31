#!/usr/bin/env node
/**
 * Tests for the compaction summariser's STRUCTURED prompt.
 *
 * Run with: npx tsx scripts/test-compact-prompt.mjs
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
 *      `scripts/fixtures/compact-summary.txt` holds a summary the model
 *      really wrote, and the suite asserts its shape offline.
 *
 * OFFLINE BY DEFAULT. The LAST check is a live model call; it is SKIPPED
 * unless LOCOPILOT_TEST_LIVE_COMPACTION=1 is set, and a skip is reported
 * SEPARATELY from a pass — the headline prints "N passed, M skipped, K
 * failed", so a skipped check is never counted as a passed one.
 *
 *   LOCOPILOT_TEST_LIVE_COMPACTION=1 npx tsx scripts/test-compact-prompt.mjs
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
 *     npx tsx scripts/test-compact-prompt.mjs
 *
 * MUTATION HARNESS (development aid, off by default). Setting
 * LOCOPILOT_TEST_PROMPT_MUTATION=<name> applies a KNOWN-WORSE prompt on
 * purpose and the suite is then expected to FAIL — that is how the absence
 * checks are proven to bite:
 *
 *   LOCOPILOT_TEST_PROMPT_MUTATION=repeat npx tsx scripts/test-compact-prompt.mjs
 *
 * Optional overrides: LOCOPILOT_TEST_LIVE_PROVIDER_ID, LOCOPILOT_TEST_LIVE_MODEL.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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
import {
  buildProviderRequestContext,
  getProviderNumCtx,
  resolveProvider,
} from '../src/services/providerResolver.ts';

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

// ---- The golden transcript: one file path, one command, one error message ----

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

// ---- The prompt under test ----

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
 * Applies a named mutation to the prompt.
 *
 * @param {string} prompt - the prompt as the source builds it.
 * @param {string} name - the name of the mutation.
 * @returns {string} the mutated prompt.
 */
function applyMutation(prompt, name) {
  if (!Object.hasOwn(MUTATIONS, name)) {
    console.error(
      `  FAIL  unknown mutation "${name}" — known: ${Object.keys(MUTATIONS).join(', ')}`
    );
    process.exit(1);
  }
  console.log(`  NOTE  mutation "${name}" applied — the suite is EXPECTED to fail`);
  return MUTATIONS[name](prompt);
}

// ---- The fixture: a summary the model really produced ----

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
  assert.notEqual(start, -1, `the fixture has no "${FIXTURE_HEADER_START}" marker`);
  assert.ok(end > start, `the fixture has no "${FIXTURE_HEADER_END}" marker`);
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

  assert.ok(summary.trim().length > 0, 'the summary is empty');

  // The section labels that are present are a subset of the six, in order.
  let previous = -1;
  const seen = [];
  for (const line of lines) {
    const match = SECTION_LABEL_LINE.exec(line);
    if (!match) continue;
    const label = match[1];
    const index = EXPECTED_SECTIONS.indexOf(label);
    assert.notEqual(
      index,
      -1,
      `the summary has a "${label}:" line that is not one of the six sections`
    );
    assert.ok(index > previous, `the "${label}" section is out of order`);
    previous = index;
    seen.push(label);
  }
  assert.ok(seen.length > 0, 'the summary has no section label at all');

  // No markdown heading, no serialiser block label, no placeholder.
  for (const line of lines) {
    assert.ok(
      !/^\s*#{1,6}\s/.test(line),
      `the summary has a markdown heading: ${JSON.stringify(line)}`
    );
    assert.ok(
      !BLOCK_LABEL_LINE.test(line),
      `the summary has a serialiser block label: ${JSON.stringify(line)}`
    );
    const trimmed = line.trim().toLowerCase();
    assert.ok(
      trimmed !== 'none' && trimmed !== 'n/a',
      `the summary has a "None"/"N/A" placeholder: ${JSON.stringify(line)}`
    );
  }

  // The facts of the scripted history survive verbatim.
  for (const [label, value] of facts) {
    assert.ok(summary.includes(value), `the summary lost the ${label} "${value}"`);
  }

  // The model did not echo its instructions back.
  assert.ok(
    !summary.includes('You are a conversation summariser'),
    'the summary echoes the system prompt'
  );
  assert.ok(!/^\s*Rules:/m.test(summary), 'the summary echoes the rules of the prompt');
}

// ---- Counters ----

let passed = 0;
let failed = 0;
let skipped = 0;

/**
 * Runs one check and records the result.
 *
 * @param {string} label - what the check asserts.
 * @param {() => void} fn - the check.
 */
function check(label, fn) {
  if (MUTATION && MUTATION_EXEMPT_LABELS.has(label)) {
    skip(label, 'the prompt was mutated on purpose, so the unmutated builder cannot be compared');
    return;
  }
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
}

/**
 * Records a skipped check. A skip is NOT a pass: it is counted separately
 * and printed separately, so the headline cannot overstate the coverage.
 *
 * @param {string} label - what was skipped.
 * @param {string} reason - why it was skipped.
 */
function skip(label, reason) {
  console.log(`  SKIP  ${label} — ${reason}`);
  skipped += 1;
}

// ---- Assertion helpers ----

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
  const matched = patterns.some((pattern) => pattern.test(text));
  assert.ok(matched, `${message} — none of ${patterns.map(String).join(' / ')} matched`);
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

/**
 * The clause around a mention.
 *
 * @param {string} text - the whole text.
 * @param {number} index - the index of the mention.
 * @param {number} length - the length of the mention.
 * @returns {string} the clause.
 */
function clauseAround(text, index, length) {
  const { start, end } = clauseBounds(text, index, length);
  return text.slice(start, end);
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
    const { start } = clauseBounds(text, mention.index, mention[0].length);
    const before = text.slice(start, mention.index);
    const negation = [...before.matchAll(new RegExp(NEGATION.source, 'gi'))].at(-1);
    assert.ok(
      negation,
      `the ${label} "${mention[0]}" is demanded rather than forbidden — text before it: ${JSON.stringify(before)} (clause: ${JSON.stringify(clauseAround(text, mention.index, mention[0].length))})`
    );
    const distance = mention.index - start - (negation.index + negation[0].length);
    assert.ok(
      distance <= NEGATION_WINDOW,
      `the ${label} "${mention[0]}" is only forbidden by a negation ${distance} characters earlier — the negation does not reach it (clause: ${JSON.stringify(clauseAround(text, mention.index, mention[0].length))})`
    );
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
  assert.ok(found.length === 0, `the prompt contains forbidden wording: ${found.join('; ')}`);
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

console.log('the section contract');

check('the section list is exactly the six sections, in order', () => {
  assert.deepEqual([...SUMMARY_SECTIONS], EXPECTED_SECTIONS);
});

check('the prompt names every section at the start of a line, followed by a colon', () => {
  for (const section of EXPECTED_SECTIONS) {
    const index = sectionLineIndex(PROMPT, section);
    assert.ok(index !== -1, `the prompt has no "${section}:" line`);
    const line = sectionLine(PROMPT, section);
    assert.ok(
      line.length > section.length + 1,
      `the "${section}:" line says nothing about what belongs in the section`
    );
  }
});

check('the prompt lists the six sections in the required order', () => {
  let previous = -1;
  for (const section of EXPECTED_SECTIONS) {
    const index = sectionLineIndex(PROMPT, section);
    assert.ok(index > previous, `the "${section}" section is missing or out of order`);
    previous = index;
  }
});

check('every section says what belongs in it', () => {
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
    assert.ok(line !== '', `the prompt has no "${section}:" line`);
    for (const alternatives of purposes[section]) {
      assertMatchesAny(
        line,
        alternatives,
        `the "${section}" section does not say what belongs in it: ${JSON.stringify(line)}`
      );
    }
  }
});

console.log('exactness');

check('the prompt demands that names are copied exactly, character for character', () => {
  assertMatchesAny(
    PROMPT,
    [/character[ -]for[ -]character/i],
    'the prompt does not demand character-for-character copying'
  );
  assertMatchesAny(PROMPT, [/\bexactly\b/i], 'the prompt does not say "exactly"');
});

check('the prompt names the kinds of things that must be copied exactly', () => {
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

check('the prompt says an unreproducible name is flagged instead of guessed', () => {
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

console.log('no invention, chronology');

check('the prompt forbids inventing anything that is not in the history', () => {
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

check('the prompt asks for the chronology to be kept inside a section', () => {
  assertMatchesAny(PROMPT, [/chronolog/i], 'the prompt does not mention chronology');
  assertMatchesAny(
    PROMPT,
    [/order in which|order things happened|order of/i],
    'the prompt does not ask for the order of events'
  );
});

console.log('empty sections');

check('the prompt says a section with nothing in it is omitted entirely', () => {
  assertMatchesAny(PROMPT, [/omit/i], 'the prompt does not talk about omitting sections');
  assertMatchesAny(
    PROMPT,
    [/leave it out entirely/i, /omit[^\n.]*entirely/i],
    'the prompt does not say the empty section is left out entirely'
  );
});

check('the prompt never tells the model to write None or N/A for an empty section', () => {
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

check('the prompt says a short conversation produces a short summary', () => {
  assertMatchesAny(
    PROMPT,
    [/(short conversation|short history|short input)[^.]*short summary/i],
    'the prompt does not say that a short conversation gives a short summary'
  );
});

console.log('the input format');

check('the prompt explains the four block labels the serialiser emits', () => {
  for (const label of ['[USER]', '[ASSISTANT]', '[ASSISTANT -> <tool>]', '[TOOL <tool>]']) {
    assert.ok(PROMPT.includes(label), `the prompt does not describe the ${label} block`);
  }
  assert.ok(PROMPT.includes('[ASSISTANT ->'), 'the prompt does not mention "[ASSISTANT ->"');
  assert.ok(PROMPT.includes('[TOOL '), 'the prompt does not mention "[TOOL "');
});

check('the prompt explains what the tool-call and tool-output blocks carry', () => {
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

console.log('the prompt tells the truth about the input');

check('the prompt does not claim that the newer turns are preserved verbatim', () => {
  // The preserved window is distilled too (orchestrate.ts runs
  // `distillToolMessages` over it), so its tool outputs arrive as digests —
  // "verbatim" was never true.
  assert.ok(
    !/preserved verbatim/i.test(PROMPT),
    'the prompt still claims that the newer turns are preserved verbatim'
  );
  assertMatchesAny(
    PROMPT,
    [/distilled digest/i, /distill/i],
    'the prompt does not say that the large tool outputs arrive as digests'
  );
});

check('the prompt calls the preserved-recent count an estimate', () => {
  assert.ok(
    /estimated tokens/i.test(PROMPT),
    'the prompt does not call the preserved-recent count an estimate'
  );
});

check('the Changes purpose asks for what the history can carry', () => {
  const line = sectionLine(PROMPT, 'Changes');
  assert.ok(line !== '', 'the prompt has no "Changes:" line');
  assert.doesNotMatch(
    line,
    /with the symbols that changed/i,
    `the Changes purpose still demands the changed symbols: ${JSON.stringify(line)}`
  );
  assertMatchesAny(
    line,
    [/path/i, /size/i],
    `the Changes purpose does not say what the history gives: ${JSON.stringify(line)}`
  );
});

check('the prompt says a distilled digest can end mid-sentence', () => {
  assertMatchesAny(
    PROMPT,
    [/end mid-sentence/i, /mid-sentence/i],
    'the prompt does not say that a digest can end mid-sentence'
  );
});

check('the distiller marks a cut digest instead of stopping mid-sentence', () => {
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
  assert.ok(
    source.includes('TOOL_DISTILL_TRUNCATION_MARKER'),
    'distill.ts does not mark a cut digest'
  );
  assert.ok(
    !/rawDigest\.slice\(0,\s*TOOL_DISTILL_MAX_CHARS\)/.test(source),
    'distill.ts still slices the digest without a marker'
  );
});

check('the run_subagents call is not projected to an empty object', () => {
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
  assert.ok(text.includes('[ASSISTANT -> run_subagents]'), `the call is missing: ${text}`);
  assert.ok(
    !text.includes('[ASSISTANT -> run_subagents]: {}'),
    `the call projects to an empty object: ${text}`
  );
  assert.ok(text.includes('agents'), `the projection does not carry the agents: ${text}`);
});

console.log('the prompt tells the truth about the scope');

check('the chunked prompt says it covers one slice of the older turns', () => {
  const chunked = buildCompactSystemPrompt({ ...PROMPT_PARAMS, chunkCount: 5, chunkIndex: 2 });
  assertMatchesAny(chunked, [/slice/i], 'the chunked prompt does not say that it covers a slice');
  assert.ok(chunked.includes('5'), 'the chunked prompt does not name the number of slices');
  assert.ok(
    /the other slices are summarised separately/i.test(chunked),
    'the chunked prompt does not say that the other slices are summarised separately'
  );
});

check('the chunked prompt does not claim to be the record of the whole conversation', () => {
  const chunked = buildCompactSystemPrompt({ ...PROMPT_PARAMS, chunkCount: 5, chunkIndex: 2 });
  assert.ok(
    !/this summary is the only record of the older turns/i.test(chunked),
    'the chunked prompt still claims to be the only record of the older turns'
  );
  assert.ok(
    /this summary is the only record of the older turns/i.test(PROMPT),
    'the single-pass prompt lost the only-record claim'
  );
});

console.log('the history is data, not instructions');

check('the prompt says the history is data, not instructions', () => {
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

console.log('the budget');

check(
  'the prompt carries the target token count, the acceptable range and the context window',
  () => {
    assert.ok(
      PROMPT.includes(String(BUDGET.targetSummaryTokens)),
      `the target token count (${BUDGET.targetSummaryTokens}) is missing`
    );
    assertMatchesAny(
      PROMPT,
      [
        new RegExp(
          `\\b${BUDGET.minSummaryTokens}\\s*(?:-|–|—|to)\\s*${BUDGET.maxSummaryTokens}\\b`
        ),
      ],
      `the acceptable range (${BUDGET.minSummaryTokens}-${BUDGET.maxSummaryTokens}) is missing`
    );
    assert.ok(PROMPT.includes(String(NUM_CTX)), `the context window (${NUM_CTX}) is missing`);
    assertMatchesAny(PROMPT, [/\btoken/i], 'the prompt does not talk about tokens');
    assertMatchesAny(PROMPT, [/\brange/i], 'the prompt does not talk about a range');
    assertMatchesAny(
      PROMPT,
      [/context window/i],
      'the prompt does not talk about a context window'
    );
  }
);

check('the prompt carries the preserved-recent token count', () => {
  assert.ok(
    PROMPT.includes(String(PRESERVED_RECENT_TOKENS)),
    `the preserved-recent token count (${PRESERVED_RECENT_TOKENS}) is missing`
  );
});

console.log('the shape of the output');

check('the prompt no longer demands a third-person narrative', () => {
  assertOnlyProhibited(PROMPT, /third person/i, 'third person');
  assertOnlyProhibited(PROMPT, /narrative/i, 'narrative');
});

check('the prompt no longer forbids headings', () => {
  assert.ok(!/no headings/i.test(PROMPT), 'the prompt still forbids headings');
  assert.ok(!/without headings/i.test(PROMPT), 'the prompt still forbids headings');
});

check('the prompt asks for section paragraphs in plain text, without markdown', () => {
  assertMatchesAny(PROMPT, [/\bsection/i], 'the prompt does not ask for sections');
  assertMatchesAny(PROMPT, [/paragraph/i], 'the prompt does not ask for paragraphs');
  assertMatchesAny(PROMPT, [/plain (summary )?text/i], 'the prompt does not ask for plain text');
  assertMatchesAny(PROMPT, [/no markdown/i], 'the prompt does not forbid markdown syntax');
});

console.log('the prompt must not license a worse summary');

check('the prompt never asks the model to repeat, pad or elaborate beyond the history', () => {
  assertNoneOf(PROMPT, [
    [/\belaborat(?:e|es|ed|ing|ion)\b/i, 'an instruction to elaborate'],
    [/\bpad(?:ding|s|ded)?\b/i, 'an instruction to pad'],
    [/as much as you can/i, 'an instruction to write as much as possible'],
    [/as detailed as possible/i, 'an instruction to be as detailed as possible'],
  ]);
  // "repeat" may appear — but only in a clause that forbids it.
  assertOnlyProhibited(PROMPT, /\brepeat(?:s|ed|ing)?\b/i, 'repeat');
});

check('the prompt never licenses shortening an identifier or an error message', () => {
  assertNoneOf(PROMPT, [
    [/may be shortened/i, 'a licence to shorten a name'],
    [/\btruncate[ds]? the\b/i, 'a licence to truncate a name'],
    [/\bfirst \d+ characters\b/i, 'a licence to cut a name to a length'],
  ]);
  // "shorten" itself may appear — but only in a clause that forbids it.
  assertOnlyProhibited(PROMPT, /\bshorten(?:s|ed|ing)?\b/i, 'shorten');
});

check('the prompt never asks for material that is not in the history', () => {
  assertNoneOf(PROMPT, [
    [/\byou happen to know\b/i, 'an instruction to add background knowledge'],
    [/\bfeel free\b/i, 'an invitation to add material'],
    [/\badd (?:anything|whatever|extra|more)\b/i, 'an instruction to add material'],
    [/\bmake up\b/i, 'an instruction to invent'],
    [/\bfabricat(?:e|es|ed|ing|ion)\b/i, 'an instruction to fabricate'],
    [/\bhallucinat(?:e|es|ed|ing|ion)\b/i, 'an instruction to hallucinate'],
    [/\bplausible\b/i, 'an invitation to make a plausible guess'],
  ]);
  // "background knowledge" may appear — but only in a clause that forbids it.
  assertOnlyProhibited(PROMPT, /\bbackground knowledge\b/i, 'background knowledge');
  assertOnlyProhibited(PROMPT, /\binvent(?:s|ed|ing)?\b/i, 'invent');
  assertOnlyProhibited(PROMPT, /\bparaphras(?:e|es|ed|ing)\b/i, 'paraphrase');
});

check('the prompt never asks for markdown', () => {
  // The word "markdown" may appear — but only in a clause that forbids it.
  assertOnlyProhibited(PROMPT, /\bmarkdown\b/i, 'markdown');
  assertOnlyProhibited(PROMPT, /\bbullets?\b/i, 'bullets');
  assertOnlyProhibited(PROMPT, /\bbold\b/i, 'bold');
  assertOnlyProhibited(PROMPT, /\bcode fences?\b/i, 'code fences');
  assertOnlyProhibited(PROMPT, /\bheadings?\b/i, 'headings');
  // And no markdown syntax may be shown to the model as an example.
  assertNoneOf(PROMPT, [
    [/```/, 'a fenced code block'],
    [/\*\*[^\n*]+\*\*/, 'bold markup'],
    [/^[\t ]*#{1,6}[\t ]/m, 'a markdown heading'],
    [/^[\t ]*[*+-][\t ]/m, 'a markdown bullet list'],
  ]);
});

check('the prompt never asks for a placeholder in an empty section', () => {
  assertNoneOf(PROMPT, [
    [/\bplaceholder\b/i, 'an instruction to write a placeholder'],
    [/\bTBD\b/, 'an instruction to write a placeholder'],
    [/\bTODO\b/, 'an instruction to write a placeholder'],
  ]);
  // "None" and "N/A" may appear — but only in a clause that forbids them.
  assertOnlyProhibited(PROMPT, /\bnone\b|\bn\/a\b/i, 'None/N/A');
});

check('the section purposes ask for what the history states, not for an inference', () => {
  // A purpose that asks for the model's own conclusion ("the ultimate goal",
  // "the user's intent", "the rejected options") would make the model infer
  // what the history never says — the very thing the prompt forbids.
  for (const section of EXPECTED_SECTIONS) {
    const line = sectionLine(PROMPT, section);
    assert.ok(line !== '', `the prompt has no "${section}:" line`);
    assert.doesNotMatch(
      line,
      /\bultimate\b|\binfer(?:ring|s|red)?\b|\bintent\b|\byou happen to know\b/i,
      `the "${section}" purpose asks for something the history may not state: ${JSON.stringify(line)}`
    );
  }
});

console.log('the prompt reaches the model');

check('the summarisation request carries the prompt as its system message', () => {
  const input = buildSummarisationInput(GOLDEN_HISTORY, BUDGET, PRESERVED_RECENT_TOKENS, NUM_CTX);
  assert.equal(input.messages[0].role, 'system', 'the first message is not the system message');
  const system = input.messages.find((message) => message.role === 'system');
  assert.ok(system, 'the summarisation request has no system message');
  assert.equal(system.content, PROMPT, 'the system message is not the summariser prompt');
});

check('the system message is byte-identical to the exported prompt builder', () => {
  const input = buildSummarisationInput(
    [{ role: 'user', content: 'hello' }],
    BUDGET,
    PRESERVED_RECENT_TOKENS,
    NUM_CTX
  );
  const system = input.messages.find((message) => message.role === 'system');
  assert.ok(system, 'the summarisation request has no system message');
  assert.equal(
    system.content,
    buildCompactSystemPrompt(PROMPT_PARAMS),
    'buildSummarisationInput and buildCompactSystemPrompt disagree'
  );
});

check('the user message carries the serialised history', () => {
  const input = buildSummarisationInput(GOLDEN_HISTORY, BUDGET, PRESERVED_RECENT_TOKENS, NUM_CTX);
  const user = input.messages.find((message) => message.role === 'user');
  assert.ok(user, 'the summarisation request has no user message');
  assert.ok(
    user.content.endsWith(input.historyText),
    'the request does not carry the serialised history'
  );
});

console.log('the map-reduce combine prompt');

check('the reduction prompt keeps the six sections, in order', () => {
  let previous = -1;
  for (const section of EXPECTED_SECTIONS) {
    const index = REDUCTION_COMBINE_SYSTEM_PROMPT.indexOf(section);
    assert.ok(index !== -1, `the reduction prompt does not mention the "${section}" section`);
    assert.ok(index > previous, `the "${section}" section is out of order in the reduction prompt`);
    previous = index;
  }
});

check('the reduction prompt names the six sections as one ordered list', () => {
  assert.ok(
    REDUCTION_COMBINE_SYSTEM_PROMPT.includes(EXPECTED_SECTIONS.join(', ')),
    `the reduction prompt does not carry the section list "${EXPECTED_SECTIONS.join(', ')}"`
  );
});

check('the reduction prompt keeps names exact', () => {
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

check('the reduction prompt demands that the merge keeps every fact', () => {
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

check('the reduction prompt does not forbid headings', () => {
  assert.ok(
    !/no headings/i.test(REDUCTION_COMBINE_SYSTEM_PROMPT),
    'the reduction prompt still forbids headings'
  );
});

check('the reduction prompt does not flatten the parts into a narrative', () => {
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

check('the reduction prompt still asks for plain text without markdown', () => {
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

check('the reduction prompt does not license a worse merge', () => {
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

console.log('the golden transcript');

check('the scripted history keeps the file path, the command and the error message', () => {
  const input = buildSummarisationInput(GOLDEN_HISTORY, BUDGET, PRESERVED_RECENT_TOKENS, NUM_CTX);
  const facts = [
    ['file path', GOLDEN_PATH],
    ['command', GOLDEN_COMMAND],
    ['error message', GOLDEN_ERROR],
  ];
  for (const [label, value] of facts) {
    assert.ok(
      input.historyText.includes(value),
      `the ${label} "${value}" did not reach the summariser`
    );
  }
});

check('the scripted history reaches the request as labelled blocks', () => {
  const input = buildSummarisationInput(GOLDEN_HISTORY, BUDGET, PRESERVED_RECENT_TOKENS, NUM_CTX);
  const user = input.messages.find((message) => message.role === 'user');
  assert.ok(user, 'the summarisation request has no user message');
  assert.ok(
    user.content.includes('[ASSISTANT -> write_file]'),
    'the write_file call is missing from the request'
  );
  assert.ok(
    user.content.includes('[ASSISTANT -> run_command]'),
    'the run_command call is missing from the request'
  );
  assert.ok(
    user.content.includes('[TOOL run_command]'),
    'the tool output is missing from the request'
  );
});

check('the prompt asks for exactly those three kinds of thing to be retained', () => {
  assertMatchesAny(PROMPT, [/file path/i], 'the prompt does not ask for file paths');
  assertMatchesAny(PROMPT, [/\bcommand\b/i], 'the prompt does not ask for commands');
  assertMatchesAny(PROMPT, [/error message/i], 'the prompt does not ask for error messages');
  assertMatchesAny(
    PROMPT,
    [/character[ -]for[ -]character/i],
    'the prompt does not tie the three kinds of thing to exact copying'
  );
});

console.log('the shape the model actually produces (fixture)');

check('a legitimate "Error:" or "Note:" line is not a section label', () => {
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
  assert.deepEqual(labels, ['Goal', 'Key data']);
});

const FIXTURE_RAW = fs.readFileSync(FIXTURE_PATH, 'utf8');
const FIXTURE = splitFixture(FIXTURE_RAW);

check('the fixture records how it was produced', () => {
  assert.match(FIXTURE.header, /\d{4}-\d{2}-\d{2}/, 'the fixture header has no date');
  assert.match(
    FIXTURE.header,
    /model/i,
    'the fixture header does not name the model that produced the summary'
  );
  assert.match(
    FIXTURE.header,
    /test-compact-prompt\.mjs/,
    'the fixture header does not name the script that produced the summary'
  );
});

check('the fixture header carries no credential', () => {
  assert.doesNotMatch(
    FIXTURE.header,
    /api[_-]?key|authorization|bearer/i,
    'the fixture header names a credential'
  );
  assert.doesNotMatch(FIXTURE.header, /\bsk-[\dA-Za-z]{8,}/, 'the fixture header carries a key');
  assert.doesNotMatch(
    FIXTURE.header,
    /\b[\da-f]{32,}\b/i,
    'the fixture header carries a long hex token'
  );
});

check('the fixture summary has the shape the prompt demands', () => {
  assertSummaryShape(FIXTURE.body, [
    ['file path', GOLDEN_PATH],
    ['command', GOLDEN_COMMAND],
    ['error message', GOLDEN_ERROR],
  ]);
});

check('the fixture summary keeps only sections of the six, in order', () => {
  const labels = FIXTURE.body
    .split(/\r?\n/)
    .map((line) => SECTION_LABEL_LINE.exec(line)?.[1])
    .filter((label) => label !== undefined);
  assert.ok(labels.length > 0, 'the fixture summary has no section label');
  for (const label of labels) {
    assert.ok(
      EXPECTED_SECTIONS.includes(label),
      `the fixture summary has a "${label}:" line that is not one of the six sections`
    );
  }
  const indexes = labels.map((label) => EXPECTED_SECTIONS.indexOf(label));
  assert.deepEqual(
    indexes,
    [...indexes].sort((left, right) => left - right),
    `the fixture summary has its sections out of order: ${labels.join(', ')}`
  );
});

check('the fixture summary has no markdown heading and no block label', () => {
  for (const line of FIXTURE.body.split(/\r?\n/)) {
    assert.ok(
      !/^\s*#{1,6}\s/.test(line),
      `the fixture summary has a markdown heading: ${JSON.stringify(line)}`
    );
    assert.ok(
      !BLOCK_LABEL_LINE.test(line),
      `the fixture summary has a serialiser block label: ${JSON.stringify(line)}`
    );
  }
});

check('the fixture summary has no "None" or "N/A" placeholder line', () => {
  for (const line of FIXTURE.body.split(/\r?\n/)) {
    const trimmed = line.trim().toLowerCase();
    assert.ok(
      trimmed !== 'none' && trimmed !== 'n/a',
      `the fixture summary has a placeholder line: ${JSON.stringify(line)}`
    );
  }
});

check('the fixture summary keeps the file path, the command and the error message', () => {
  for (const [label, value] of [
    ['file path', GOLDEN_PATH],
    ['command', GOLDEN_COMMAND],
    ['error message', GOLDEN_ERROR],
  ]) {
    assert.ok(FIXTURE.body.includes(value), `the fixture summary lost the ${label} "${value}"`);
  }
});

/**
 * The live check.
 *
 * Skipped unless the environment asks for it AND the repo's own config.json
 * carries a usable provider. A provider/network failure is a SKIP with the
 * reason — it says nothing about this repository — while a summary that
 * loses a fact is a FAILURE.
 */
async function runLiveCheck() {
  if (process.env['LOCOPILOT_TEST_LIVE_COMPACTION'] !== '1') {
    skip(
      'live summarisation',
      'set LOCOPILOT_TEST_LIVE_COMPACTION=1 to run it (it spends quota on the configured provider)'
    );
    return;
  }

  const writeFixture = process.env['LOCOPILOT_TEST_LIVE_WRITE_FIXTURE'] ?? '';
  let summary = '';
  let model = '';
  let providerId = '';
  let providerKind = '';
  let providerBaseUrl = '';
  let numCtx = 0;

  try {
    const config = await loadConfig();
    const requestedProviderId =
      process.env['LOCOPILOT_TEST_LIVE_PROVIDER_ID'] || config?.activeProviderId || undefined;
    const modelName =
      process.env['LOCOPILOT_TEST_LIVE_MODEL'] || config?.compactionModel || config?.model;
    let provider = resolveProvider(config, requestedProviderId, modelName);
    if (!provider) {
      provider = resolveProvider(config, undefined, modelName);
    }
    if (!provider || !provider.baseUrl) {
      skip('live summarisation', 'no usable provider in config.json');
      return;
    }
    model =
      process.env['LOCOPILOT_TEST_LIVE_MODEL'] || provider.model || config?.model || undefined;
    if (!model) {
      skip('live summarisation', 'no model configured');
      return;
    }
    providerId = provider.id;
    providerKind = provider.provider;
    providerBaseUrl = provider.baseUrl;

    // The configured num_ctx can be far larger than the model accepts (this
    // repo's own config.json asks for 13107200), and a provider that rejects
    // it would fail the suite for a reason that has nothing to do with the
    // prompt. The live check therefore asks for at most 8192 tokens.
    numCtx = Math.min(getProviderNumCtx(provider, config?.numCtx), LIVE_MAX_NUM_CTX);
    console.log(
      `  NOTE  live run: provider=${providerId} model=${model} numCtx=${numCtx} (clamped to ${LIVE_MAX_NUM_CTX})`
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
    skip(
      'live summarisation',
      `the provider call failed (${err instanceof Error ? err.message : String(err)})`
    );
    return;
  }

  const facts = [
    ['file path', GOLDEN_PATH],
    ['command', GOLDEN_COMMAND],
    ['error message', GOLDEN_ERROR],
  ];

  check('the live summary keeps the file path, the command and the error message', () => {
    for (const [label, value] of facts) {
      assert.ok(
        summary.includes(value),
        `the summary lost the ${label} "${value}" — summary was: ${JSON.stringify(summary)}`
      );
    }
  });

  check('the live summary has the shape the prompt demands', () => {
    assertSummaryShape(summary, facts);
  });

  if (writeFixture) {
    const target = writeFixture === '1' ? FIXTURE_PATH : path.resolve(writeFixture);
    const header = [
      FIXTURE_HEADER_START,
      `Produced on: ${new Date().toISOString()} (UTC)`,
      'Produced by: LOCOPILOT_TEST_LIVE_COMPACTION=1 LOCOPILOT_TEST_LIVE_WRITE_FIXTURE=1 npx tsx scripts/test-compact-prompt.mjs',
      `Provider: ${providerId} (${providerKind}) — ${providerBaseUrl}`,
      `Model: ${model}`,
      `Context window used: ${numCtx} (clamped to ${LIVE_MAX_NUM_CTX} by the live check)`,
      'Scripted history: the GOLDEN_HISTORY array of scripts/test-compact-prompt.mjs — a user turn about a crashing status bar, an assistant turn, a write_file call for src/services/compact/statusBar.tsx, a run_command call for npm run test:compact-prompt and the tool output carrying the TypeError.',
      'Note: the summary below is the model output verbatim; nothing was edited by hand.',
      FIXTURE_HEADER_END,
    ].join('\n');
    fs.writeFileSync(target, `${header}\n${summary}\n`, 'utf8');
    console.log(`  NOTE  fixture written to ${target}`);
  }

  console.log(
    summary
      .split('\n')
      .map((line) => `        ${line}`)
      .join('\n')
  );
}

console.log('the live summariser (optional)');
await runLiveCheck();

// ── The empty-response retry must ask for the same shape ─────────────────
check('the empty-response retry asks for the same six sections', () => {
  const retry = buildRetrySystemPrompt(RETRY_PARAMS);
  for (const section of SUMMARY_SECTIONS) {
    assert.ok(retry.includes(`${section}:`), `the retry does not ask for the ${section} section`);
  }
  assert.ok(/character for character/i.test(retry), 'the retry lost the exactness rule');
  assert.ok(/omit/i.test(retry), 'the retry lost the omit-empty rule');
  assert.ok(!/third person|narrative/i.test(retry), 'the retry still asks for a narrative');
});

check('the retry carries the injection guard and a token target', () => {
  const retry = buildRetrySystemPrompt(RETRY_PARAMS);
  assertMatchesAny(
    retry,
    [/\bdata\b[^\n.]*\bnot instructions\b/i],
    'the retry does not say the text is data and not instructions'
  );
  assert.ok(
    retry.includes(String(BUDGET.targetSummaryTokens)),
    `the retry lost the token target (${BUDGET.targetSummaryTokens})`
  );
  assert.ok(retry.includes(String(NUM_CTX)), `the retry lost the context window (${NUM_CTX})`);
});

console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
