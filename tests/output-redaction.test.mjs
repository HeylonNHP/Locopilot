/**
 * Focused checks for the redaction of secrets in command output.
 *
 * A secret that reaches the model, the UI or the disk is a secret that has
 * leaked. These checks pin the three things that matter: every pattern is
 * caught, ordinary output is left alone, and the bytes on disk are the
 * redacted ones — not the raw ones. The last check is the chaos one: a
 * hundred megabytes of output must not slow the capture down, lose a byte
 * or grow the preview beyond its budget.
 */

import { afterAll, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isRunOutputSpillEnabled, OutputSpool } from '../src/tools/outputSpool.ts';
import { redact, REDACTED, SecretRedactor } from '../src/tools/textSanitizer.ts';

/**
 * Asserts that a secret is gone from the redacted text and that the marker
 * took its place.
 */
function assertRedacted(label, secret, text) {
  const result = redact(text);
  expect(result).not.toContain(secret);
  expect(result).toContain(REDACTED);
}

describe('run_command output redaction', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'locopilot-redaction-'));

  // The scratch directory is removed whether the tests passed or failed.
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  // ── The patterns ───────────────────────────────────────────────────────
  const PATTERNS = [
    {
      label: 'an Authorization header',
      secret: 'ey' + 'JhbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'JzdWIiOiIxIn0' + '.' + 'abcdefghijklmnop',
      text:
        'Authorization: Bearer ' +
        'ey' +
        'JhbGciOiJIUzI1NiJ9.' +
        'ey' +
        'JzdWIiOiIxIn0' +
        '.' +
        'abcdefghijklmnop',
    },
    {
      label: 'a bare bearer token',
      secret: 'abcdef0123456789',
      text: 'calling the api with Bearer abcdef0123456789 now',
    },
    {
      label: 'a JSON web token',
      secret: 'ey' + 'JhbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'JzdWIiOiIxIn0' + '.' + 'abcdefghijklmnop',
      text:
        'the token was ' +
        'ey' +
        'JhbGciOiJIUzI1NiJ9.' +
        'ey' +
        'JzdWIiOiIxIn0' +
        '.' +
        'abcdefghijklmnop' +
        ' and then',
    },
    {
      label: 'an sk- key',
      secret: 'sk-' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789',
      text: 'OPENAI_API_KEY=' + 'sk-' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789',
    },
    {
      label: 'a Slack bot token',
      secret: 'xo' + 'xb-123456789012-1234567890123' + '-abcdefghijklmnopqrstuvwx',
      text: 'slack said xo' + 'xb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx',
    },
    {
      label: 'a GitHub personal token',
      secret: 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789',
      text: 'git push with gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789',
    },
    {
      label: 'a GitHub fine-grained token',
      secret: 'github_' + 'pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890',
      text: 'git push with github' + '_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890',
    },
    {
      label: 'a GitLab token',
      secret: 'gl' + 'pat-abcdefghijklmnopqrst',
      text: 'gitlab wants gl' + 'pat-abcdefghijklmnopqrst',
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
    // ── Prefixed assignments and URL credentials ──────────────────────────
    // The rule anchored on `\b` and required the secret word to START the
    // variable, and `_` is a word character — so every `SOMETHING_PASSWORD=`
    // went through untouched. These are the shapes the model actually sees in
    // a `.env` or a compose file.
    {
      label: 'a DB_PASSWORD assignment',
      secret: 'hunter2',
      text: 'DB_PASSWORD=hunter2',
    },
    {
      label: 'a MYSQL_ROOT_PASSWORD assignment',
      secret: 's3cr' + 'etvalue',
      text: 'MYSQL_ROOT_PASSWORD=s3cr' + 'etvalue',
    },
    {
      label: 'a MY_API_KEY assignment',
      secret: 'abcdefghijkl' + 'mnopqrst',
      text: 'MY_API_KEY=abcdefghijkl' + 'mnopqrst',
    },
    {
      label: 'a DB_PASSWORD entry in YAML',
      secret: 'hunter2',
      text: 'DB_PASSWORD: hunter2',
    },
    {
      label: 'a password embedded in a DATABASE_URL',
      secret: 'hunter2',
      text: 'DATABASE_URL=postgres://app:hunter2@db.example.com:5432/app',
    },
    {
      label: 'a password in a URL with no user name',
      secret: 'topsecret',
      text: 'redis://:topsecret@cache:6379',
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
    test(`${pattern.label} is redacted`, () => {
      assertRedacted(pattern.label, pattern.secret, pattern.text);
    });
  }
  test('the redaction is case insensitive', () => {
    const result = redact('AUTHORIZATION: BEARER abcdef0123456789');
    expect(result).not.toContain('abcdef0123456789');
    expect(result).toContain(REDACTED);
  });

  test('the label survives so the model knows what leaked', () => {
    const result = redact('api_key=abcdefghijklmnop');
    expect(result).toContain('api_key=');
    expect(result).toContain(REDACTED);
  });

  test('a prefixed assignment keeps its whole label', () => {
    // The prefix is matched, not eaten: the model still learns WHICH variable
    // was set, which is the difference between "a secret leaked" and
    // "DB_PASSWORD leaked".
    const result = redact('MY_API_KEY=abcdefghijklmnop');
    expect(result).toBe(`MY_API_KEY=${REDACTED}`);
    expect(redact('DB_PASSWORD=hunter2')).toBe(`DB_PASSWORD=${REDACTED}`);
    expect(redact('MYSQL_ROOT_PASSWORD=s3cretvalue')).toBe(`MYSQL_ROOT_PASSWORD=${REDACTED}`);
  });

  test('a URL credential keeps the scheme, the user and the host', () => {
    const result = redact('DATABASE_URL=postgres://app:hunter2@db.example.com:5432/app');
    expect(result).not.toContain('hunter2');
    expect(result).toContain('postgres://app:');
    expect(result).toContain('@db.example.com:5432/app');
    // A URL with no `@`, or with no password, is not a credential and stays.
    expect(redact('https://example.com/path')).toBe('https://example.com/path');
    expect(redact('https://user@example.com/x')).toBe('https://user@example.com/x');
  });

  // ── Ordinary text ────────────────────────────────────────────────────────
  const ORDINARY = [
    'normal output with no secrets at all',
    'the disk-file was written at /tmp/x',
    'task_id=42 finished',
    'a bearer of bad news',
    'TOKEN_COUNT=5',
    // The prefix rule must not turn into a sledgehammer: a COUNT is not a
    // credential, and `_` after the word is not a separator.
    'MY_TOKEN_COUNT=5',
    'MAX_PASSWORD_LENGTH=64',
    'secretary=smith',
    'https://example.com/path?page=2',
  ];

  for (const text of ORDINARY) {
    test(`ordinary text is untouched: ${JSON.stringify(text)}`, () => {
      expect(redact(text)).toBe(text);
    });
  }

  // ── The streaming redactor ──────────────────────────────────────────────
  test('a secret split across two chunks is still redacted', () => {
    const redactor = new SecretRedactor();
    const first = redactor.append(Buffer.from('Authorization: Bearer super-sec'));
    const second = redactor.append(Buffer.from('ret-value\n'));
    const output = first.toString('utf8') + second.toString('utf8');
    expect(output).not.toContain('super-secret-value');
    expect(output).toContain(REDACTED);
  });

  test('a key block spread over several lines is redacted', () => {
    const redactor = new SecretRedactor();
    let text = '';
    for (const chunk of [
      '-----BEGIN OPENSSH PRIVATE KEY-----\n',
      'b3BlbnNzaC1rZXktdjEAAAAA\n',
      '-----END OPENSSH PRIVATE KEY-----\n',
    ]) {
      text += redactor.append(Buffer.from(chunk)).toString('utf8');
    }
    expect(text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
    expect(text).toContain(REDACTED);
  });

  test('the bytes that are not part of a secret survive', () => {
    const redactor = new SecretRedactor();
    const raw = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]);
    const output = redactor.append(raw);
    expect(output).toStrictEqual(raw);
  });

  // ── The switch ───────────────────────────────────────────────────────────
  test('the spill is on by default', () => {
    delete process.env.LOCOPILOT_RUN_OUTPUT_SPILL;
    expect(isRunOutputSpillEnabled()).toBe(true);
  });

  test('the spill can be turned off', () => {
    for (const value of ['0', 'false', 'FALSE', 'off', 'no']) {
      process.env.LOCOPILOT_RUN_OUTPUT_SPILL = value;
      expect(isRunOutputSpillEnabled()).toBe(false);
    }
    for (const value of ['1', 'true', 'yes', 'on']) {
      process.env.LOCOPILOT_RUN_OUTPUT_SPILL = value;
      expect(isRunOutputSpillEnabled()).toBe(true);
    }
    delete process.env.LOCOPILOT_RUN_OUTPUT_SPILL;
  });

  test('a switched-off spool keeps the bounded capture and still redacts', () => {
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
    // The switch decides whether the bytes are ALSO written to a file. It
    // does NOT decide whether they are redacted: a secret that reaches the
    // model has leaked, whether it was written to the disk or not.
    expect(off.text()).not.toContain('supersecretvalue');
    expect(off.text()).toContain(REDACTED);
    // Nothing was written to the disk, which is what the switch is for.
    expect(off.stats().spoolPath).toBeNull();
  });

  // ── The artifact on disk ─────────────────────────────────────────────────
  test('a redacted secret does not survive in the artifact', () => {
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
    expect(artifact).not.toContain('supersecretvalue');
    expect(artifact).toContain(REDACTED);
    expect(artifact).toContain('and more output');
    expect(spool.text()).not.toContain('supersecretvalue');
  });

  // ── A huge single line ──────────────────────────────────────────────────
  test('the rules stay fast on a 10 MB single line', () => {
    const huge = 'x'.repeat(10 * 1024 * 1024);
    const started = Date.now();
    const result = redact(huge);
    const elapsed = Date.now() - started;
    expect(result.length).toBe(huge.length);
    // No absolute timing assertion — the point is that the call RETURNS
    // instead of grinding through an exponential number of states.
    console.log(`        10 MB line redacted in ${elapsed} ms`);
  });

  test('a hostile 10 MB line stays fast too', () => {
    const huge = 'eyJ'.repeat((10 * 1024 * 1024) / 3);
    const started = Date.now();
    const result = redact(huge);
    const elapsed = Date.now() - started;
    expect(result.length).toBeGreaterThan(0);
    console.log(`        10 MB of "eyJ" redacted in ${elapsed} ms`);
  });

  // ── Chaos: a hundred megabytes of output ────────────────────────────────
  test('a hundred megabytes of output stay correct and bounded', () => {
    const chaosDirectory = mkdtempSync(path.join(tmpdir(), 'locopilot-chaos-'));
    try {
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
      expect(stats.totalBytes).toBe(written);
      expect(stats.totalLines).toBe(written / line.length);
      expect(stats.truncated).toBe(true);
      expect(stats.spoolTruncated).toBe(true);

      const artifactBytes = statSync(path.join(chaosDirectory, 'chaos.log')).size;
      expect(artifactBytes).toBe(limits.maxSpoolBytes);

      const preview = spool.preview();
      expect(preview.head.startsWith('payload payload')).toBeTruthy();
      expect(preview.tail.endsWith('line\n')).toBeTruthy();
      expect(Buffer.byteLength(preview.head, 'utf8')).toBeLessThanOrEqual(limits.headMaxBytes);
      expect(Buffer.byteLength(preview.tail, 'utf8')).toBeLessThanOrEqual(limits.tailMaxBytes);

      console.log(`        100 MB captured in ${elapsed} ms`);
    } finally {
      // The chaos directory holds tens of megabytes. It is removed whether
      // the check passed or failed, so a failing assertion cannot leave a
      // large file behind in the temporary directory.
      rmSync(chaosDirectory, { recursive: true, force: true });
    }
  });

  // Redaction can be disabled, but control codes still die
  test('redaction can be disabled without losing escape-code stripping', () => {
    const raw = 'token=sk-abcdefghijklmnopqrstuvwxyz0123456789 and \u001B[31mcolor\u001B[0m';
    const dir2 = mkdtempSync(path.join(tmpdir(), 'locopilot-redaction-off-'));
    try {
      const spool = new OutputSpool({
        limits: {
          inlineMaxBytes: 8 * 1024,
          headMaxBytes: 32 * 1024,
          tailMaxBytes: 8 * 1024,
          maxSpoolBytes: 10 * 1024 * 1024,
        },
        directory: dir2,
        name: 'raw.log',
        enabled: true,
        redactsSecrets: false,
      });
      spool.append(Buffer.from(raw));
      spool.finish();
      expect(spool.text()).toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789');
      expect(spool.text()).not.toContain('[REDACTED]');
      expect(spool.text()).not.toContain('\u001B[31m');
      const artifact = readFileSync(path.join(dir2, 'raw.log'), 'utf8');
      expect(artifact).toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789');
      expect(artifact).not.toContain('[REDACTED]');
      expect(artifact).not.toContain('\u001B[31m');
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
