import { expect, test } from '@jest/globals';

import { redactDiagnosticEndpoint } from '../src/app/lib/debugLogger.ts';

test.each([
  [
    'redacts endpoint path and query',
    'https://provider.example/v1/responses?api_key=secret',
    'https://provider.example',
  ],
  ['marks invalid endpoint', 'not-a-url', '[invalid-endpoint]'],
  ['omits missing endpoint', undefined, undefined],
])('%s', (_label, input, expected) => {
  expect(redactDiagnosticEndpoint(input)).toBe(expected);
});

// Diagnostic logging checks passed.
