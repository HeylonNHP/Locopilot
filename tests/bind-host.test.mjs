/**
 * Unit tests for scripts/bindHost.mjs (the LOCOPILOT_HOST parser).
 *
 * No network, no server, no dependencies: a pure import and one call per case.
 */
import { describe, expect, test } from '@jest/globals';

import { describeBindHost, parseBindHost } from '../scripts/bindHost.mjs';

describe('parseBindHost', () => {
  test.each([undefined, null, '', '   ', '""', "''", '  ""  '])(
    'a blank value (%j) keeps the default (null)',
    (raw) => {
      expect(parseBindHost(raw)).toBeNull();
    }
  );

  test.each([
    ['127.0.0.1', '127.0.0.1'],
    ['0.0.0.0', '0.0.0.0'],
    ['::1', '::1'],
    ['::', '::'],
    ['fe80::1', 'fe80::1'],
    ['my-host.local', 'my-host.local'],
    ['  "127.0.0.1"  ', '127.0.0.1'],
    ['127.0.0.1 ', '127.0.0.1'],
    ["'localhost'", 'localhost'],
  ])('a valid host (%j) passes through, trimmed and unquoted, as %j', (raw, expected) => {
    expect(parseBindHost(raw)).toBe(expected);
  });

  test.each(['foo bar', '[::1]', '-p', '; touch /tmp/x', 'a\tb', 'a&b', 'a|b', 'host/name'])(
    'a malformed value (%j) fails fast',
    (raw) => {
      expect(() => parseBindHost(raw)).toThrow();
    }
  );
});

describe('describeBindHost', () => {
  test('describes the default as the wildcard', () => {
    expect(describeBindHost(null)).toBe('0.0.0.0 / all interfaces');
  });

  test('returns a given host as it is', () => {
    expect(describeBindHost('127.0.0.1')).toBe('127.0.0.1');
  });
});
