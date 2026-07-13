import os from 'node:os';
import path from 'node:path';

/**
 * Lightweight identity token used as a `WeakMap` key for per-context working
 * directory tracking. Each execution context (HTTP request, sub-agent run)
 * creates one scope and passes it to tools that need to resolve relative
 * paths or query/change the agent's working directory.
 *
 * The class is intentionally empty — it exists solely to provide a stable
 * object identity for the WeakMap lookup. This decouples working-directory
 * tracking from `ToolOutputSink`, which was previously overloaded to serve
 * as both an output channel and a map key.
 */
export class WorkingDirectoryScope {
  // Intentionally empty — used only as a WeakMap key.
}

/** Shared default scope used when no explicit scope is provided. */
const defaultScope = new WorkingDirectoryScope();

const workingDirectories = new WeakMap<WorkingDirectoryScope, string>();

function getDefaultWorkingDirectory(): string {
  return process.env.USERPROFILE || os.homedir() || process.cwd();
}

function normalizeScope(scope?: WorkingDirectoryScope): WorkingDirectoryScope {
  return scope ?? defaultScope;
}

export function getAgentWorkingDirectory(scope?: WorkingDirectoryScope): string {
  return workingDirectories.get(normalizeScope(scope)) ?? getDefaultWorkingDirectory();
}

export function setAgentWorkingDirectory(
  scope: WorkingDirectoryScope | undefined,
  workingDirectory: string
): void {
  workingDirectories.set(normalizeScope(scope), path.resolve(workingDirectory));
}

export function resolveAgentPath(
  scope: WorkingDirectoryScope | undefined,
  rawPath: string
): string {
  return path.resolve(getAgentWorkingDirectory(scope), rawPath);
}
