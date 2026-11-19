/**
 * Which shells run_command offers, and that it runs the one it is asked for.
 *
 * It used to list `bash, sh, zsh, powershell, cmd` on every machine and, on
 * Windows, quietly ran PowerShell for any POSIX shell the model named, telling
 * only the user. The detection is described with a fake machine so every
 * platform is covered wherever the suite runs; one end-to-end case then runs
 * a real command in the shell it names, where that shell exists.
 */
import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { availableShells, detectShells, resolveShell } from '../src/tools/shells.ts';

const machine = (platform, files, env = {}, loginShell) => ({
  platform,
  env,
  loginShell,
  isFile: (candidate) => files.includes(candidate),
});

const names = (shells) => shells.map((shell) => shell.name);

describe('detectShells', () => {
  const windowsEnv = {
    Path: String.raw`C:\Windows\System32;C:\Program Files\Git\usr\bin`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
  };

  test('Windows always has PowerShell and cmd, and no POSIX shell it cannot find', () => {
    const shells = detectShells(machine('win32', [], windowsEnv));
    expect(names(shells)).toEqual(['powershell', 'cmd']);
  });

  test('Windows offers a Git for Windows bash, with the path it was found at', () => {
    const bash = String.raw`C:\Program Files\Git\usr\bin\bash.exe`;
    const shells = detectShells(machine('win32', [bash], windowsEnv));
    expect(names(shells)).toEqual(['powershell', 'cmd', 'bash']);
    expect(shells.find((shell) => shell.name === 'bash').bin).toBe(bash);
  });

  test('Windows does not offer the WSL launcher as bash, even when it is first on PATH', () => {
    const wsl = String.raw`C:\Windows\System32\bash.exe`;
    const git = String.raw`C:\Program Files\Git\usr\bin\bash.exe`;
    expect(names(detectShells(machine('win32', [wsl], windowsEnv)))).not.toContain('bash');
    const both = detectShells(machine('win32', [wsl, git], windowsEnv));
    expect(both.find((shell) => shell.name === 'bash').bin).toBe(git);
  });

  test('Linux lists the POSIX shells that exist, never cmd, and pwsh as powershell', () => {
    const files = ['/usr/bin/bash', '/usr/bin/sh', '/usr/bin/pwsh'];
    const shells = detectShells(machine('linux', files, { PATH: '/usr/bin:/bin' }));
    expect(names(shells)).toEqual(['powershell', 'bash', 'sh']);
    expect(names(shells)).not.toContain('cmd');
    expect(shells[0].bin).toBe('/usr/bin/pwsh');
  });

  test('Linux without PowerShell or zsh does not list them', () => {
    const shells = detectShells(machine('linux', ['/bin/bash'], { PATH: '/bin' }));
    expect(names(shells)).toEqual(['bash']);
  });

  test('a login shell outside the usual five is still offered when it exists', () => {
    const files = ['/bin/bash', '/usr/bin/fish'];
    const shells = detectShells(machine('linux', files, { PATH: '/usr/bin:/bin' }, 'fish'));
    expect(names(shells)).toEqual(['bash', 'fish']);
  });
});

describe('resolveShell', () => {
  const available = [
    { name: 'powershell', bin: 'ps.exe' },
    { name: 'bash', bin: 'C:/git/bash.exe' },
  ];

  test('a requested shell is used exactly, whatever the default is', () => {
    expect(resolveShell('bash', 'powershell', available)).toEqual({
      ok: true,
      name: 'bash',
      bin: 'C:/git/bash.exe',
    });
  });

  test('no request means the default; case and spaces in a request are ignored', () => {
    expect(resolveShell(undefined, 'powershell', available)).toMatchObject({ name: 'powershell' });
    expect(resolveShell('  ', 'powershell', available)).toMatchObject({ name: 'powershell' });
    expect(resolveShell(' BASH ', 'powershell', available)).toMatchObject({ name: 'bash' });
  });

  test('a shell that is not available is refused with the list, never swapped', () => {
    const result = resolveShell('zsh', 'powershell', available);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("shell 'zsh' is not available");
    expect(result.error).toContain('Available shells: powershell, bash');
    expect(result.error).toContain('Nothing was run');
  });
});

describe('run_command', () => {
  let toolRegistry;
  let enterRequestScope;
  let runCommandToolSchema;
  beforeAll(async () => {
    // The registry reaches jsdom only through the web tools (see
    // tests/chat-route-pair-gates.test.mjs for why it is stubbed).
    jest.unstable_mockModule('jsdom', () => ({ JSDOM: class {}, VirtualConsole: class {} }));
    ({ toolRegistry } = await import('../src/tools/toolRegistry.ts'));
    ({ enterRequestScope, runCommandToolSchema } =
      await import('../src/tools/impl/runCommandTool.ts'));
  }, 60_000);

  const run = (args) => {
    enterRequestScope();
    return toolRegistry.get('run_command').execute(args, undefined, undefined, { yoloMode: true });
  };
  const has = (name) => availableShells().some((shell) => shell.name === name);

  test('the schema lists the shells that are really available, and says a missing one is refused', () => {
    const description = runCommandToolSchema.parameters.properties.shell.description;
    expect(description).toContain(
      `Available on this machine: ${names(availableShells()).join(', ')}`
    );
    expect(description).toContain('never replaced by another');
    for (const absent of ['zsh', 'bash', 'sh', 'powershell', 'cmd'].filter((name) => !has(name))) {
      expect(description).not.toContain(absent);
    }
  });

  test('a shell that is not available is refused and nothing runs', async () => {
    const { content } = await run({
      command: 'echo should-not-run',
      shell: 'definitely-not-a-shell',
    });
    expect(content).toContain("shell 'definitely-not-a-shell' is not available");
    expect(content).toContain('Nothing was run');
    expect(content).not.toContain('should-not-run');
  });

  test('no shell given runs the default shell', async () => {
    const { content } = await run({ command: 'echo default-shell-works' });
    expect(content).toContain('default-shell-works');
  });

  const bashTest = has('bash') ? test : test.skip;
  bashTest(
    'bash is really bash, not PowerShell, and the working directory is a real path',
    async () => {
      const { content } = await run({
        command: 'echo "version=${BASH_VERSION:+bash}"; cd .. && pwd -W 2>/dev/null || pwd',
        shell: 'bash',
      });
      expect(content).toContain('version=bash');
      expect(content).not.toContain('is not native');
      // The tracked working directory is what `pwd -W` printed: a Windows path (or
      // a plain POSIX path off Windows), never an MSYS `/c/...` path the tool
      // cannot use.
      const { getAgentWorkingDirectory } = await import('../src/tools/workingDirectory.ts');
      const tracked = getAgentWorkingDirectory(undefined);
      expect(path.isAbsolute(tracked)).toBe(true);
      expect(existsSync(tracked)).toBe(true);
    }
  );
});
