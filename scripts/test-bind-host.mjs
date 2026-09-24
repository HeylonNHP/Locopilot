#!/usr/bin/env node
/**
 * Unit tests for scripts/bindHost.mjs (the LOCOPILOT_HOST parser).
 *
 * Run with: node scripts/test-bind-host.mjs
 *
 * No network, no server, no dependencies. Pure import plus assert helpers,
 * PASS/FAIL per case, exit 1 on any failure — mirrors the other
 * `scripts/test-*.mjs` harnesses.
 */
import { describeBindHost, parseBindHost } from './bindHost.mjs';

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message}`);
    fail += 1;
  }
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function assertThrows(fn, label) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`${label}: expected parseBindHost to throw`);
}

// --- unset / blank variants keep the default (null) ---
for (const raw of [undefined, null, '', '   ', '""', "''", '  ""  ']) {
  check(`blank ${JSON.stringify(raw)} -> null`, () => assertEqual(parseBindHost(raw), null));
}

// --- valid hosts pass through (trimmed / unquoted) ---
const valid = [
  ['127.0.0.1', '127.0.0.1'],
  ['0.0.0.0', '0.0.0.0'],
  ['::1', '::1'],
  ['::', '::'],
  ['fe80::1', 'fe80::1'],
  ['my-host.local', 'my-host.local'],
  ['  "127.0.0.1"  ', '127.0.0.1'],
  ['127.0.0.1 ', '127.0.0.1'],
  ["'localhost'", 'localhost'],
];
for (const [raw, expected] of valid) {
  check(`valid ${JSON.stringify(raw)} -> ${expected}`, () =>
    assertEqual(parseBindHost(raw), expected)
  );
}

// --- malformed values fail fast ---
const invalid = ['foo bar', '[::1]', '-p', '; touch /tmp/x', 'a\tb', 'a&b', 'a|b', 'host/name'];
for (const raw of invalid) {
  check(`invalid ${JSON.stringify(raw)} throws`, () => assertThrows(() => parseBindHost(raw), raw));
}

// --- describeBindHost ---
check('describeBindHost(null) describes wildcard', () =>
  assertEqual(describeBindHost(null), '0.0.0.0 / all interfaces')
);
check('describeBindHost("127.0.0.1") returns the host', () =>
  assertEqual(describeBindHost('127.0.0.1'), '127.0.0.1')
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
