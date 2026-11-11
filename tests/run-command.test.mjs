/** Focused regression checks for bounded run_command output capture. */

import { describe, expect, test } from '@jest/globals';

import { RUN_COMMAND_OUTPUT_MAX_BYTES } from '../src/constants.ts';
import { BoundedOutput } from '../src/tools/boundedOutput.ts';
import { sanitize } from '../src/tools/tools.ts';

describe('bounded command output capture', () => {
  describe('output that fits the cap', () => {
    const small = new BoundedOutput();
    small.append(Buffer.from('hello\n'));
    small.finish();

    test('remains exact', () => {
      expect(small.text()).toBe('hello\n');
    });

    test('is not marked truncated', () => {
      expect(small.truncated).toBe(false);
    });
  });

  describe('output over the cap', () => {
    const large = new BoundedOutput();
    large.append(Buffer.from('x'.repeat(RUN_COMMAND_OUTPUT_MAX_BYTES + 1024)));
    large.finish();

    test('stays within the byte cap', () => {
      expect(Buffer.byteLength(large.text(), 'utf8')).toBeLessThanOrEqual(
        RUN_COMMAND_OUTPUT_MAX_BYTES
      );
    });

    test('is marked truncated', () => {
      expect(large.truncated).toBe(true);
    });

    test('retains a bounded tail', () => {
      expect(large.text().endsWith('x'.repeat(1024))).toBe(true);
    });
  });

  describe('multibyte output delivered one byte at a time', () => {
    const unicode = new BoundedOutput();
    for (const byte of Buffer.from('😀'.repeat(RUN_COMMAND_OUTPUT_MAX_BYTES))) {
      unicode.append(Buffer.from([byte]));
    }
    unicode.finish();

    test('is not corrupted where a character is split', () => {
      expect(unicode.text()).not.toContain('�');
    });

    test('respects the byte cap', () => {
      expect(Buffer.byteLength(unicode.text(), 'utf8')).toBeLessThanOrEqual(
        RUN_COMMAND_OUTPUT_MAX_BYTES
      );
    });
  });

  test('sanitization of terminal colour codes remains unchanged', () => {
    expect(sanitize('\u001B[31mred\u001B[0m\r\n')).toBe('red\n');
  });
});
