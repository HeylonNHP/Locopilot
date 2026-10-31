#!/usr/bin/env node
/**
 * Focused checks for the run_command output spool.
 *
 * Run with: npx tsx scripts/test-output-spool.mjs
 *
 * The spool is the difference between a truncated capture and a lost one: the
 * preview the model reads is bounded, the bytes on disk are not. These checks
 * pin both halves — the preview stays inside its budget and lands on line
 * boundaries, and the file holds the stream byte for byte, invalid UTF-8
 * included.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BoundedOutput } from '../src/tools/boundedOutput.ts';
import { OutputSpool } from '../src/tools/outputSpool.ts';

let passed = 0;
let failed = 0;

function check(label, fn) {
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

const LIMITS = {
  inlineMaxBytes: 64,
  headMaxBytes: 100,
  tailMaxBytes: 40,
  maxSpoolBytes: 1024 * 1024,
};

const directory = mkdtempSync(path.join(tmpdir(), 'locopilot-spool-'));

function spool(name, limits = LIMITS, enabled = true) {
  return new OutputSpool({ limits, directory, name, enabled });
}

console.log('run_command output spool');

try {
  // A stream that fits the inline budget comes back whole.
  const small = spool('small.log');
  small.append(Buffer.from('hello\nworld\n'));
  small.finish();
  check('a stream that fits is returned verbatim', () => {
    assert.equal(small.text(), 'hello\nworld\n');
    assert.equal(small.stats().truncated, false);
    assert.equal(small.stats().omittedBytes, 0);
    assert.equal(small.stats().totalBytes, 12);
    assert.equal(small.stats().totalLines, 2);
  });

  // A stream that does not fit is split into a head and a tail.
  const lines = Array.from(
    { length: 20 },
    (_, index) => `line-${String(index).padStart(2, '0')}\n`
  );
  const whole = lines.join('');
  const big = spool('big.log');
  for (const line of lines) big.append(Buffer.from(line));
  big.finish();
  check('an oversized stream is split into a head and a tail', () => {
    const preview = big.preview();
    // The head is the BEGINNING of the stream and the tail is its END.
    // That is the property that matters; WHICH lines they are is an
    // implementation detail of the head/tail algorithm.
    assert.ok(preview.head.length > 0, 'the head is empty');
    assert.ok(preview.tail.length > 0, 'the tail is empty');
    assert.ok(whole.startsWith(preview.head), 'the head is not the start of the stream');
    assert.ok(whole.endsWith(preview.tail), 'the tail is not the end of the stream');
    // What is left out is a MIDDLE: the two halves never overlap.
    assert.ok(
      preview.head.length + preview.tail.length <= whole.length,
      'the head and the tail overlap'
    );
    // And no line is shown twice.
    const shown = [...preview.head.split('\n'), ...preview.tail.split('\n')].filter(Boolean);
    assert.equal(new Set(shown).size, shown.length, 'a line is shown twice');
    // The model reads the excerpt as one text.
    assert.equal(big.text(), preview.head + preview.tail);
  });
  check('the omitted middle is reported', () => {
    const stats = big.stats();
    const preview = big.preview();
    const shown = Buffer.byteLength(preview.head, 'utf8') + Buffer.byteLength(preview.tail, 'utf8');
    // The bytes the model does NOT see are exactly the ones that are
    // counted as omitted, whatever the head/tail algorithm decides to keep.
    assert.equal(stats.totalBytes - shown, stats.omittedBytes);
    assert.ok(stats.omittedBytes > 0, 'nothing was omitted from a stream that does not fit');
    assert.equal(stats.truncated, true);
    assert.equal(stats.totalBytes, 160);
    assert.equal(stats.totalLines, 20);
  });
  check('the head and tail are cut on line boundaries', () => {
    const preview = big.preview();
    assert.ok(preview.head.endsWith('\n'));
    for (const line of preview.head.split('\n').slice(0, -1)) {
      assert.match(line, /^line-\d\d$/);
    }
    for (const line of preview.tail.split('\n').slice(0, -1)) {
      assert.match(line, /^line-\d\d$/);
    }
  });
  check('the preview stays inside its byte budget', () => {
    const preview = big.preview();
    assert.ok(Buffer.byteLength(preview.head, 'utf8') <= LIMITS.headMaxBytes);
    assert.ok(Buffer.byteLength(preview.tail, 'utf8') <= LIMITS.tailMaxBytes);
  });
  check('the file on disk holds every byte of the stream', () => {
    assert.equal(readFileSync(path.join(directory, 'big.log'), 'utf8'), whole);
    assert.equal(readFileSync(path.join(directory, 'big.log')).length, big.stats().totalBytes);
  });

  // The counts describe the whole stream, not the part that was kept.
  const counted = spool('counted.log');
  counted.append(Buffer.from('a\nb\n'));
  counted.append(Buffer.from('c'));
  counted.finish();
  check('the byte and line counts cover the whole stream', () => {
    const stats = counted.stats();
    assert.equal(stats.totalBytes, 5);
    assert.equal(stats.totalLines, 3);
    assert.equal(counted.text(), 'a\nb\nc');
  });

  // The file on disk is the stream, byte for byte.
  const raw = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a, 0x41, 0xe2, 0x82]);
  const verbatim = spool('verbatim.log');
  verbatim.append(raw);
  verbatim.finish();
  check('the spool file holds the raw bytes, invalid UTF-8 included', () => {
    assert.deepEqual(readFileSync(path.join(directory, 'verbatim.log')), raw);
  });
  check('the preview decodes the invalid bytes instead of losing them', () => {
    assert.ok(verbatim.text().includes('\uFFFD'));
    assert.equal(verbatim.stats().totalBytes, raw.length);
  });

  // The spool stops at its cap and says so.
  const capped = spool('capped.log', { ...LIMITS, maxSpoolBytes: 10 });
  capped.append(Buffer.from('0123456789abcdefghij'));
  capped.finish();
  check('the spool cap stops the write and is reported', () => {
    assert.equal(capped.stats().spoolTruncated, true);
    assert.equal(capped.stats().totalBytes, 20);
    assert.equal(readFileSync(path.join(directory, 'capped.log')).length, 10);
  });

  // Disposing twice must not throw.
  const disposable = spool('disposable.log');
  disposable.append(Buffer.from('bye\n'));
  disposable.finish();
  check('dispose is idempotent', () => {
    disposable.dispose();
    disposable.dispose();
    assert.equal(readFileSync(path.join(directory, 'disposable.log')).toString('utf8'), 'bye\n');
  });

  // With the spill off nothing is written and the capture is the old one.
  const off = spool('off.log', LIMITS, false);
  off.append(Buffer.from('hello\nworld\n'));
  off.finish();
  check('a disabled spool writes nothing', () => {
    assert.equal(off.stats().spoolPath, null);
    assert.equal(existsSync(path.join(directory, 'off.log')), false);
  });
  check('a disabled spool captures exactly like the bounded capture', () => {
    const legacy = new BoundedOutput();
    legacy.append(Buffer.from('hello\nworld\n'));
    legacy.finish();
    assert.equal(off.text(), legacy.text());
    assert.equal(off.stats().truncated, legacy.truncated);
  });

  // The cwd probe is emitted last, so the tail has to keep it.
  const probe = spool('probe.log');
  probe.append(Buffer.from(`${'x'.repeat(500)}\n`));
  probe.append(Buffer.from('__LOCOPILOT_WORKDIR_abc__:/tmp/work\n'));
  probe.finish();
  check('the trailing cwd probe survives in the tail', () => {
    assert.ok(probe.preview().tail.includes('__LOCOPILOT_WORKDIR_abc__:/tmp/work'));
    assert.ok(probe.text().includes('__LOCOPILOT_WORKDIR_abc__:/tmp/work'));
  });

  // The timeout path hands the model a snapshot of a command that is still
  // running, so the newest partial line has to be visible before it ends.
  const flushed = spool('flushed.log');
  flushed.append(Buffer.from('a\nb\n'));
  flushed.append(Buffer.from('partial-line'));
  flushed.flush();
  check('a flushed partial line is visible before it completes', () => {
    assert.ok(flushed.text().endsWith('partial-line'));
    assert.equal(flushed.text().match(/partial-line/g)?.length, 1);
  });
  flushed.append(Buffer.from('-done\n'));
  check('the flushed partial is replaced, not repeated, when the line completes', () => {
    assert.equal(flushed.text().match(/partial-line/g)?.length, 1);
    assert.ok(flushed.text().endsWith('partial-line-done\n'));
  });
  flushed.finish();
  check('a finished spool keeps the whole line exactly once', () => {
    assert.equal(flushed.text().match(/partial-line/g)?.length, 1);
    assert.ok(flushed.text().endsWith('partial-line-done\n'));
  });
} finally {
  // The scratch directory is removed whether the checks passed or failed, so
  // a failure cannot leave anything behind in the temporary directory.
  rmSync(directory, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
