/**
 * Focused checks for the run_command output spool.
 *
 * The spool is the difference between a truncated capture and a lost one: the
 * preview the model reads is bounded, the bytes on disk are not. These checks
 * pin both halves — the preview stays inside its budget and lands on line
 * boundaries, and the file holds the stream byte for byte, invalid UTF-8
 * included.
 */

import { afterAll, describe, expect, test } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BoundedOutput } from '../src/tools/boundedOutput.ts';
import { OutputSpool } from '../src/tools/outputSpool.ts';

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

// The scratch directory is removed whether the tests pass or fail, so a failure
// cannot leave anything behind in the temporary directory.
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('run_command output spool', () => {
  describe('a stream that fits the inline budget', () => {
    const small = spool('small.log');
    small.append(Buffer.from('hello\nworld\n'));
    small.finish();

    test('is returned verbatim', () => {
      expect(small.text()).toBe('hello\nworld\n');
      expect(small.stats().truncated).toBe(false);
      expect(small.stats().omittedBytes).toBe(0);
      expect(small.stats().totalBytes).toBe(12);
      expect(small.stats().totalLines).toBe(2);
    });
  });

  describe('a stream that does not fit', () => {
    const lines = Array.from(
      { length: 20 },
      (_, index) => `line-${String(index).padStart(2, '0')}\n`
    );
    const whole = lines.join('');
    const big = spool('big.log');
    for (const line of lines) big.append(Buffer.from(line));
    big.finish();

    test('is split into a head and a tail', () => {
      const preview = big.preview();
      // The head is the BEGINNING of the stream and the tail is its END.
      // That is the property that matters; WHICH lines they are is an
      // implementation detail of the head/tail algorithm.
      expect(preview.head.length).toBeGreaterThan(0);
      expect(preview.tail.length).toBeGreaterThan(0);
      expect(whole.startsWith(preview.head)).toBe(true);
      expect(whole.endsWith(preview.tail)).toBe(true);
      // What is left out is a MIDDLE: the two halves never overlap.
      expect(preview.head.length + preview.tail.length).toBeLessThanOrEqual(whole.length);
      // And no line is shown twice.
      const shown = [...preview.head.split('\n'), ...preview.tail.split('\n')].filter(Boolean);
      expect(new Set(shown).size).toBe(shown.length);
      // The model reads the excerpt as one text.
      expect(big.text()).toBe(preview.head + preview.tail);
    });

    test('reports the omitted middle', () => {
      const stats = big.stats();
      const preview = big.preview();
      const shown =
        Buffer.byteLength(preview.head, 'utf8') + Buffer.byteLength(preview.tail, 'utf8');
      // The bytes the model does NOT see are exactly the ones that are
      // counted as omitted, whatever the head/tail algorithm decides to keep.
      expect(stats.totalBytes - shown).toBe(stats.omittedBytes);
      expect(stats.omittedBytes).toBeGreaterThan(0);
      expect(stats.truncated).toBe(true);
      expect(stats.totalBytes).toBe(160);
      expect(stats.totalLines).toBe(20);
    });

    test('cuts the head and tail on line boundaries', () => {
      const preview = big.preview();
      expect(preview.head.endsWith('\n')).toBe(true);
      for (const line of preview.head.split('\n').slice(0, -1)) {
        expect(line).toMatch(/^line-\d\d$/);
      }
      for (const line of preview.tail.split('\n').slice(0, -1)) {
        expect(line).toMatch(/^line-\d\d$/);
      }
    });

    test('keeps the preview inside its byte budget', () => {
      const preview = big.preview();
      expect(Buffer.byteLength(preview.head, 'utf8')).toBeLessThanOrEqual(LIMITS.headMaxBytes);
      expect(Buffer.byteLength(preview.tail, 'utf8')).toBeLessThanOrEqual(LIMITS.tailMaxBytes);
    });

    test('holds every byte of the stream in the file on disk', () => {
      expect(readFileSync(path.join(directory, 'big.log'), 'utf8')).toBe(whole);
      expect(readFileSync(path.join(directory, 'big.log'))).toHaveLength(big.stats().totalBytes);
    });
  });

  test('the byte and line counts describe the whole stream, not the part that was kept', () => {
    const counted = spool('counted.log');
    counted.append(Buffer.from('a\nb\n'));
    counted.append(Buffer.from('c'));
    counted.finish();

    const stats = counted.stats();
    expect(stats.totalBytes).toBe(5);
    expect(stats.totalLines).toBe(3);
    expect(counted.text()).toBe('a\nb\nc');
  });

  describe('a stream with invalid UTF-8', () => {
    // The file on disk is the stream, byte for byte.
    const raw = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a, 0x41, 0xe2, 0x82]);
    const verbatim = spool('verbatim.log');
    verbatim.append(raw);
    verbatim.finish();

    test('lands in the spool file as the raw bytes', () => {
      expect(readFileSync(path.join(directory, 'verbatim.log'))).toStrictEqual(raw);
    });

    test('is decoded in the preview instead of being lost', () => {
      expect(verbatim.text()).toContain('\uFFFD');
      expect(verbatim.stats().totalBytes).toBe(raw.length);
    });
  });

  test('the spool stops at its cap and says so', () => {
    const capped = spool('capped.log', { ...LIMITS, maxSpoolBytes: 10 });
    capped.append(Buffer.from('0123456789abcdefghij'));
    capped.finish();

    expect(capped.stats().spoolTruncated).toBe(true);
    expect(capped.stats().totalBytes).toBe(20);
    expect(readFileSync(path.join(directory, 'capped.log'))).toHaveLength(10);
  });

  test('disposing twice does not throw', () => {
    const disposable = spool('disposable.log');
    disposable.append(Buffer.from('bye\n'));
    disposable.finish();

    disposable.dispose();
    disposable.dispose();
    expect(readFileSync(path.join(directory, 'disposable.log')).toString('utf8')).toBe('bye\n');
  });

  describe('with the spill switched off', () => {
    // Nothing is written and the capture is the old one.
    const off = spool('off.log', LIMITS, false);
    off.append(Buffer.from('hello\nworld\n'));
    off.finish();

    test('nothing is written', () => {
      expect(off.stats().spoolPath).toBeNull();
      expect(existsSync(path.join(directory, 'off.log'))).toBe(false);
    });

    test('the capture is exactly the bounded capture', () => {
      const legacy = new BoundedOutput();
      legacy.append(Buffer.from('hello\nworld\n'));
      legacy.finish();
      expect(off.text()).toBe(legacy.text());
      expect(off.stats().truncated).toBe(legacy.truncated);
    });
  });

  test('the trailing cwd probe survives in the tail', () => {
    // The cwd probe is emitted last, so the tail has to keep it.
    const probe = spool('probe.log');
    probe.append(Buffer.from(`${'x'.repeat(500)}\n`));
    probe.append(Buffer.from('__LOCOPILOT_WORKDIR_abc__:/tmp/work\n'));
    probe.finish();

    expect(probe.preview().tail).toContain('__LOCOPILOT_WORKDIR_abc__:/tmp/work');
    expect(probe.text()).toContain('__LOCOPILOT_WORKDIR_abc__:/tmp/work');
  });

  // The timeout path hands the model a snapshot of a command that is still
  // running, so the newest partial line has to be visible before it ends. These
  // tests walk one spool through the life of that command, in order.
  describe('a command that is still running', () => {
    const flushed = spool('flushed.log');
    flushed.append(Buffer.from('a\nb\n'));
    flushed.append(Buffer.from('partial-line'));
    flushed.flush();

    test('shows a flushed partial line before it completes', () => {
      expect(flushed.text().endsWith('partial-line')).toBe(true);
      expect(flushed.text().match(/partial-line/g)).toHaveLength(1);
    });

    test('replaces the flushed partial, rather than repeating it, when the line completes', () => {
      flushed.append(Buffer.from('-done\n'));
      expect(flushed.text().match(/partial-line/g)).toHaveLength(1);
      expect(flushed.text().endsWith('partial-line-done\n')).toBe(true);
    });

    test('keeps the whole line exactly once once the spool is finished', () => {
      flushed.finish();
      expect(flushed.text().match(/partial-line/g)).toHaveLength(1);
      expect(flushed.text().endsWith('partial-line-done\n')).toBe(true);
    });
  });
});
