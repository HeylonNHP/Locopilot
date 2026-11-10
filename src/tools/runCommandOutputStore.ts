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
 * Three properties this module owns, each of them a bug once:
 *
 * - PRIVACY. The artifacts are the output of the user's commands: source
 *   code, proprietary logs, and secrets the redactor did not recognise.
 *   They live under a shared temporary directory, so the directories are
 *   created with mode 0700 and the files with mode 0600, and both are
 *   re-applied defensively on every sweep.
 * - BOUNDED DISK. The retention window and the size budgets have env
 *   overrides, because a small tmpfs can fill before the sweeper runs and
 *   an operator has to be able to tighten the caps without a rebuild.
 * - VISIBLE HOUSEKEEPING. A sweep that fails, or that removes something,
 *   is written to the diagnostic log: a store that is quietly broken is
 *   worse than one that says so.
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
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { debugLog } from '@/app/lib/debugLogger';
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

/**
 * The budgets of the store, as they are at this moment.
 *
 * WHY a snapshot and not a set of constants: every number here has an env
 * override, and the override is read when the sweep runs, so an operator
 * (or a test) can change the budget between two sweeps without restarting
 * the process.
 */
export interface OutputStoreLimits {
  /** How long an artifact is kept before the sweeper evicts it. */
  retentionMs: number;
  /** Maximum number of artifacts one session may keep. */
  sessionMaxFiles: number;
  /** Maximum total size of the artifacts one session may keep. */
  sessionMaxBytes: number;
  /** Maximum number of artifacts kept across every session. */
  globalMaxFiles: number;
  /** Maximum total size of the artifacts kept across every session. */
  globalMaxBytes: number;
}

/** The payload of the diagnostic entry the store writes after a sweep. */
export interface CleanupDiagnostic {
  /** False when the sweep could not complete. */
  ok: boolean;
  /** Number of artifacts removed. */
  removed: number;
  /** Bytes reclaimed by the removal. */
  freedBytes: number;
  /** Why the sweep degraded, when it did. */
  error?: string | undefined;
}

/**
 * Mode of the directories that hold the artifacts.
 *
 * WHY 0700: the artifacts are command output — proprietary source, build
 * logs, and whatever the redactor did not recognise. The default mode of a
 * directory under a shared `/tmp` is 0755, which lets every local user
 * walk into it. A 0700 directory is not traversable by anyone but its
 * owner, so the files inside it stay private whatever their own mode is.
 */
const OUTPUT_DIRECTORY_MODE = 0o700;

/**
 * Mode of an artifact file: readable and writable by its owner only.
 *
 * WHY 0600 and not 0644: the file mode is the second line of defence. The
 * directory already keeps other users out, but an artifact that is copied,
 * archived or served from somewhere else must not carry the world's read
 * permission with it.
 */
const OUTPUT_FILE_MODE = 0o600;

/**
 * True where the POSIX mode bits mean something.
 *
 * On Windows the mode is ignored by the filesystem (only the read-only
 * attribute is honoured), so the calls are skipped rather than pretending
 * to protect something they cannot.
 */
const SUPPORTS_POSIX_MODES = process.platform !== 'win32';

/** The name of the directory that holds the artifacts of no known session. */
const UNSCOPED_OWNER = 'unscoped';

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
 *
 * The directory is CREATED here, with private permissions, before anything
 * is written into it. A directory that is created later by the writer would
 * be 0755 under the default umask, and a world-traversable directory makes
 * the artifacts readable by every local user.
 */
export function runOutputDirectory(scope: OutputScope): string {
  const root = outputDirectory();
  const owner = scope.sessionId === undefined ? UNSCOPED_OWNER : `session-${scope.sessionId}`;
  const run = scope.runId === undefined || scope.runId.length === 0 ? 'run' : scope.runId;
  const directory = path.join(root, owner, run);
  ensurePrivateDirectory(root, directory);
  return directory;
}

/**
 * Creates the directory (and the tree above it) so that only its owner can
 * reach it, and re-applies the mode to a directory that already existed.
 *
 * The mode passed to `mkdir` is masked by the process umask and an existing
 * directory keeps the mode it had, so the bits are set explicitly afterwards.
 */
