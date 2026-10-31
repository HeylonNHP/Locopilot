#!/usr/bin/env node
/**
 * Focused checks for the redaction of secrets in command output.
 *
 * Run with: npx tsx scripts/test-output-redaction.mjs
 *
 * A secret that reaches the model, the UI or the disk is a secret that has
 * leaked. These checks pin the three things that matter: every pattern is
 * caught, ordinary output is left alone, and the bytes on disk are the
 * redacted ones — not the raw ones. The last check is the chaos one: a
 * hundred megabytes of output must not slow the capture down, lose a byte
 * or grow the preview beyond its budget.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isRunOutputSpillEnabled, OutputSpool } from '../src/tools/outputSpool.ts';
import { redact, REDACTED, SecretRedactor } from '../src/tools/textSanitizer.ts';

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

/**
 * Asserts that a secret is gone from the redacted text and that the marker
 * took its place.
 */
function assertRedacted(label, secret, text) {
  const result = redact(text);
  assert.ok(
    !result.includes(secret),
    `${label}: the secret survived redaction (${JSON.stringify(result)})`
  );
  assert.ok(result.includes(REDACTED), `${label}: the marker is missing`);
}

console.log('run_command output redaction');

const directory = mkdtempSync(path.join(tmpdir(), 'locopilot-redaction-'));

// ── The patterns ─────────────────────────────────────────────────────────
const PATTERNS = [
  {
    label: 'an Authorization header',
    secret: 'ey' + 'jhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
    text: 'Authorization: Bearer ey' + 'jhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
  },
  {
    label: 'a bare bearer token',
    secret: 'abcdef0123456789',
    text: 'calling the api with Bearer abcdef0123456789 now',
  },
  {
    label: 'a JSON web token',
    secret: 'ey' + 'jhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
    text: 'the token was ey' + 'jhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop and then',
  },
  {
    label: 'an sk- key',
    secret: 'sk' + '-abcdefghijklmnopqrstuvwxyz0123456789',
    text: 'OPENAI_API_KEY=sk' + '-abcdefghijklmnopqrstuvwxyz0123456789',
  },
  {
    label: 'a Slack bot token',
    secret: 'xox' + 'b-123456789012-1234567890123-abcdefghijklmnopqrstuvwx',
    text: 'slack said xox' + 'b-123456789012-1234567890123-abcdefghijklmnopqrstuvwx',
  },
  {
    label: 'a GitHub personal token',
    secret: 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789',
    text: 'git push with ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789',
  },
  {
    label: 'a GitHub fine-grained token',
    secret: 'github' + '_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890',
    text: 'git push with github' + '_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890',
  },
  {
    label: 'a GitLab token',
    secret: 'glpat-abcdefghijklmnopqrst',
    text: 'gitlab wants glpat-abcdefghijklmnopqrst',
  },
  {
    label: 'a secret in a query string',
    secret: 'hunter2',
    text: 'https://example.com/login?secret=hunter2&user=joe',
  },
  {
    label: 'a token assignment',
    secret: 'abc123',
    text: 'token=abc123',
  },
  {
    label: 'a password assignment',
    secret: 'hunter2',
    text: 'password=hunter2',
  },
  {
    label: 'an api_key assignment',
    secret: 'abcdefghijklmnop',
    text: 'api_key=abcdefghijklmnop',
  },
  {
    label: 'an apiKey assignment',
    secret: 'abcdefghijklmnop',
    text: 'apiKey=abcdefghijklmnop',
  },
  {
    label: 'a private key block',
    secret: 'MIIEowIBAAKCAQEAsupersecretkeymaterial',
    text: [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAsupersecretkeymaterial',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n'),
  },
];

for (const pattern of PATTERNS) {
  check(`${pattern.label} is redacted`, () => {
    assertRedacted(pattern.label, pattern.secret, pattern.text);
  });
}

check('the redaction is case insensitive', () => {
  const result = redact('AUTHORIZATION: BEARER abcdef0123456789');
  assert.ok(!result.includes('abcdef0123456789'));
  assert.ok(result.includes(REDACTED));
});

check('the label survives so the model knows what leaked', () => {
  const result = redact('api_key=abcdefghijklmnop');
  assert.ok(result.includes('api_key='));
  assert.ok(result.includes(REDACTED));
});

// ── Ordinary text ────────────────────────────────────────────────────────
const ORDINARY = [
  'normal output with no secrets at all',
  'the disk-file was written at /tmp/x',
  'task_id=42 finished',
  'a bearer of bad news',
  'TOKEN_COUNT=5',
  'secretary=smith',
  'https://example.com/path?page=2',
];

for (const text of ORDINARY) {
  check(`ordinary text is untouched: ${JSON.stringify(text)}`, () => {
    assert.equal(redact(text), text);
  });
}

// ── The streaming redactor ──────────────────────────────────────────────
check('a secret split across two chunks is still redacted', () => {
  const redactor = new SecretRedactor();
  const first = redactor.append(Buffer.from('Authorization: Bearer super-sec'));
  const second = redactor.append(Buffer.from('ret-value\n'));
  const output = first.toString('utf8') + second.toString('utf8');
  assert.ok(!output.includes('super-secret-value'));
  assert.ok(output.includes(REDACTED));
});

check('a key block spread over several lines is redacted', () => {
  const redactor = new SecretRedactor();
  let text = '';
  for (const chunk of [
    '-----BEGIN OPENSSH PRIVATE KEY-----\n',
    'b3BlbnNzaC1rZXktdjEAAAAA\n',
    '-----END OPENSSH PRIVATE KEY-----\n',
  ]) {
    text += redactor.append(Buffer.from(chunk)).toString('utf8');
  }
  assert.ok(!text.includes('b3BlbnNzaC1rZXktdjEAAAAA'));
  assert.ok(text.includes(REDACTED));
});

