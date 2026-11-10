#!/usr/bin/env node
/**
 * Regression checks for the shared scratch-file guidance.
 *
 * Run with: npx tsx scripts/test-temp-file-guidance.mjs
 *
 * The model sometimes writes scratch files (intermediate output, throwaway
 * logs) into the AGENT WORKING DIRECTORY or the user's project, which shows
 * up as untracked files in their `git status`. The fix is a standing
 * instruction in the system prompts, and there are TWO prompt surfaces: the
 * main chat prompt (built by `createSystemPrompt`) and the sub-agent prompt
 * (built by `buildSubAgentSystemPrompt`). They are separate strings, so the
 * instruction must come from ONE shared definition - these checks pin that
 * both prompts carry the SAME paragraph, byte for byte, and that it is
 * byte-stable across builds and host-independent.
 *
 * The paragraph is PINNED BY DIGEST as well as by substrings. A substring
 * check only says "the wording still contains these phrases", so a rewrite
 * that keeps eight phrases but breaks the meaning in every other respect
 * would still pass. The SHA-256 assertion below pins the WHOLE string: any
 * edit at all - a changed word, a changed space, a changed dash - changes
 * the digest and fails this suite, so the approved wording can only change
 * deliberately, together with the digest that documents it.
 *
 * Network-free.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Must be set before skill discovery runs (src/services/skillManager.ts reads
// it lazily on each call, so setting it here is sufficient).
process.env.LOCOPILOT_HOME = path.join(os.tmpdir(), 'locopilot-temp-file-guidance-test');

// The host's temp dir BEFORE the override below, so the "no machine-specific
// path" check can compare against both the original and the overridden value.
const HOST_TMP = os.tmpdir();

// Force a unique, host-specific temp directory BEFORE any prompt is built, so
// the "the prompt must not embed the host's resolved temp path" check is not
// vacuous on a host whose temp dir IS the generic "/tmp" that the wording
// documents (the wording names `$TMPDIR`/`%TEMP%`, never a resolved path).
const FORCED_TMP = path.join(HOST_TMP, 'locopilot-temp-file-guidance-host');
process.env.TMPDIR = FORCED_TMP;
process.env.TEMP = FORCED_TMP;
process.env.TMP = FORCED_TMP;

const { TEMP_FILE_GUIDANCE } = await import('../src/tools/tempFileGuidance.ts');
const { formatPromptDate } = await import('../src/services/promptDate.ts');
const { createSystemPrompt } = await import('../src/services/chatSession.ts');
const { buildSubAgentSystemPrompt } = await import('../src/tools/impl/subAgentTool.ts');
const { getToolSystemPrompt } = await import('../src/tools/tools.ts');

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
  }
}

/** The reviewed wording is a single paragraph with no line break in it. */
const GUIDANCE_START = 'Scratch files: put anything temporary you create';

/**
 * The SHA-256 of the APPROVED wording, as UTF-8 bytes.
 *
 * WHAT IT PINS: the whole of `TEMP_FILE_GUIDANCE` - 854 characters, 864
 * UTF-8 bytes, one paragraph. WHY: the substring checks below only prove that
 * a handful of phrases survive an edit, so a rewrite that quietly re-broke
 * the wording would still pass them; a digest fails on ANY difference.
 * To change the wording on purpose: edit the constant, re-compute the digest
 * with
 *   node -e "const {createHash}=require('node:crypto');const s=process.argv[1];
 *   console.log(createHash('sha256').update(s,'utf8').digest('hex'))" "<new text>"
 * and update the value below in the same commit.
 */
const APPROVED_GUIDANCE_SHA256 = '6b9f38ceeede3a1aedf0f83835829c087ecf9a4294c5e4c6751e7081a34c97f7';

/**
 * The wording defects a review found in the first draft. Each one is a fact
 * about the runtime, so each is checked by ABSENCE: the approved wording must
 * not contain the defective phrase any more.
 */