function ensurePrivateDirectory(root: string, directory: string): void {
  try {
    mkdirSync(directory, { recursive: true, mode: OUTPUT_DIRECTORY_MODE });
  } catch {
    // The writer reports the failure in its own way; a store that cannot
    // create its directory is not worth throwing over here.
    return;
  }
  secureDirectoryChain(root, directory);
}

/**
 * Sets the private mode on a directory and on every ancestor up to the
 * store root.
 *
 * WHY the ancestors: the root and the per-session directory are created by
 * the same recursive `mkdir`, so without this they would keep the umask's
 * mode while only the leaf was private.
 */
function secureDirectoryChain(root: string, directory: string): void {
  if (!SUPPORTS_POSIX_MODES) return;
  const chain: string[] = [];
  let current = directory;
  while (current !== root) {
    // The chain must END at the root. A directory that is not under it is
    // left alone rather than followed up to the root of the filesystem,
    // which would be a spectacular way to break the machine.
    if (!current.startsWith(root + path.sep)) return;
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
  chain.push(root);
  for (const entry of chain) {
    try {
      chmodSync(entry, OUTPUT_DIRECTORY_MODE);
    } catch {
      // A directory we cannot chmod is left as it is; the sweep will try
      // again, and a missing mode is not worth failing a command over.
    }
  }
}

/**
 * Makes one artifact readable and writable by its owner only.
 *
 * Exported so that the writer of the artifact can set the mode at creation
 * time; the store also calls it defensively, so an artifact that was
 * written before the mode was set is tightened the next time it is
 * described or swept.
 */
export function secureOutputFile(filePath: string): void {
  if (!SUPPORTS_POSIX_MODES) return;
  try {
    chmodSync(filePath, OUTPUT_FILE_MODE);
  } catch {
    // The file may be gone already, or the filesystem may not support the
    // mode. Either way there is nothing to fix here.
  }
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
    // The store owns the artifacts, so it owns their permissions too: an
    // artifact that was written before the mode was set is tightened here,
    // right before the model is pointed at it.
    secureOutputFile(filePath);
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
 * Reads a numeric override from the environment.
 *
 * WHY the value is read at CALL time and not at module load: the knobs are
 * meant to be changed by an operator — or by a test — between two sweeps,
 * and a value captured at import time would be frozen for the life of the
 * process. An empty or unparseable value falls back to the default rather
 * than to zero: a typo must not empty the store.
 */
function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/**
 * The budgets the store applies at this moment.
 *
 * The defaults are the ones that shipped with the feature: a 24 hour
 * retention window, 100 files / 250 MiB per session and 1000 files / 1 GB
 * across the whole store. Each of them has an env override so that a
 * machine with a small tmpfs can tighten them without a rebuild:
 *
 *   LOCOPILOT_RUN_OUTPUT_RETENTION_MS
 *   LOCOPILOT_RUN_OUTPUT_SESSION_MAX_FILES
 *   LOCOPILOT_RUN_OUTPUT_SESSION_MAX_BYTES
 *   LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_FILES
 *   LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_BYTES
 */
export function outputStoreLimits(): OutputStoreLimits {
  return {
    retentionMs: readNumberEnv('LOCOPILOT_RUN_OUTPUT_RETENTION_MS', RUN_OUTPUT_RETENTION_MS),
    sessionMaxFiles: readNumberEnv(
      'LOCOPILOT_RUN_OUTPUT_SESSION_MAX_FILES',
      RUN_OUTPUT_SESSION_MAX_FILES
    ),
    sessionMaxBytes: readNumberEnv(
      'LOCOPILOT_RUN_OUTPUT_SESSION_MAX_BYTES',
      RUN_OUTPUT_SESSION_MAX_BYTES
    ),
    globalMaxFiles: readNumberEnv(
      'LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_FILES',
      RUN_OUTPUT_GLOBAL_MAX_FILES
    ),
    globalMaxBytes: readNumberEnv(
      'LOCOPILOT_RUN_OUTPUT_GLOBAL_MAX_BYTES',
      RUN_OUTPUT_GLOBAL_MAX_BYTES
    ),
  };
}

/**
 * The payload of the diagnostic entry that describes a sweep.
 *
 * Exported so that the shape of the log line can be asserted without
 * reading the (asynchronous) log file.
 */
export function cleanupDiagnosticPayload(report: OutputCleanupReport): CleanupDiagnostic {
  if (report.error === undefined) {
    return { ok: report.ok, removed: report.removed, freedBytes: report.freedBytes };
  }
  return {
    ok: report.ok,
    removed: report.removed,
    freedBytes: report.freedBytes,
    error: report.error,
  };
}

/**
 * Writes the outcome of a sweep to the diagnostic log.
 *
 * WHY: the caller of the sweep is a command that is about to run, and it
 * has no reason to look at a report it does not need. Without this a store
 * that is permanently broken — a root that cannot be walked, a directory
 * that cannot be written to — is completely invisible: every command
 * succeeds and no artifact is ever kept.
 */
function logCleanupReport(report: OutputCleanupReport): void {
  if (report.ok && report.removed === 0) return;
  try {
    debugLog.diagnostic({
      layer: 'route',
      phase: 'cleanup',
      ...cleanupDiagnosticPayload(report),
    });
  } catch {
    // A logger that is broken must not break the sweep.
  }
}

/**
 * Evicts the artifacts that are no longer worth keeping.
 *
 * Three rules, applied in this order: anything older than the retention
 * window goes, then every owner is trimmed to its own budget, then the
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
  const limits = outputStoreLimits();
  try {
    const root = outputDirectory();
    const cutoff = now - limits.retentionMs;
    let remaining = listOutputFiles(root);

    // Rule 1 — age, owner by owner. Anything past the retention window is
    // worthless: the model has long since read it (or never will).
    //
    // The `unscoped/` tree is swept by this rule too, and that is the ONLY
    // rule that will ever evict it: an artifact written before the session
    // id was known belongs to no session, so there is no session deletion
    // that could take it away. Sweeping it per owner keeps that guarantee
    // explicit instead of leaving it to a side effect of the walk.
    for (const owner of new Set(remaining.map((file) => file.owner))) {
      const stale = remaining
        .filter((file) => file.owner === owner && file.modifiedAt < cutoff)
        .sort((left, right) => left.modifiedAt - right.modifiedAt);
      for (const file of stale) removeFile(file, report);
    }
    remaining = remaining.filter((file) => file.modifiedAt >= cutoff);

    // Rule 2 — per-owner budgets. The `unscoped/` tree is an owner like
    // any other, so it is bounded as well.
    for (const owner of new Set(remaining.map((file) => file.owner))) {
      const owned = remaining
        .filter((file) => file.owner === owner)
        .sort((left, right) => left.modifiedAt - right.modifiedAt);
      const evicted = new Set<string>();
      let files = owned.length;
      let bytes = owned.reduce((total, file) => total + file.bytes, 0);
      for (const file of owned) {
        if (files <= limits.sessionMaxFiles && bytes <= limits.sessionMaxBytes) break;
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
      if (files <= limits.globalMaxFiles && bytes <= limits.globalMaxBytes) break;
      removeFile(file, report);
      files -= 1;
      bytes -= file.bytes;
    }

    pruneEmptyDirectories(root);
  } catch (err) {
    const failed: OutputCleanupReport = {
      ...report,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    logCleanupReport(failed);
    return failed;
  }
  logCleanupReport(report);
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

/**
 * Every regular file under the root, with the session that owns it.
 *
 * The walk also re-applies the private modes: an artifact that was written
 * by a writer that did not know about them (or that predates them) is
 * tightened here, so the store converges on the right permissions even if
 * the file was created the old way.
 */
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
        if (SUPPORTS_POSIX_MODES) {
          try {
            chmodSync(full, OUTPUT_DIRECTORY_MODE);
          } catch {
            /* leave the directory alone */
          }
        }
        walk(full, directory === root ? entry.name : owner);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = statSync(full);
        secureOutputFile(full);
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
