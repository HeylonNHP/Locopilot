import os from 'node:os';
import path from 'node:path';

import { noopToolOutputSink, type ToolOutputSink } from './toolOutput';

const workingDirectories = new WeakMap<ToolOutputSink, string>();

function getDefaultWorkingDirectory(): string {
  return process.env.USERPROFILE || os.homedir() || process.cwd();
}

function normalizeOutput(output?: ToolOutputSink): ToolOutputSink {
  return output ?? noopToolOutputSink;
}

export function getAgentWorkingDirectory(output?: ToolOutputSink): string {
  return workingDirectories.get(normalizeOutput(output)) ?? getDefaultWorkingDirectory();
}

export function setAgentWorkingDirectory(
  output: ToolOutputSink | undefined,
  workingDirectory: string
): void {
  workingDirectories.set(normalizeOutput(output), path.resolve(workingDirectory));
}

export function resolveAgentPath(output: ToolOutputSink | undefined, rawPath: string): string {
  return path.resolve(getAgentWorkingDirectory(output), rawPath);
}
