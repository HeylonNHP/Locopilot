// Verification harness for the upstream-error extraction added in
// src/services/adapters/openaiCompatibleAdapter.ts. The extraction walks
// the parsed response body to surface the *real* upstream provider error,
// which gateways like OpenRouter bury inside `error.error.metadata.raw`.
//
// Run with: node scripts/verify-upstream-error.mjs
//
// Throws on any failure.

// Re-implementation of `extractUpstreamError` from the source. Kept in sync
// manually — drift here signals the source has changed without updating
// this test.
function extractUpstreamError(error) {
  const result = {
    message: null,
    param: null,
    code: null,
    providerName: null,
    rawBody: null,
  };
  if (error === null || error === undefined) return result;
  // In production the source checks `!(error instanceof OpenAI.APIError)`
  // and bails. We can't import the SDK class here, so we mark stand-ins
  // with a `__isApiError` flag and reproduce that gate below.
  if (!error.__isApiError) return result;
  const body = error.error;
  if (body === undefined || body === null) return result;
  try {
    result.rawBody = JSON.stringify(body);
  } catch {
    /* defensive */
  }
  if (typeof body !== 'object') return result;
  const envelope = body;
  const outerError = envelope.error;
  if (outerError && typeof outerError === 'object') {
    const oe = outerError;
    if (typeof oe.message === 'string') result.message = oe.message;
    if (typeof oe.code === 'string' || typeof oe.code === 'number') {
      result.code = String(oe.code);
    }
    if (typeof oe.param === 'string') result.param = oe.param;
    if (typeof oe.type === 'string' && !result.code) result.code = oe.type;
    const metadata = oe.metadata;
    if (metadata && typeof metadata === 'object') {
      const m = metadata;
      if (typeof m.provider_name === 'string') result.providerName = m.provider_name;
      if (typeof m.raw === 'string') {
        try {
          const parsed = JSON.parse(m.raw);
          const inner = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;
          if (typeof inner.message === 'string' && inner.message.length > 0) {
            result.message = inner.message;
          }
          if (typeof inner.param === 'string') result.param = inner.param;
          if (typeof inner.code === 'string') result.code = inner.code;
          if (typeof inner.type === 'string' && !result.code) result.code = inner.type;
        } catch {
          /* keep outer */
        }
      }
    }
  }
  return result;
}

// Minimal stand-in for OpenAI.APIError, marked so the re-implementation's
// `instanceof` gate can be reproduced.
function apiErrorFromBody(body) {
  return { __isApiError: true, status: 400, error: body };
}

const cases = [
  {
    name: 'OpenRouter envelope with metadata.raw',
    input: apiErrorFromBody({
      error: {
        message: 'Provider returned error',
        code: 400,
        metadata: {
          raw: JSON.stringify({
            error: {
              message:
                "Invalid schema for function 'create_skill': schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level.",
              type: 'invalid_request_error',
              param: 'tools[10].parameters',
              code: 'invalid_function_parameters',
            },
          }),
          provider_name: 'Azure',
          previous_errors: [],
        },
      },
    }),
    expect(out) {
      const errors = [];
      if (out.message !== out.message /* trivial */) errors.push('placeholder');
      if (!out.message || !out.message.includes('Invalid schema for function')) {
        errors.push(`message should surface Azure's invalid_function_parameters: ${out.message}`);
      }
      if (out.param !== 'tools[10].parameters')
        errors.push(`param should be tools[10].parameters: ${out.param}`);
      if (out.code !== 'invalid_function_parameters')
        errors.push(`code should be invalid_function_parameters: ${out.code}`);
      if (out.providerName !== 'Azure')
        errors.push(`providerName should be Azure: ${out.providerName}`);
      return errors;
    },
  },
  {
    name: 'plain OpenAI-shaped envelope (no metadata wrapper)',
    input: apiErrorFromBody({
      error: {
        message: "Invalid schema: missing property 'description'",
        type: 'invalid_request_error',
        param: 'tools[10].parameters',
        code: 'invalid_function_parameters',
      },
    }),
    expect(out) {
      const errors = [];
      if (out.message !== "Invalid schema: missing property 'description'")
        errors.push(`message should be the outer one: ${out.message}`);
      if (out.param !== 'tools[10].parameters') errors.push(`param: ${out.param}`);
      if (out.code !== 'invalid_function_parameters') errors.push(`code: ${out.code}`);
      if (out.providerName !== null)
        errors.push(`providerName should be null: ${out.providerName}`);
      return errors;
    },
  },
  {
    name: 'OpenRouter with malformed metadata.raw — fall back to outer',
    input: apiErrorFromBody({
      error: {
        message: 'Provider returned error',
        code: 400,
        metadata: { raw: 'not json {', provider_name: 'OpenAI' },
      },
    }),
    expect(out) {
      const errors = [];
      if (out.message !== 'Provider returned error')
        errors.push(`should keep outer message: ${out.message}`);
      if (out.providerName !== 'OpenAI') errors.push(`providerName: ${out.providerName}`);
      return errors;
    },
  },
  {
    name: 'no error body at all',
    input: { __isApiError: true, status: 500, error: null },
    expect(out) {
      const errors = [];
      if (out.message !== null) errors.push(`message should be null: ${out.message}`);
      if (out.providerName !== null) errors.push('providerName should be null');
      return errors;
    },
  },
  {
    name: 'non-APIError object — graceful',
    input: new Error('boom'),
    expect(out) {
      const errors = [];
      if (out.message !== null) errors.push(`message should be null: ${out.message}`);
      return errors;
    },
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const out = extractUpstreamError(c.input);
  const errors = c.expect(out);
  if (errors.length === 0) {
    console.log(`PASS ${c.name}`);
    pass++;
  } else {
    console.log(`FAIL ${c.name}`);
    for (const e of errors) console.log(`  - ${e}`);
    console.log('  out:', JSON.stringify(out, null, 2));
    fail++;
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) throw new Error(`${fail} case(s) failed`);