const REJECTED_PHRASES = [
  // "the user's project directory" named a place that does not exist in the
  // model's world: Locopilot's default working directory is the user's HOME.
  "the user's project directory",
  // `$TMPDIR` is commonly UNSET, so "usually `/tmp`" was a claim about the
  // majority case rather than about the host in front of the model.
  'usually `/tmp`',
  // Locopilot's default Windows shell is PowerShell, where `%TEMP%` is a bare
  // literal - the PowerShell spelling has to be there too.
  '`%TEMP%` (usually',
  // The discovery commands were shell-wrong on Locopilot's own shells.
  'echo $TMPDIR',
  'echo %TEMP%',
  // A literal Windows temp path: `<` and `>` are illegal in Windows file
  // names, and `path.resolve` would turn it into a junk file in the working
  // directory on Linux.
  'AppData',
  '<you>',
  // `mktemp` is not a PowerShell/cmd cmdlet, and `run_command` is
  // approval-gated while `write_file` is not.
  'mktemp',
  // "generated artifacts" made a generated logo referenced by an HTML file
  // look temporary - a deliverable must not be moved into the temp directory.
  'generated artifacts',
];

/**
 * Extracts the guidance paragraph from a prompt by finding the line that
 * starts it - deliberately NOT by slicing the known constant out of the
 * prompt, so the two copies are compared as the prompt really renders them.
 */