check('the bytes that are not part of a secret survive', () => {
  const redactor = new SecretRedactor();
  const raw = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]);
  const output = redactor.append(raw);
  assert.deepEqual(output, raw);
});

// ── The switch ───────────────────────────────────────────────────────────
check('the spill is on by default', () => {
  delete process.env.LOCOPILOT_RUN_OUTPUT_SPILL;
  assert.equal(isRunOutputSpillEnabled(), true);
});

check('the spill can be turned off', () => {
  for (const value of ['0', 'false', 'FALSE', 'off', 'no']) {
    process.env.LOCOPILOT_RUN_OUTPUT_SPILL = value;
    assert.equal(isRunOutputSpillEnabled(), false, `${value} should turn it off`);
  }
  for (const value of ['1', 'true', 'yes', 'on']) {
    process.env.LOCOPILOT_RUN_OUTPUT_SPILL = value;
    assert.equal(isRunOutputSpillEnabled(), true, `${value} should keep it on`);
  }
  delete process.env.LOCOPILOT_RUN_OUTPUT_SPILL;
});

check('a switched-off spool keeps the pre-commit behaviour', () => {
  const off = new OutputSpool({
    limits: {
      inlineMaxBytes: 64,
      headMaxBytes: 100,
      tailMaxBytes: 40,
      maxSpoolBytes: 1024,
    },
    directory,
    name: 'off.log',
    enabled: false,
  });
  off.append(Buffer.from('token=supersecretvalue\n'));
  off.finish();
  // The old bounded capture: nothing is redacted, nothing is written.
  assert.ok(off.text().includes('supersecretvalue'));
  assert.equal(off.stats().spoolPath, null);
});

// ── The artifact on disk ─────────────────────────────────────────────────
check('a redacted secret does not survive in the artifact', () => {
  const spool = new OutputSpool({
    limits: {
      inlineMaxBytes: 1024,
      headMaxBytes: 1024,
      tailMaxBytes: 1024,
      maxSpoolBytes: 1024 * 1024,
    },
    directory,
    name: 'secret.log',
    enabled: true,
  });
  spool.append(Buffer.from('token=supersecretvalue\n'));
  spool.append(Buffer.from('and more output\n'));
  spool.finish();

  const artifact = readFileSync(path.join(directory, 'secret.log'), 'utf8');
  assert.ok(!artifact.includes('supersecretvalue'), 'the secret reached the disk');
  assert.ok(artifact.includes(REDACTED));
  assert.ok(artifact.includes('and more output'));
  assert.ok(!spool.text().includes('supersecretvalue'));
});

// ── A huge single line ──────────────────────────────────────────────────
check('the rules stay fast on a 10 MB single line', () => {
  const huge = 'x'.repeat(10 * 1024 * 1024);
  const started = Date.now();
  const result = redact(huge);
  const elapsed = Date.now() - started;
  assert.equal(result.length, huge.length);
  // No absolute timing assertion — the point is that the call RETURNS
  // instead of grinding through an exponential number of states.
  console.log(`        10 MB line redacted in ${elapsed} ms`);
});

check('a hostile 10 MB line stays fast too', () => {
  const huge = 'eyJ'.repeat((10 * 1024 * 1024) / 3);
  const started = Date.now();
  const result = redact(huge);
  const elapsed = Date.now() - started;
  assert.ok(result.length > 0);
  console.log(`        10 MB of "eyJ" redacted in ${elapsed} ms`);
});

// ── Chaos: a hundred megabytes of output ────────────────────────────────
check('a hundred megabytes of output stay correct and bounded', () => {
  const chaosDirectory = mkdtempSync(path.join(tmpdir(), 'locopilot-chaos-'));
  const limits = {
    inlineMaxBytes: 8 * 1024,
    headMaxBytes: 64 * 1024,
    tailMaxBytes: 16 * 1024,
    maxSpoolBytes: 32 * 1024 * 1024,
  };
  const spool = new OutputSpool({
    limits,
    directory: chaosDirectory,
    name: 'chaos.log',
    enabled: true,
  });

  const chunkCount = 100;
  const line = `${'payload '.repeat(16)}line\n`;
  const chunk = Buffer.from(line.repeat(Math.ceil((1024 * 1024) / line.length)));
  const started = Date.now();
  for (let index = 0; index < chunkCount; index += 1) {
    // The chunk is built once and reused: the test must not hold a hundred
    // megabytes of its own.
    spool.append(chunk);
  }
  spool.finish();
  const elapsed = Date.now() - started;

  const stats = spool.stats();
  const written = chunk.length * chunkCount;
  assert.equal(stats.totalBytes, written);
  assert.equal(stats.totalLines, written / line.length);
  assert.equal(stats.truncated, true);
  assert.equal(stats.spoolTruncated, true);

  const artifactBytes = statSync(path.join(chaosDirectory, 'chaos.log')).size;
  assert.equal(artifactBytes, limits.maxSpoolBytes);

  const preview = spool.preview();
  assert.ok(preview.head.startsWith('payload payload'), 'the head was lost');
  assert.ok(preview.tail.endsWith('line\n'), 'the tail was lost');
  assert.ok(
    Buffer.byteLength(preview.head, 'utf8') <= limits.headMaxBytes,
    'the head grew past its budget'
  );
  assert.ok(
    Buffer.byteLength(preview.tail, 'utf8') <= limits.tailMaxBytes,
    'the tail grew past its budget'
  );

  console.log(`        100 MB captured in ${elapsed} ms`);
  rmSync(chaosDirectory, { recursive: true, force: true });
});

rmSync(directory, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
