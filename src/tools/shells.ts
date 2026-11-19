/**
 * Which shells `run_command` can really start on this machine.
 *
 * The tool used to advertise `bash, sh, zsh, powershell, cmd` everywhere and,
 * on Windows, quietly ran PowerShell for any POSIX shell the model asked for,
 * telling only the user. The model then read PowerShell's output of bash
 * syntax without ever being told. Now the list is measured, the schema shows
 * it, a requested shell is run exactly as asked, and a shell that is not
 * available is refused with the list of those that are.
 */

import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A shell that can be started, and what to start it with. */
export interface AvailableShell {
  name: string;
  /** The command or absolute path to spawn. */
  bin: string;
}

/** What detection reads, so a test can describe a machine without being on it. */
export interface ShellEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isFile(candidate: string): boolean;
  /** The login shell's name on a non-Windows machine, when there is one. */
  loginShell?: string | undefined;
}

/** The shells looked for, in the order they are listed. */
const CANDIDATE_SHELLS = ['powershell', 'cmd', 'bash', 'sh', 'zsh'] as const;

const DEFAULT_WINDOWS_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];

export function realShellEnvironment(): ShellEnvironment {
  const platform = os.platform();
  let loginShell: string | undefined;
  if (platform !== 'win32') {
    try {
      loginShell = os.userInfo().shell?.split('/').pop() || undefined;
    } catch {
      loginShell = undefined;
    }
  }
  return {
    platform,
    env: process.env,
    loginShell,
    isFile(candidate) {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
  };
}

function pathDirectories(environment: ShellEnvironment): string[] {
  const { env, platform } = environment;
  const key =
    platform === 'win32'
      ? (Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH')
      : 'PATH';
  const separator = platform === 'win32' ? ';' : ':';
  return (env[key] ?? '').split(separator).filter((entry) => entry.length > 0);
}

/** Every place `command` is found on PATH, in PATH order. */
function findAllOnPath(command: string, environment: ShellEnvironment): string[] {
  const { platform, env } = environment;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? env.Pathext ?? '')
          .split(';')
          .filter((ext) => ext.length > 0)
          .map((ext) => ext.toLowerCase())
      : [''];
  const suffixes =
    platform === 'win32' && extensions.length === 0 ? DEFAULT_WINDOWS_EXTENSIONS : extensions;
  const found: string[] = [];
  for (const directory of pathDirectories(environment)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${command}${suffix}`);
      if (environment.isFile(candidate)) {
        found.push(candidate);
        break;
      }
    }
  }
  return found;
}

/**
 * The `bash.exe` that ships with Windows is the WSL launcher: it runs commands
 * inside a Linux guest with its own filesystem, so the working directory the
 * tool tracks and the paths the model gives would not mean the same thing.
 * It is not offered as `bash`; a Git for Windows or MSYS2 bash is.
 */
function isWslLauncher(candidate: string): boolean {
  const lower = candidate.toLowerCase().replaceAll('/', '\\');
  return (
    lower.endsWith(String.raw`\system32\bash.exe`) ||
    lower.endsWith(String.raw`\windowsapps\bash.exe`)
  );
}

/** The shells that can be started on the described machine. */
export function detectShells(environment: ShellEnvironment): AvailableShell[] {
  const shells: AvailableShell[] = [];
  const add = (name: string, bin: string | undefined) => {
    if (bin !== undefined && !shells.some((shell) => shell.name === name)) {
      shells.push({ name, bin });
    }
  };

  if (environment.platform === 'win32') {
    // Windows PowerShell and cmd ship with Windows.
    add('powershell', findAllOnPath('powershell', environment)[0] ?? 'powershell');
    add('cmd', environment.env.ComSpec ?? environment.env.COMSPEC ?? 'cmd.exe');
    for (const name of ['bash', 'sh', 'zsh']) {
      add(
        name,
        findAllOnPath(name, environment).find((candidate) => !isWslLauncher(candidate))
      );
    }
    return shells;
  }

  for (const name of CANDIDATE_SHELLS) {
    if (name === 'cmd') continue;
    // PowerShell on Linux and macOS is `pwsh`.
    const command = name === 'powershell' ? 'pwsh' : name;
    add(name, findAllOnPath(command, environment)[0]);
  }
  if (environment.loginShell) {
    add(environment.loginShell, findAllOnPath(environment.loginShell, environment)[0]);
  }
  return shells;
}

let cachedShells: AvailableShell[] | undefined;

/** The shells available here, measured once per process. */
export function availableShells(): AvailableShell[] {
  cachedShells ??= detectShells(realShellEnvironment());
  return cachedShells;
}

/** For tests: forget the measured list. */
export function resetShellCache(): void {
  cachedShells = undefined;
}

export type ShellResolution =
  | { ok: true; name: string; bin: string }
  | { ok: false; error: string };

/**
 * The shell to run a command in: the one asked for, exactly, or the default
 * when none was asked for. A shell that is not available is an error that
 * lists the ones that are; it is never replaced by another.
 */
export function resolveShell(
  requested: string | undefined,
  defaultName: string,
  available: readonly AvailableShell[] = availableShells()
): ShellResolution {
  const name = (requested?.trim() || defaultName).toLowerCase();
  const match = available.find((shell) => shell.name === name);
  if (match) {
    return { ok: true, name: match.name, bin: match.bin };
  }
  const list = available.map((shell) => shell.name).join(', ') || '(none found)';
  return {
    ok: false,
    error: `[Error: shell '${name}' is not available on this machine. Available shells: ${list}. Nothing was run.]`,
  };
}