function extractGuidance(prompt) {
  const lines = prompt.split('\n');
  const index = lines.findIndex((line) => line.startsWith(GUIDANCE_START));
  assert.notEqual(index, -1, 'the guidance paragraph is not in the prompt');
  return lines[index];
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// Two instants on the SAME local day, minutes apart: the date line is
// day-resolution, so both builds must be byte-identical.
const t1 = new Date(2026, 10, 8, 9, 0, 0);
const t1b = new Date(2026, 10, 8, 9, 5, 0);

const mainPrompt = createSystemPrompt(undefined, false, true, t1);
const subPrompt = buildSubAgentSystemPrompt(undefined, true, t1);

console.log('the shared constant');

check('is the reviewed wording', () => {
  assert.ok(TEMP_FILE_GUIDANCE.startsWith(GUIDANCE_START));
  assert.match(TEMP_FILE_GUIDANCE, /operating system's temporary directory/);
  assert.match(TEMP_FILE_GUIDANCE, /never in the agent working directory or the user's project/);
  assert.match(TEMP_FILE_GUIDANCE, /\$TMPDIR/);
  assert.match(TEMP_FILE_GUIDANCE, /\$env:TEMP` \(PowerShell\) or `%TEMP%` \(cmd\)/);
  assert.match(TEMP_FILE_GUIDANCE, /write_file can create it/);
  assert.match(TEMP_FILE_GUIDANCE, /using absolute paths/);
  assert.match(TEMP_FILE_GUIDANCE, /pollute their git status/);
});

check('is a single paragraph (no embedded line break)', () => {
  assert.ok(!TEMP_FILE_GUIDANCE.includes('\n'));
  assert.ok(!TEMP_FILE_GUIDANCE.includes('\r'));
});

check('is byte-for-byte the approved wording (the SHA-256 pin)', () => {
  const digest = createHash('sha256').update(TEMP_FILE_GUIDANCE, 'utf8').digest('hex');
  assert.equal(digest, APPROVED_GUIDANCE_SHA256);
  assert.equal(TEMP_FILE_GUIDANCE.length, 854);
});

check('drops every wording defect the review found', () => {
  for (const phrase of REJECTED_PHRASES) {
    assert.ok(
      !TEMP_FILE_GUIDANCE.includes(phrase),
      `the guidance still contains the rejected phrase ${JSON.stringify(phrase)}`
    );
  }
});

console.log('the main chat prompt');

check('contains the guidance verbatim', () => {
  assert.ok(mainPrompt.includes(TEMP_FILE_GUIDANCE));
});

check('still states the date on line 2 (index 1, the prompt-cache constraint)', () => {
  const lines = mainPrompt.split('\n');
  assert.equal(
    lines[0],
    'You are Locopilot, a helpful AI assistant running inside a web application.'
  );
  assert.equal(lines[1], `Current date: ${formatPromptDate(t1)}`);
});

check('carries the guidance AFTER the date line', () => {
  const lines = mainPrompt.split('\n');
  const index = lines.findIndex((line) => line.startsWith(GUIDANCE_START));
  assert.ok(index > 1, `the guidance is at line ${index}, expected after line 1`);
});

check('carries the guidance as its own paragraph', () => {
  const lines = mainPrompt.split('\n');
  const index = lines.findIndex((line) => line.startsWith(GUIDANCE_START));
  assert.equal(lines[index - 1], '', 'the guidance must be preceded by a blank line');
  assert.equal(lines[index + 1], '', 'the guidance must be followed by a blank line');
});

check('contains the guidance exactly once (a duplicate would double the tokens)', () => {
  assert.equal(countOccurrences(mainPrompt, TEMP_FILE_GUIDANCE), 1);
  assert.equal(mainPrompt.split('\n').filter((line) => line.startsWith(GUIDANCE_START)).length, 1);
});

console.log('the sub-agent prompt');

check('contains the guidance verbatim', () => {
  assert.ok(subPrompt.includes(TEMP_FILE_GUIDANCE));
});

check('carries the guidance in its rule block, after the isolation paragraph', () => {
  const lines = subPrompt.split('\n');
  const index = lines.findIndex((line) => line.startsWith(GUIDANCE_START));
  assert.ok(index > 1, `the guidance is at line ${index}, expected after line 1`);
  const isolation = lines.findIndex((line) =>
    line.startsWith('You are isolated from the parent conversation.')
  );
  assert.ok(isolation !== -1, 'the isolation paragraph is missing');
  assert.ok(index > isolation, 'the guidance must come after the isolation paragraph');
});

check('contains the guidance exactly once (a duplicate would double the tokens)', () => {
  assert.equal(countOccurrences(subPrompt, TEMP_FILE_GUIDANCE), 1);
  assert.equal(subPrompt.split('\n').filter((line) => line.startsWith(GUIDANCE_START)).length, 1);
});

console.log('the two copies');

check('are byte-identical to each other', () => {
  const fromMain = extractGuidance(mainPrompt);
  const fromSub = extractGuidance(subPrompt);
  assert.equal(fromMain, fromSub);
  assert.equal(Buffer.from(fromMain, 'utf8').toString('utf8'), fromSub);
});

check('are byte-identical to the shared constant', () => {
  assert.equal(extractGuidance(mainPrompt), TEMP_FILE_GUIDANCE);
  assert.equal(extractGuidance(subPrompt), TEMP_FILE_GUIDANCE);
});

check('the tool prompt does not repeat it (it would land in the main prompt twice)', () => {
  assert.ok(!getToolSystemPrompt(false).includes(TEMP_FILE_GUIDANCE));
  assert.ok(!getToolSystemPrompt(true).includes(TEMP_FILE_GUIDANCE));
});

console.log('byte stability');

check('the main prompt is byte-identical across two builds on the same day', () => {
  assert.equal(
    createSystemPrompt(undefined, false, true, t1),
    createSystemPrompt(undefined, false, true, t1b)
  );
});

check('the sub-agent prompt is byte-identical across two builds on the same day', () => {
  assert.equal(
    buildSubAgentSystemPrompt(undefined, true, t1),
    buildSubAgentSystemPrompt(undefined, true, t1b)
  );
});

check('the guidance itself never varies between builds', () => {
  const other = createSystemPrompt(undefined, false, true, t1b);
  assert.equal(extractGuidance(other), extractGuidance(mainPrompt));
  const otherSub = buildSubAgentSystemPrompt(undefined, true, t1b);
  assert.equal(extractGuidance(otherSub), extractGuidance(subPrompt));
});

console.log('host independence');

check('the temp-dir override took effect (the check below is not vacuous)', () => {
  assert.equal(os.tmpdir(), FORCED_TMP);
  assert.notEqual(FORCED_TMP, HOST_TMP);
});

check("neither prompt contains the host's resolved temp path", () => {
  assert.ok(!mainPrompt.includes(FORCED_TMP));
  assert.ok(!subPrompt.includes(FORCED_TMP));
});

check('the guidance contains no machine-specific path', () => {
  // The generic locations the wording NAMES are allowed ("/tmp" and the
  // "%TEMP%" example); anything specific to this machine is not.
  const generic = new Set(['/', '/tmp', '/var/tmp', '/private/tmp']);
  const hostPaths = [FORCED_TMP, os.homedir(), process.cwd()];
  for (const hostPath of hostPaths) {
    if (!hostPath || generic.has(hostPath)) continue;
    // A filesystem ROOT ("/" or "C:\") is not a machine-specific path.
    if (path.parse(hostPath).root === hostPath) continue;
    assert.ok(
      !TEMP_FILE_GUIDANCE.includes(hostPath),
      `the guidance leaks the host path ${hostPath}`
    );
  }
});

check('the guidance names the environment variables, not a resolved path', () => {
  assert.match(TEMP_FILE_GUIDANCE, /\$TMPDIR/);
  assert.match(TEMP_FILE_GUIDANCE, /%TEMP%/);
  assert.ok(!TEMP_FILE_GUIDANCE.includes(FORCED_TMP));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
