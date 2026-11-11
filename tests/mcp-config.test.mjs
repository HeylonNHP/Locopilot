/**
 * Regression tests for the audited MCP config fixes F8/F13/F14/F15.
 *
 * Pure unit tests: no network, no live MCP server, no filesystem
 * mutation. The tests only exercise pure helpers and `parseMCPConfig`
 * (which validates an already-JSON-decoded object), so the user's real
 * `~/.locopilot/mcp.json` is never read or written. F8's watcher/lifecycle
 * fix is not directly exercised here (it needs real handles) — the
 * `ensureMCPConfigDirSync` export is unit-testable but deliberately left
 * to integration coverage; this script guards the parse-time fixes.
 */

import { describe, expect, test } from '@jest/globals';

const { isDangerousEnvKey } = await import('../src/mcp/dangerousEnv.ts');
const { expandEnvRefs } = await import('../src/mcp/envExpansion.ts');
const { parseMCPConfig } = await import('../src/mcp/configLoader.ts');

describe('F15 — isDangerousEnvKey platform-aware casing', () => {
  test("isDangerousEnvKey('Path','win32') === true", () => {
    expect(isDangerousEnvKey('Path', 'win32')).toBe(true);
  });
  test("isDangerousEnvKey('path','win32') === true", () => {
    expect(isDangerousEnvKey('path', 'win32')).toBe(true);
  });
  test("isDangerousEnvKey('Path','linux') === false", () => {
    expect(isDangerousEnvKey('Path', 'linux')).toBe(false);
  });
  test("isDangerousEnvKey('PATH','linux') === true", () => {
    expect(isDangerousEnvKey('PATH', 'linux')).toBe(true);
  });
  test("isDangerousEnvKey('Bash_Func_evil%%','win32') === true", () => {
    expect(isDangerousEnvKey('Bash_Func_evil%%', 'win32')).toBe(true);
  });
  test("default platform still rejects exact 'PATH'", () => {
    expect(isDangerousEnvKey('PATH')).toBe(true);
  });
});

describe('F14 — env expansion `$$` escape', () => {
  test("expandEnvRefs('$$','c').value === '$'", () => {
    const result = expandEnvRefs('$$', 'c');
    expect(result.value).toBe('$');
    expect(result.warnings).toHaveLength(0);
  });
  test("expandEnvRefs('$$HOME') -> '$HOME' (literal, not re-expanded)", () => {
    const result = expandEnvRefs('$$HOME', 'c');
    expect(result.value).toBe('$HOME');
    expect(result.warnings).toHaveLength(0);
  });
  test("expandEnvRefs('a$$b') -> 'a$b'", () => {
    expect(expandEnvRefs('a$$b', 'c').value).toBe('a$b');
  });
  test("expandEnvRefs('$${env.FOO}') -> '${env.FOO}'", () => {
    const result = expandEnvRefs('$${env.FOO}', 'c');
    expect(result.value).toBe('${env.FOO}');
    expect(result.warnings).toHaveLength(0);
  });
  test('unset ${env.NOPE} -> empty string with exactly one warning', () => {
    delete process.env.NOPE;
    const result = expandEnvRefs('${env.NOPE}', 'ctx');
    expect(result.value).toBe('');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/NOPE/);
    expect(result.warnings[0]).toMatch(/is not set/);
  });
});

describe('F13 — parseMCPConfig validates raw shapes', () => {
  function cfg(server) {
    return { mcpServers: { srv: server } };
  }

  const stdioBase = () => ({ name: 'srv', transport: { type: 'stdio', command: 'node' } });

  test('throws for args: "foo" (previously silently dropped)', () => {
    const server = { name: 'srv', transport: { type: 'stdio', command: 'node', args: 'foo' } };
    expect(() => parseMCPConfig(cfg(server))).toThrow(/args" must be an array of strings/);
  });
  test('throws for env: { FOO: 123 } (previously coerced to "123")', () => {
    const server = {
      name: 'srv',
      transport: { type: 'stdio', command: 'node', env: { FOO: 123 } },
    };
    expect(() => parseMCPConfig(cfg(server))).toThrow(/env" must be a string→string object/);
  });
  test('throws for autoApprove: "x" (previously silently ignored)', () => {
    const server = { ...stdioBase(), autoApprove: 'x' };
    expect(() => parseMCPConfig(cfg(server))).toThrow(/"autoApprove" must be an array of strings/);
  });
  test('throws for timeoutSeconds: "30" (previously silently ignored)', () => {
    const server = { ...stdioBase(), timeoutSeconds: '30' };
    expect(() => parseMCPConfig(cfg(server))).toThrow(
      /"timeoutSeconds" must be a positive finite number/
    );
  });
  test('throws for env: { PATH: "x" } (dangerous-key rejection now reachable)', () => {
    const server = {
      name: 'srv',
      transport: { type: 'stdio', command: 'node', env: { PATH: 'x' } },
    };
    expect(() => parseMCPConfig(cfg(server))).toThrow(/code injection/);
  });
  test('validates server-level meta for http transports too', () => {
    const server = {
      name: 'srv',
      transport: { type: 'http', url: 'https://example.com/mcp' },
      timeoutSeconds: '30',
    };
    expect(() => parseMCPConfig(cfg(server))).toThrow(
      /"timeoutSeconds" must be a positive finite number/
    );
  });
  test('accepts a fully-typed stdio fixture', () => {
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
    expect(out.transport.command).toBe('node');
    expect(out.transport.args).toStrictEqual(['--version']);
    expect(out.transport.env).toStrictEqual({ MY_VAR: 'ok' });
    expect(out.transport.cwd).toBe('/tmp');
    expect(out.autoApprove).toStrictEqual(['list_*']);
    expect(out.timeoutSeconds).toBe(30);
    expect(out.disabledTools).toStrictEqual(['danger']);
    expect(out.disabled).toBe(false);
  });
  test('accepts a fully-typed http fixture with headers', () => {
    const server = {
      name: 'srv',
      transport: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' },
      },
    };
    const out = parseMCPConfig(cfg(server)).mcpServers.srv;
    expect(out.transport.url).toBe('https://example.com/mcp');
    expect(out.transport.headers).toStrictEqual({ Authorization: 'Bearer token' });
  });
});
