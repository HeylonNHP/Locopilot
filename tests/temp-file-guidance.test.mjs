/**
 * Regression checks for the shared scratch-file guidance.
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

import { describe, expect, jest, test } from '@jest/globals';
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
// Jest hands each test file its own copy of `process.env`, which `os.tmpdir()`
// cannot see, so the override is applied to `os.tmpdir()` itself.
const FORCED_TMP = path.join(HOST_TMP, 'locopilot-temp-file-guidance-host');
jest.spyOn(os, 'tmpdir').mockReturnValue(FORCED_TMP);

const { TEMP_FILE_GUIDANCE } = await import('../src/tools/tempFileGuidance.ts');
const { formatPromptDate } = await import('../src/services/promptDate.ts');
const { createSystemPrompt } = await import('../src/services/chatSession.ts');
const { buildSubAgentSystemPrompt } = await import('../src/tools/impl/subAgentTool.ts');
const { getToolSystemPrompt } = await import('../src/tools/tools.ts');

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
  expect(index).not.toBe(-1);
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

describe('the shared constant', () => {
  test('is the reviewed wording', () => {
    expect(TEMP_FILE_GUIDANCE.startsWith(GUIDANCE_START)).toBeTruthy();
    expect(TEMP_FILE_GUIDANCE).toMatch(/operating system's temporary directory/);
    expect(TEMP_FILE_GUIDANCE).toMatch(
      /never in the agent working directory or the user's project/
    );
    expect(TEMP_FILE_GUIDANCE).toMatch(/\$TMPDIR/);
    expect(TEMP_FILE_GUIDANCE).toMatch(/\$env:TEMP` \(PowerShell\) or `%TEMP%` \(cmd\)/);
    expect(TEMP_FILE_GUIDANCE).toMatch(/write_file can create it/);
    expect(TEMP_FILE_GUIDANCE).toMatch(/using absolute paths/);
    expect(TEMP_FILE_GUIDANCE).toMatch(/pollute their git status/);
  });

  test('is a single paragraph (no embedded line break)', () => {
    expect(TEMP_FILE_GUIDANCE).not.toContain('\n');
    expect(TEMP_FILE_GUIDANCE).not.toContain('\r');
  });

  test('is byte-for-byte the approved wording (the SHA-256 pin)', () => {
    const digest = createHash('sha256').update(TEMP_FILE_GUIDANCE, 'utf8').digest('hex');
    expect(digest).toBe(APPROVED_GUIDANCE_SHA256);
    expect(TEMP_FILE_GUIDANCE).toHaveLength(854);
  });

  test.each(REJECTED_PHRASES)('drops every wording defect the review found (%p)', (phrase) => {
    expect(TEMP_FILE_GUIDANCE).not.toContain(phrase);
  });
});

describe('the main chat prompt', () => {
  test('contains the guidance verbatim', () => {
    expect(mainPrompt).toContain(TEMP_FILE_GUIDANCE);
  });

  test('still states the date on line 2 (index 1, the prompt-cache constraint)', () => {
    const lines = mainPrompt.split('\n');
    expect(lines[0]).toBe(
      'You are Locopilot, a helpful AI assistant running inside a web application.'
    );
    expect(lines[1]).toBe(`Current date: ${formatPromptDate(t1)}`);
  });

  test('carries the guidance AFTER the date line', () => {
    const lines = mainPrompt.split('\n');
    const index = lines.findIndex((line) => line.startsWith(GUIDANCE_START));
    expect(index).toBeGreaterThan(1);
  });

  test('carries the guidance as its own paragraph', () => {
    const lines = mainPrompt.split('\n');
    const index = lines.findIndex((line) => line.startsWith(GUIDANCE_START));
    expect(lines[index - 1]).toBe('');
    expect(lines[index + 1]).toBe('');
  });

  test('contains the guidance exactly once (a duplicate would double the tokens)', () => {
    expect(countOccurrences(mainPrompt, TEMP_FILE_GUIDANCE)).toBe(1);
    expect(mainPrompt.split('\n').filter((line) => line.startsWith(GUIDANCE_START))).toHaveLength(
      1
    );
  });
});

describe('the sub-agent prompt', () => {
  test('contains the guidance verbatim', () => {
    expect(subPrompt).toContain(TEMP_FILE_GUIDANCE);
  });

  test('carries the guidance in its rule block, after the isolation paragraph', () => {
    const lines = subPrompt.split('\n');
    const index = lines.findIndex((line) => line.startsWith(GUIDANCE_START));
    expect(index).toBeGreaterThan(1);
    const isolation = lines.findIndex((line) =>
      line.startsWith('You are isolated from the parent conversation.')
    );
    expect(isolation).not.toBe(-1);
    expect(index).toBeGreaterThan(isolation);
  });

  test('contains the guidance exactly once (a duplicate would double the tokens)', () => {
    expect(countOccurrences(subPrompt, TEMP_FILE_GUIDANCE)).toBe(1);
    expect(subPrompt.split('\n').filter((line) => line.startsWith(GUIDANCE_START))).toHaveLength(1);
  });
});

describe('the two copies', () => {
  test('are byte-identical to each other', () => {
    const fromMain = extractGuidance(mainPrompt);
    const fromSub = extractGuidance(subPrompt);
    expect(fromMain).toBe(fromSub);
    expect(Buffer.from(fromMain, 'utf8').toString('utf8')).toBe(fromSub);
  });

  test('are byte-identical to the shared constant', () => {
    expect(extractGuidance(mainPrompt)).toBe(TEMP_FILE_GUIDANCE);
    expect(extractGuidance(subPrompt)).toBe(TEMP_FILE_GUIDANCE);
  });

  test('the tool prompt does not repeat it (it would land in the main prompt twice)', () => {
    expect(getToolSystemPrompt(false)).not.toContain(TEMP_FILE_GUIDANCE);
    expect(getToolSystemPrompt(true)).not.toContain(TEMP_FILE_GUIDANCE);
  });
});

describe('byte stability', () => {
  test('the main prompt is byte-identical across two builds on the same day', () => {
    expect(createSystemPrompt(undefined, false, true, t1)).toBe(
      createSystemPrompt(undefined, false, true, t1b)
    );
  });

  test('the sub-agent prompt is byte-identical across two builds on the same day', () => {
    expect(buildSubAgentSystemPrompt(undefined, true, t1)).toBe(
      buildSubAgentSystemPrompt(undefined, true, t1b)
    );
  });

  test('the guidance itself never varies between builds', () => {
    const other = createSystemPrompt(undefined, false, true, t1b);
    expect(extractGuidance(other)).toBe(extractGuidance(mainPrompt));
    const otherSub = buildSubAgentSystemPrompt(undefined, true, t1b);
    expect(extractGuidance(otherSub)).toBe(extractGuidance(subPrompt));
  });
});

describe('host independence', () => {
  test('the temp-dir override took effect (the check below is not vacuous)', () => {
    expect(os.tmpdir()).toBe(FORCED_TMP);
    expect(FORCED_TMP).not.toBe(HOST_TMP);
  });

  test("neither prompt contains the host's resolved temp path", () => {
    expect(mainPrompt).not.toContain(FORCED_TMP);
    expect(subPrompt).not.toContain(FORCED_TMP);
  });

  test('the guidance contains no machine-specific path', () => {
    // The generic locations the wording NAMES are allowed ("/tmp" and the
    // "%TEMP%" example); anything specific to this machine is not.
    const generic = new Set(['/', '/tmp', '/var/tmp', '/private/tmp']);
    const hostPaths = [FORCED_TMP, os.homedir(), process.cwd()];
    for (const hostPath of hostPaths) {
      if (!hostPath || generic.has(hostPath)) continue;
      // A filesystem ROOT ("/" or "C:\") is not a machine-specific path.
      if (path.parse(hostPath).root === hostPath) continue;
      expect(TEMP_FILE_GUIDANCE).not.toContain(hostPath);
    }
  });

  test('the guidance names the environment variables, not a resolved path', () => {
    expect(TEMP_FILE_GUIDANCE).toMatch(/\$TMPDIR/);
    expect(TEMP_FILE_GUIDANCE).toMatch(/%TEMP%/);
    expect(TEMP_FILE_GUIDANCE).not.toContain(FORCED_TMP);
  });
});
