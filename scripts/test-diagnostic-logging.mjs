#!/usr/bin/env node
import { redactDiagnosticEndpoint } from '../src/app/lib/debugLogger.ts';

let failures = 0;
function assertEqual(actual, expected, label) {
  if (actual === expected) {
    console.log(`PASS ${label}`);
  } else {
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
    failures += 1;
  }
}

assertEqual(
  redactDiagnosticEndpoint('https://provider.example/v1/responses?api_key=secret'),
  'https://provider.example',
  'redacts endpoint path and query'
);
assertEqual(redactDiagnosticEndpoint('not-a-url'), '[invalid-endpoint]', 'marks invalid endpoint');
assertEqual(redactDiagnosticEndpoint(undefined), undefined, 'omits missing endpoint');

if (failures > 0) process.exit(1);
console.log('Diagnostic logging checks passed.');
