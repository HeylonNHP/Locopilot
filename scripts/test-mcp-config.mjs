#!/usr/bin/env node
/**
 * Regression tests for the audited MCP config fixes F8/F13/F14/F15.
 *
 * Run with: npx tsx scripts/test-mcp-config.mjs
 *
 * Pure unit tests: no network, no live MCP server, no filesystem
 * mutation. The tests only exercise pure helpers and `parseMCPConfig`
 * (which validates an already-JSON-decoded object), so the user's real
 * `~/.locopilot/mcp.json` is never read or written. F8's watcher/lifecycle
 * fix is not directly exercised here (it needs real handles) — the
 * `ensureMCPConfigDirSync` export is unit-testable but deliberately left
 * to integration coverage; this script guards the parse-time fixes.
 */

import assert from 'node:assert/strict';

const { isDangerousEnvKey } = await import('../src/mcp/dangerousEnv.ts');
const { expandEnvRefs } = await import('../src/mcp/envExpansion.ts');
const { parseMCPConfig } = await import('../src/mcp/configLoader.ts');

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
  }
}

// ── F15: dangerous-env blocklist is case-insensitive on Windows ──────
console.log('F15 — isDangerousEnvKey platform-aware casing');

check("isDangerousEnvKey('Path','win32') === true", () => {
  assert.equal(isDangerousEnvKey('Path', 'win32'), true);
});
check("isDangerousEnvKey('path','win32') === true", () => {
  assert.equal(isDangerousEnvKey('path', 'win32'), true);
});
check("isDangerousEnvKey('Path','linux') === false", () => {
  assert.equal(isDangerousEnvKey('Path', 'linux'), false);
});
check("isDangerousEnvKey('PATH','linux') === true", () => {
  assert.equal(isDangerousEnvKey('PATH', 'linux'), true);
});
check("isDangerousEnvKey('Bash_Func_evil%%','win32') === true", () => {
  assert.equal(isDangerousEnvKey('Bash_Func_evil%%', 'win32'), true);
});
check("default platform still rejects exact 'PATH'", () => {
  assert.equal(isDangerousEnvKey('PATH'), true);
});

// ── F14: the `$$` escape is reachable and single-pass ────────────────
console.log('F14 — env expansion `$$` escape');

check("expandEnvRefs('$$','c').value === '$'", () => {
  const result = expandEnvRefs('$$', 'c');
  assert.equal(result.value, '$');
  assert.equal(result.warnings.length, 0);
});
check("expandEnvRefs('$$HOME') -> '$HOME' (literal, not re-expanded)", () => {
  const result = expandEnvRefs('$$HOME', 'c');
  assert.equal(result.value, '$HOME');
  assert.equal(result.warnings.length, 0);
});
check("expandEnvRefs('a$$b') -> 'a$b'", () => {
  assert.equal(expandEnvRefs('a$$b', 'c').value, 'a$b');
});
check("expandEnvRefs('$${env.FOO}') -> '${env.FOO}'", () => {
  const result = expandEnvRefs('$${env.FOO}', 'c');
  assert.equal(result.value, '${env.FOO}');
  assert.equal(result.warnings.length, 0);
});
check('unset ${env.NOPE} -> empty string with exactly one warning', () => {
  delete process.env.NOPE;
  const result = expandEnvRefs('${env.NOPE}', 'ctx');
  assert.equal(result.value, '');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /NOPE/);
  assert.match(result.warnings[0], /is not set/);
});

// ── F13: raw shapes are validated before coercion ────────────────────
console.log('F13 — parseMCPConfig validates raw shapes');

function cfg(server) {
  return { mcpServers: { srv: server } };
}

const stdioBase = () => ({ name: 'srv', transport: { type: 'stdio', command: 'node' } });

check('throws for args: "foo" (previously silently dropped)', () => {
  const server = { name: 'srv', transport: { type: 'stdio', command: 'node', args: 'foo' } };
  assert.throws(() => parseMCPConfig(cfg(server)), /args" must be an array of strings/);
});
check('throws for env: { FOO: 123 } (previously coerced to "123")', () => {
  const server = { name: 'srv', transport: { type: 'stdio', command: 'node', env: { FOO: 123 } } };
  assert.throws(() => parseMCPConfig(cfg(server)), /env" must be a string→string object/);
});
check('throws for autoApprove: "x" (previously silently ignored)', () => {
  const server = { ...stdioBase(), autoApprove: 'x' };
  assert.throws(() => parseMCPConfig(cfg(server)), /"autoApprove" must be an array of strings/);
});
check('throws for timeoutSeconds: "30" (previously silently ignored)', () => {
  const server = { ...stdioBase(), timeoutSeconds: '30' };
  assert.throws(
    () => parseMCPConfig(cfg(server)),
    /"timeoutSeconds" must be a positive finite number/
  );
});
check('throws for env: { PATH: "x" } (dangerous-key rejection now reachable)', () => {
  const server = { name: 'srv', transport: { type: 'stdio', command: 'node', env: { PATH: 'x' } } };
  assert.throws(() => parseMCPConfig(cfg(server)), /code injection/);
});
check('validates server-level meta for http transports too', () => {
  const server = {
    name: 'srv',
    transport: { type: 'http', url: 'https://example.com/mcp' },
    timeoutSeconds: '30',
  };
  assert.throws(
    () => parseMCPConfig(cfg(server)),
    /"timeoutSeconds" must be a positive finite number/
  );
});
check('accepts a fully-typed stdio fixture', () => {
  const server = {
    name: 'srv',
    description: 'a server',
    transport: {
      type: 'stdio',
      command: 'node',
      args: ['--version'],
      env: { MY_VAR: 'ok' },
      cwd: '/tmp',
    },
    autoApprove: ['list_*'],
    timeoutSeconds: 30,
    disabledTools: ['danger'],
    disabled: false,
    oauth: { clientId: 'abc', scopes: ['read'] },
  };
  const out = parseMCPConfig(cfg(server)).mcpServers.srv;
  assert.equal(out.transport.command, 'node');
  assert.deepEqual(out.transport.args, ['--version']);
  assert.deepEqual(out.transport.env, { MY_VAR: 'ok' });
  assert.equal(out.transport.cwd, '/tmp');
  assert.deepEqual(out.autoApprove, ['list_*']);
  assert.equal(out.timeoutSeconds, 30);
  assert.deepEqual(out.disabledTools, ['danger']);
  assert.equal(out.disabled, false);
});
check('accepts a fully-typed http fixture with headers', () => {
  const server = {
    name: 'srv',
    transport: {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    },
  };
  const out = parseMCPConfig(cfg(server)).mcpServers.srv;
  assert.equal(out.transport.url, 'https://example.com/mcp');
  assert.deepEqual(out.transport.headers, { Authorization: 'Bearer token' });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
