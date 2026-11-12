/**
 * recentFilesDisk.ts
 *
 * The only code of the recent-files stub that touches the disk: a bounded,
 * confined read of one file. Security-sensitive, so it lives on its own: the
 * containment checks, the symlink guard, the binary detection and the byte cap
 * are all here and nowhere else. `recentFiles.ts` receives this as an injected
 * `RecentFileReader`; the tests pass a lookup table instead.
 */

import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { RECENT_FILES_MAX_READ_BYTES, RECENT_FILES_TRUNCATION_MARKER } from './constants';

/**
 * Extensions the reader refuses outright.
 *
 * WHY an extension list at all when the NUL-byte check exists: plenty of binary
 * formats contain no NUL in their first 16 KiB (a short PNG of flat colour, a
 * base64-wrapped payload), and a decoded blob is noise the model cannot use and
 * the budget still pays for. The NUL check catches the rest.
 */
const RECENT_FILES_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'bmp',
  'db',
  'gif',
  'gz',
  'ico',
  'jpeg',
  'jpg',
  'mp4',
  'pdf',
  'png',
  'sqlite',
  'wasm',
  'webp',
  'woff2',
  'zip',
]);

/**
 * True when `candidate` is inside `root` (or IS `root`).
 *
 * WHY `path.relative` and not `startsWith`: `/work/app-2` starts with
 * `/work/app`, so a prefix test accepts a sibling directory whose name merely
 * begins the same way. `path.relative` answers the question that is actually
 * being asked — "how do I get from root to candidate" — and a `..` in the
 * answer means the way out. On Windows the comparison is case-insensitive, as
 * the filesystem is.
 */
function isInsidePath(candidate: string, root: string): boolean {
  const normalize = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const relative = path.relative(normalize(root), normalize(candidate));
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Reads a whole `absPath`, refusing anything that is not a text file inside
 * `root`.
 *
 * The guards run in this order, and each one is there for a reason:
 *
 * 1. LEXICAL CONTAINMENT inside `root`. A row is written by the session that
 *    touched the file, and a session's working directory can be the whole
 *    home directory — but a path OUTSIDE it (`/etc/passwd`) must never be read
 *    just because a `read_file` call named it once. This check is on the
 *    un-resolved path, so it costs nothing and rejects the obvious cases
 *    before any I/O.
 * 2. `realpath`, then containment again on the RESULT. This is what closes the
 *    symlink hole: a symlink inside the working directory that points at
 *    `/etc/shadow` passes check 1 and fails this one. `ENOENT` (a file that
 *    has since been deleted) falls out here as `null`.
 * 3. `stat().isFile()`. A directory, a socket or a device is not a file;
 *    `EACCES`/`EPERM` on a stat is a file we cannot see, so `null`.
 * 4. A BOUNDED READ — `open` + `read` into a buffer of at most
 *    {@link RECENT_FILES_MAX_READ_BYTES} bytes, never `readFile` of the whole
 *    file, because the file is whatever the model touched and may be a 400 MB
 *    log.
 * 5. BINARY DETECTION — a NUL byte in what was read, or a denied extension.
 * 6. DECODE, and if the file is longer than the buffer, cut back to the last
 *    complete line and append {@link RECENT_FILES_TRUNCATION_MARKER}. The
 *    caller treats a marked body as "not the whole file" and never reproduces
 *    it.
 *
 * A RELATIVE path is not resolved against `root`: `path.resolve` anchors it at
 * `process.cwd()`, which normally puts it outside `root`, where check 1 refuses
 * it and this function returns `null`. Callers must pass the absolute path the
 * recorder stored.
 *
 * Never throws: everything that can fail returns `null`, which the planner
 * reads as "skip this file".
 *
 * @param absPath - the ABSOLUTE path to read.
 * @param root    - the directory the read is confined to (the session's agent
 *                  working directory).
 */
export async function readRecentFileFromDisk(
  absPath: string,
  root: string
): Promise<string | null> {
  try {
    if (typeof absPath !== 'string' || absPath.trim() === '') return null;
    const target = path.resolve(absPath);
    const resolvedRoot = path.resolve(
      typeof root === 'string' && root.trim() === '' ? process.cwd() : root
    );
    if (!isInsidePath(target, resolvedRoot)) return null;

    // 2. The symlink guard. `realpath` throws ENOENT for a file that is gone.
    const realTarget = await realpath(target);
    const realRoot = await realpath(resolvedRoot).catch(() => resolvedRoot);
    if (!isInsidePath(realTarget, realRoot)) return null;

    // 3. Only regular files.
    const stats = await stat(realTarget);
    if (!stats.isFile()) return null;

    const bufferSize = Math.min(stats.size, RECENT_FILES_MAX_READ_BYTES);
    if (bufferSize <= 0) return '';

    // 4. A bounded read: one allocation of at most `RECENT_FILES_MAX_READ_BYTES`.
    const handle = await open(realTarget, 'r');
    let bytesRead = 0;
    let bytes: Uint8Array = new Uint8Array(0);
    try {
      const buffer = Buffer.allocUnsafe(bufferSize);
      const result = await handle.read(buffer, 0, bufferSize, 0);
      bytesRead = result.bytesRead;
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close().catch(() => {});
    }
    if (bytesRead === 0) return '';

    // 5. Binary detection: a NUL byte, or an extension we know is not text.
    if (bytes.includes(0)) return null;
    if (RECENT_FILES_BINARY_EXTENSIONS.has(path.extname(realTarget).slice(1).toLowerCase())) {
      return null;
    }

    // 6. Decode, then mark the cut if the file was longer than the buffer.
    const decoded = Buffer.from(bytes).toString('utf8');
    if (stats.size <= bytesRead) return decoded;
    const lastNewline = decoded.lastIndexOf('\n');
    const head = lastNewline === -1 ? decoded : decoded.slice(0, lastNewline + 1);
    const ended = head.endsWith('\n') || head === '' ? head : `${head}\n`;
    return `${ended}${RECENT_FILES_TRUNCATION_MARKER}`;
  } catch {
    return null;
  }
}
