/**
 * Owner of the on-disk artifacts that back a spilled `run_command` stream.
 *
 * WHY this module exists: the spool (`src/tools/outputSpool.ts`) writes every
 * raw byte of a command's output to a side file so the model can recover
 * what the bounded preview dropped. Those files need an owner — somebody has
 * to decide when they go stale, who may delete them, and where the model is
 * told to look. Without that, the artifacts accumulate until the disk
 * fills and a deleted session leaves its output behind forever.
 *
 * The layout is
 *
 *   <root>/session-<id>/run-<id>/<name>
 *   <root>/unscoped/run-<id>/<name>
 *
 * so that a session's artifacts can be removed as a unit and two runs of
 * the same session can never collide.
 *
 * Server-side only: the module touches the filesystem and reads
 * `process.env`, so it must never be pulled into the client bundle.
 *
 * NOTE the redaction does not live here. The capture
 * (`src/tools/outputSpool.ts`) redacts the stream once, before the bytes
 * are split into the artifact and the preview: two writers that redacted
 * separately would eventually disagree about what a secret looks like, and
 * the disagreement would show up as a raw secret in one of them.
 */
import { closeSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RUN_OUTPUT_GLOBAL_MAX_BYTES,
  RUN_OUTPUT_GLOBAL_MAX_FILES,
  RUN_OUTPUT_RETENTION_MS,
  RUN_OUTPUT_SESSION_MAX_BYTES,
  RUN_OUTPUT_SESSION_MAX_FILES,
} from '@/constants';

/** Identifies the owner and the run an artifact belongs to. */
export interface OutputScope {
  /** The chat session that owns the artifact; deleting the session deletes it. */
  sessionId?: number | undefined;
  /** Unique id of the run; keeps two runs of the same session apart. */
  runId?: string | undefined;
}

/** What a sweep of the store did. */
export interface OutputCleanupReport {
  /** False when the sweep could not complete; the store is left as it was. */
  ok: boolean;
  /** Number of artifacts removed. */
  removed: number;
  /** Bytes reclaimed by the removal. */
  freedBytes: number;
  /** Why the sweep degraded, when it did. */
  error?: string | undefined;
}

/** Metadata of one artifact, as reported to the model. */
export interface OutputFileDescription {
  /** Size of the file on disk. */
  bytes: number;
  /** Newline-delimited lines the file holds. */
  lines: number;
}

interface OutputFileEntry {
  path: string;
  bytes: number;
  modifiedAt: number;
  /** The first-level directory under the root; the session that owns it. */
  owner: string;
}

/**
 * Root directory that holds every `run_command` artifact.
 *
 * The override exists so a test (or an operator) can point the store at a
 * scratch directory; without it the artifacts would land in the shared
 * temporary directory, where a test sweep would delete another session's
 * output.
 */
export function outputDirectory(): string {
  const override = process.env.LOCOPILOT_RUN_OUTPUT_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.tmpdir(), 'locopilot-run-output');
}

/** Directory that holds the artifacts of one chat session. */
export function sessionOutputDirectory(sessionId: number): string {
  return path.join(outputDirectory(), `session-${sessionId}`);
}

/**
 * Directory of one run. Every run gets its own directory so two runs of the
 * same session can never overwrite each other's artifacts.
 */
export function runOutputDirectory(scope: OutputScope): string {
  const owner = scope.sessionId === undefined ? 'unscoped' : `session-${scope.sessionId}`;
  const run = scope.runId === undefined || scope.runId.length === 0 ? 'run' : scope.runId;
  return path.join(outputDirectory(), owner, run);
}

/** Absolute path of one artifact, inside the run's own directory. */
export function createOutputPath(name: string, scope: OutputScope = {}): string {
  return path.join(runOutputDirectory(scope), name);
}

/**
 * Cached metadata of the artifacts that were described recently.
 *
 * The marker text asks for the size and the line count of every artifact on
 * every poll, and an artifact may be tens of megabytes. The cache is keyed
 * by the path and invalidated by the file's size and mtime, so a file that
 * is being appended to is re-read but a finished one is not.
 */
const metadataCache = new Map<
  string,
  { size: number; modifiedAt: number; description: OutputFileDescription }
>();

/** How many artifacts stay cached before the cache is dropped wholesale. */
const METADATA_CACHE_LIMIT = 128;

/**
 * Cheap metadata of one artifact: its size and how many lines it holds.
 *
 * The counts describe the file on disk, which is what the model is pointed
 * at — a byte count taken from the in-memory capture could disagree with
 * what `read_file` reports for the same file.
 */
export function describeOutputFile(filePath: string): OutputFileDescription {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return { bytes: 0, lines: 0 };
    const cached = metadataCache.get(filePath);
    if (cached && cached.size === stat.size && cached.modifiedAt === stat.mtimeMs) {
      return cached.description;
    }
    const description: OutputFileDescription = {
      bytes: stat.size,
      lines: countLines(filePath, stat.size),
    };
    if (metadataCache.size >= METADATA_CACHE_LIMIT) metadataCache.clear();
    metadataCache.set(filePath, { size: stat.size, modifiedAt: stat.mtimeMs, description });
    return description;
  } catch {
    // A missing or unreadable artifact has no metadata; the caller falls
    // back to the in-memory counters.
    return { bytes: 0, lines: 0 };
  }
}

