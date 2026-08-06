#!/usr/bin/env node
/** Focused regression checks for bounded run_command output capture. */

import { RUN_COMMAND_OUTPUT_MAX_BYTES } from '../src/constants.ts';
import { BoundedOutput } from '../src/tools/boundedOutput.ts';
import { sanitize } from '../src/tools/tools.ts';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}`);
    failed += 1;
  }
}

console.log('bounded command output capture');
const small = new BoundedOutput();
small.append(Buffer.from('hello\n'));
small.finish();
assert(small.text() === 'hello\n', 'small output remains exact');
assert(!small.truncated, 'small output is not marked truncated');

const large = new BoundedOutput();
large.append(Buffer.from('x'.repeat(RUN_COMMAND_OUTPUT_MAX_BYTES + 1024)));
large.finish();
assert(Buffer.byteLength(large.text(), 'utf8') <= RUN_COMMAND_OUTPUT_MAX_BYTES, 'large output stays within byte cap');
assert(large.truncated, 'large output is marked truncated');
assert(large.text().endsWith('x'.repeat(1024)), 'large output retains a bounded tail');

const unicode = new BoundedOutput();
const encoded = Buffer.from('😀'.repeat(RUN_COMMAND_OUTPUT_MAX_BYTES));
for (const byte of encoded) unicode.append(Buffer.from([byte]));
unicode.finish();
assert(!unicode.text().includes('�'), 'split multibyte output is not corrupted');
assert(Buffer.byteLength(unicode.text(), 'utf8') <= RUN_COMMAND_OUTPUT_MAX_BYTES, 'unicode output respects byte cap');

assert(sanitize('[31mred[0m\r\n') === 'red\n', 'sanitization remains unchanged');

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