/**
 * Deletes every artifact of one session.
 *
 * Called when the session is deleted: the output of a conversation the
 * user threw away must not outlive it. A failure here is swallowed on
 * purpose — the session is gone either way, and a leftover file is a much
 * smaller problem than a failed delete request.
 */
export function removeOutputsForSession(sessionId: number): void {
  try {
    rmSync(sessionOutputDirectory(sessionId), { recursive: true, force: true });
  } catch {
    /* the session is deleted regardless */
  }
}

/**
 * Evicts the artifacts that are no longer worth keeping.
 *
 * Three rules, applied in this order: anything older than the retention
 * window goes, then every session is trimmed to its own budget, then the
 * whole store is trimmed to the global budget. Within a budget the OLDEST
 * artifacts go first, because a stale artifact is worth less than a fresh
 * one.
 *
 * The sweep never throws. A store that cannot be walked or written to is
 * reported as degraded and left alone; the caller (a command that is
 * about to run) must not fail because of housekeeping.
 */
export function cleanupStaleOutputs(now: number = Date.now()): OutputCleanupReport {
  const report: OutputCleanupReport = { ok: true, removed: 0, freedBytes: 0 };
  try {
    const root = outputDirectory();
    let remaining = listOutputFiles(root);

    // Rule 1 — age. Anything past the retention window is worthless: the
    // model has long since read it (or never will).
    const cutoff = now - RUN_OUTPUT_RETENTION_MS;
    const stale = remaining
      .filter((file) => file.modifiedAt < cutoff)
      .sort((left, right) => left.modifiedAt - right.modifiedAt);
    for (const file of stale) removeFile(file, report);
    remaining = remaining.filter((file) => file.modifiedAt >= cutoff);

    // Rule 2 — per-session budgets.
    for (const owner of new Set(remaining.map((file) => file.owner))) {
      const owned = remaining
        .filter((file) => file.owner === owner)
        .sort((left, right) => left.modifiedAt - right.modifiedAt);
      const evicted = new Set<string>();
      let files = owned.length;
      let bytes = owned.reduce((total, file) => total + file.bytes, 0);
      for (const file of owned) {
        if (files <= RUN_OUTPUT_SESSION_MAX_FILES && bytes <= RUN_OUTPUT_SESSION_MAX_BYTES) break;
        evicted.add(file.path);
        files -= 1;
        bytes -= file.bytes;
      }
      remaining = remaining.filter((file) => !evicted.has(file.path));
      for (const file of owned) {
        if (evicted.has(file.path)) removeFile(file, report);
      }
    }

    // Rule 3 — the global budget, across every session.
    const global = remaining.sort((left, right) => left.modifiedAt - right.modifiedAt);
    let files = global.length;
    let bytes = global.reduce((total, file) => total + file.bytes, 0);
    for (const file of global) {
      if (files <= RUN_OUTPUT_GLOBAL_MAX_FILES && bytes <= RUN_OUTPUT_GLOBAL_MAX_BYTES) break;
      removeFile(file, report);
      files -= 1;
      bytes -= file.bytes;
    }

    pruneEmptyDirectories(root);
  } catch (err) {
    return {
      ...report,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return report;
}

/**
 * Counts the newline-delimited lines of a file without loading it into
 * memory — an artifact may be tens of megabytes.
 */
function countLines(filePath: string, size: number): number {
  if (size === 0) return 0;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let newlines = 0;
    let lastByte = -1;
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      for (let index = 0; index < read; index += 1) {
        if (buffer[index] === 0x0a) newlines += 1;
      }
      lastByte = buffer[read - 1] ?? -1;
      position += read;
    }
    // A file that does not end with a newline still ends in a last, partial
    // line — it is a line the model can still read.
    return lastByte === 0x0a ? newlines : newlines + 1;
  } catch {
    return 0;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* the handle is already gone */
      }
    }
  }
}

/** Every regular file under the root, with the session that owns it. */
function listOutputFiles(root: string): OutputFileEntry[] {
  const files: OutputFileEntry[] = [];
  const walk = (directory: string, owner: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // A directory we cannot read is simply not part of the sweep.
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full, directory === root ? entry.name : owner);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = statSync(full);
        files.push({ path: full, bytes: stat.size, modifiedAt: stat.mtimeMs, owner });
      } catch {
        /* the file vanished between the listing and the stat */
      }
    }
  };
  walk(root, '');
  return files;
}

/** Removes one artifact and records what it freed. */
function removeFile(file: OutputFileEntry, report: OutputCleanupReport): void {
  try {
    rmSync(file.path, { force: true });
    report.removed += 1;
    report.freedBytes += file.bytes;
  } catch {
    // A file we cannot delete is not fatal: the budgets are best-effort and
    // the next sweep will try again.
  }
}

/** Removes the directories the sweep emptied, so the tree stays tidy. */
function pruneEmptyDirectories(directory: string): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(directory, entry.name);
    pruneEmptyDirectories(full);
    try {
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true });
    } catch {
      /* leave the directory alone */
    }
  }
}
