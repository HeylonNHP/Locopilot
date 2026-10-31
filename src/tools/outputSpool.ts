/**
 * Capture side-car for `run_command` streams.
 *
 * The capture is deliberately split in two: the bytes that reach the model are
 * a bounded preview, the bytes that reach the disk are every byte of the
 * stream. Truncation must never destroy data, so the spool file is the source
 * of truth and the preview is only a view of it — the omitted middle is
 * always recoverable with `read_file`.
 *
 * Both halves are REDACTED, and they are redacted once: the stream passes
 * through `SecretRedactor` before it is split into the file and the preview,
 * so the two can never disagree about what a secret looks like and a raw
 * secret reaches neither.
 *
 * Server-side only: the module touches the filesystem and reads
 * `process.env`, so it must never be pulled into the client bundle.
 */
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { BoundedOutput } from '@/tools/boundedOutput';
import { SecretRedactor } from '@/tools/textSanitizer';

export interface SpoolLimits {
  /** Bytes of a stream that may be inlined into the tool result verbatim. */
  inlineMaxBytes: number;
  /** Bytes kept from the beginning of the stream. */
  headMaxBytes: number;
  /** Bytes kept from the end of the stream. */
  tailMaxBytes: number;
  /** Hard cap on the bytes written to the spool file. */
  maxSpoolBytes: number;
}

export interface SpoolStats {
  /** Bytes seen on the stream, whether or not they reached the disk. */
  totalBytes: number;
  /** Newline-delimited lines seen on the stream. */
  totalLines: number;
  /** True when the preview does not show the whole stream. */
  truncated: boolean;
  /** Bytes of the stream that the preview does not show. */
  omittedBytes: number;
  /** Absolute path of the spool file, or null when nothing was spooled. */
  spoolPath: string | null;
  /** True when the spool file stopped short of the whole stream. */
  spoolTruncated: boolean;
  /**
   * The line number of the LAST line the excerpt shows at the head, in the
   * line numbering of the artifact. Zero when the excerpt has no head.
   */
  headEndLine: number;
  /**
   * The line number of the FIRST line the excerpt shows at the tail, in the
   * line numbering of the artifact. Zero when the excerpt has no tail.
   */
  tailStartLine: number;
  /**
   * True when the last line of the head was cut short because it did not fit
   * into the head budget — the artifact holds that line whole.
   */
  headLineTruncated: boolean;
}

/**
 * Returns true when the run output spill is switched on.
 *
 * The default is ON: without a spool file there is nowhere to recover the
 * omitted bytes from, so the bounded capture would throw data away. An
 * operator can still switch the spill off with `LOCOPILOT_RUN_OUTPUT_SPILL=0`
 * (or `=false`), which restores the historical bounded capture byte for
 * byte.
 */
export function isRunOutputSpillEnabled(): boolean {
  const raw = process.env.LOCOPILOT_RUN_OUTPUT_SPILL;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return true;
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

/**
 * Captures one stream of a command and, when the spill is enabled, keeps
 * every byte of the stream on disk next to a bounded preview for the model.
 *
 * With the spill disabled the capture degrades to the historical bounded
 * behaviour, but it is NOT byte-identical to it: the redaction is
 * unconditional. Redacting is a security property of the capture, not a
 * feature of the spool, so the switch only decides whether the bytes are
 * ALSO written to a file.
 */
export class OutputSpool {
  private readonly limits: SpoolLimits;
  private readonly redactor: SecretRedactor;
  private readonly decoder = new StringDecoder('utf8');
  private readonly legacy: BoundedOutput | null;
  private readonly spoolPath: string | null;
  private readonly headLines: string[] = [];
  private readonly tailLines: string[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private headClosed = false;
  /**
   * The number of lines the head holds. It is the line number of the last
   * line the excerpt shows at the head, in the numbering of the artifact.
   */
  private headLineCount = 0;
  /**
   * The number of lines the artifact holds so far. The tail holds the last
   * of them, so the first line of the tail is this count minus the number
   * of lines the tail holds, plus one.
   */
  private artifactLines = 0;
  /**
   * The line number of the first line the tail holds, in the numbering of
   * the artifact. Zero while the tail is empty.
   */
  private tailFirstLine = 0;
  /**
   * True when the last line of the head was cut short because it did not fit
   * into the head budget — the artifact holds that line whole.
   */
  private headLineTruncated = false;
  private pending = '';
  private inlineText = '';
  private inlineBytes = 0;
  private inlineOverflow = false;
  private totalBytes = 0;
  private newlineCount = 0;
  private endsWithNewline = true;
  private droppedBytes = 0;
  private spooledBytes = 0;
  private spoolTruncated = false;
  /**
   * The trailing partial line, shown in the preview although it has not
   * completed yet. It is cleared as soon as the line completes, so it can
   * never be shown twice.
   */
  private flushedPartial: string | null = null;
  private fd: number | null = null;
  private finished = false;
  private disposed = false;

  constructor(options: {
    limits: SpoolLimits;
    directory: string;
    name: string;
    enabled: boolean;
    /**
     * The redaction pass every byte passes through before it reaches the
     * disk or the preview. The default is a plain redactor; a caller that
     * wants a different policy injects its own.
     */
    redactor?: SecretRedactor | undefined;
  }) {
    this.limits = options.limits;
    this.redactor = options.redactor ?? new SecretRedactor();

    let spoolPath: string | null = null;
    let fd: number | null = null;
    if (options.enabled) {
      const target = path.join(options.directory, options.name);
      try {
        // The artifact holds command output — source code, logs, secrets the
        // redactor did not recognise — so it must be private to its owner
        // from the moment it exists, not only once something describes it.
        // An empty stream is never described, and it would otherwise stay
        // world-readable until the next sweep.
        mkdirSync(options.directory, { recursive: true, mode: 0o700 });
        fd = openSync(target, 'w', 0o600);
        spoolPath = target;
      } catch {
        // A spool that cannot be created must not cost the model its output:
        // fall back to the bounded capture so the command still returns.
        fd = null;
        spoolPath = null;
      }
    }
    this.fd = fd;
    this.spoolPath = spoolPath;

    // Without a spool file there is nowhere to recover the omitted bytes
    // from, so the capture degrades to the historical bounded behaviour.
    this.legacy = spoolPath === null ? new BoundedOutput() : null;
  }

  append(chunk: Buffer): void {
    if (this.finished || this.disposed) return;
    this.totalBytes += chunk.length;
    this.countNewlines(chunk);
    // The redaction is unconditional: it is a security property of the
    // capture, not a feature of the spill. The switch only decides whether
    // the redacted bytes are ALSO written to a file — with the spill off
    // they still never reach the model or the disk unredacted.
    const safe = this.redactor.append(chunk);
    if (this.legacy) {
      this.legacy.append(safe);
      return;
    }
    this.writeSpool(safe);
    this.consumeText(this.decoder.write(safe));
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    // The last line of a stream that did not end with a newline is
    // committed here, redacted like every other line.
    const rest = this.redactor.flush();
    if (this.legacy) {
      this.legacy.append(rest);
      this.legacy.finish();
    } else {
      this.writeSpool(rest);
      this.consumeText(this.decoder.write(rest));
      this.consumeText(this.decoder.end());
      if (this.pending.length > 0) {
        const pending = this.pending;
        this.pending = '';
        // The partial line is pushed as a whole line now; the flushed copy
        // of it has to go, or the preview would show it twice.
        this.flushedPartial = null;
        this.pushLine(pending);
      }
    }
    // The artifact has to be complete on disk before the model is handed a
    // preview of it.
    this.closeSpool();
  }

  /**
   * Shows the trailing partial line in the preview without closing the
   * spool.
   *
   * WHY: the timeout path hands the model a snapshot of a command that is
   * still running. Without the flush the newest bytes of a command that
   * prints without a trailing newline (a progress bar, a log line in
   * flight) stay invisible until the line completes — which may be never.
   *
   * The flushed copy is dropped again as soon as the line completes, so it
   * can never appear twice.
   */
  flush(): void {
    if (this.finished || this.disposed) return;
    // The bounded capture keeps a character-level head and tail; there is
    // no pending line to show.
    if (this.legacy) return;
    // While the whole stream is still inline, the preview already shows
    // everything, including the partial line.
    if (!this.inlineOverflow) return;
    // The partial line lives in the redactor: it is not complete yet, so
    // it is not on the disk either. The preview shows its redacted form.
    const preview = this.redactor.peek().toString('utf8');
    if (preview.length === 0) {
      this.flushedPartial = null;
      return;
    }
    this.flushedPartial = this.fitsFlushedPartial(preview) ? preview : null;
  }

  text(): string {
    if (this.legacy) return this.legacy.text();
    if (!this.inlineOverflow) return this.inlineText + this.partialText();
    return this.headText() + this.tailText();
  }

  /**
   * The trailing incomplete line, redacted.
   *
   * WHY it is asked of the redactor and not of the capture: the redactor
   * holds the incomplete line back until its newline arrives, so this is
   * the only place the newest bytes of a running command can be seen.
   */
  private partialText(): string {
    return this.redactor.peek().toString('utf8');
  }

  preview(): { head: string; tail: string } {
    if (this.legacy) return this.legacy.preview();
    return { head: this.headText(), tail: this.tailText() };
  }

  stats(): SpoolStats {
    if (this.legacy) {
      const preview = this.legacy.preview();
      const kept =
        Buffer.byteLength(preview.head, 'utf8') + Buffer.byteLength(preview.tail, 'utf8');
      return {
        totalBytes: this.totalBytes,
        totalLines: this.totalLines(),
        truncated: this.legacy.truncated,
        omittedBytes: Math.max(0, this.totalBytes - kept),
        spoolPath: this.spoolPath,
        spoolTruncated: this.spoolTruncated,
        // The bounded capture cuts on characters, not on lines, so it has
        // no line range to offer.
        headEndLine: 0,
        tailStartLine: 0,
        headLineTruncated: false,
      };
    }
    return {
      totalBytes: this.totalBytes,
      totalLines: this.totalLines(),
      truncated: this.droppedBytes > 0,
      omittedBytes: this.droppedBytes,
      spoolPath: this.spoolPath,
      spoolTruncated: this.spoolTruncated,
      headEndLine: this.headLineCount,
      tailStartLine: this.tailFirstLine,
      headLineTruncated: this.headLineTruncated,
    };
  }

  /**
   * Replaces the preview with the given text. The spool file keeps the raw
   * bytes, so this only rewrites what the model sees.
   *
   * WHY the line counters survive: the omitted range is a property of the
   * STREAM (the middle that never fit into the excerpt), not of the
   * excerpt's layout, and the text that replaces the excerpt still leaves
   * the same middle out.
   */
  replaceText(text: string): void {
    if (this.legacy) {
      this.legacy.replaceText(text);
      return;
    }
    this.headLines.length = 0;
    this.headLines.push(text);
    this.headBytes = Buffer.byteLength(text, 'utf8');
    this.tailLines.length = 0;
    this.tailBytes = 0;
    this.headClosed = true;
    if (!this.inlineOverflow) {
      this.inlineText = text;
      this.inlineBytes = this.headBytes;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeSpool();
  }

  private countNewlines(chunk: Buffer): void {
    for (const byte of chunk) {
      if (byte === 0x0a) this.newlineCount += 1;
    }
    if (chunk.length > 0) {
      this.endsWithNewline = chunk.at(-1) === 0x0a;
    }
  }

  private totalLines(): number {
    if (this.totalBytes === 0) return 0;
    return this.newlineCount + (this.endsWithNewline ? 0 : 1);
  }

  private writeSpool(payload: Buffer): void {
    if (this.fd === null) return;
    // The payload is already redacted: the redaction happens once, in
    // `consume`, before the bytes are split into the artifact and the
    // preview. The cap below counts the bytes that actually reach the
    // disk, not the bytes the stream produced.
    const room = this.limits.maxSpoolBytes - this.spooledBytes;
    if (room <= 0) {
      this.spoolTruncated = true;
      return;
    }
    const slice = payload.length <= room ? payload : payload.subarray(0, room);
    let written = 0;
    try {
      while (written < slice.length) {
        written += writeSync(this.fd, slice, written, slice.length - written);
      }
    } catch {
      // A failed write leaves a partial artifact behind; report it as
      // truncated so nobody mistakes the file for the complete stream.
      this.spoolTruncated = true;
      this.closeSpool();
      return;
    }
    this.spooledBytes += written;
    if (written < payload.length) this.spoolTruncated = true;
  }

  /**
   * Feeds the redacted bytes of the stream to the preview.
   *
   * WHY the redaction happens before this and only here: the artifact and
   * the preview are two views of ONE stream. Redacting once, before the
   * bytes are split into the two, is what keeps the two views from
   * disagreeing — and what keeps a raw secret from reaching the disk.
   */
  private consumeText(decoded: string): void {
    if (decoded.length === 0) return;
    if (!this.inlineOverflow) {
      this.inlineText += decoded;
      this.inlineBytes += Buffer.byteLength(decoded, 'utf8');
      if (
        this.totalBytes > this.limits.inlineMaxBytes ||
        this.inlineBytes > this.limits.inlineMaxBytes
      ) {
        this.inlineOverflow = true;
        this.inlineText = '';
        this.inlineBytes = 0;
      }
    }

    const buffer = this.pending + decoded;
    this.pending = '';
    let start = 0;
    for (;;) {
      const index = buffer.indexOf('\n', start);
      if (index === -1) break;
      this.pushLine(buffer.slice(start, index + 1));
      // The pending line just completed: the flushed copy of it is stale
      // and the whole line is in the preview now.
      this.flushedPartial = null;
      start = index + 1;
    }
    this.pending = buffer.slice(start);
    if (this.flushedPartial !== null) {
      // The pending line grew. The preview has to show the current text,
      // or nothing at all when it no longer fits.
      this.flushedPartial = this.fitsFlushedPartial(this.pending) ? this.pending : null;
    }
  }

  /**
   * Whether the trailing partial line still fits in the budget of the
   * section it belongs to: the head while the head is open, the tail once
   * the stream has overflowed.
   */
  private fitsFlushedPartial(text: string): boolean {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (this.headClosed) {
      return this.tailBytes + bytes <= this.limits.tailMaxBytes;
    }
    return this.headBytes + bytes <= this.limits.headMaxBytes;
  }

  /**
   * Adds one whole line to the preview. The head takes lines until its byte
   * budget is spent; the rest of the stream goes to the tail. Lines are never
   * split across the seam, so the model can line up the preview with the
   * spool file.
   */
  private pushLine(line: string): void {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (!this.headClosed) {
      if (this.headBytes + lineBytes <= this.limits.headMaxBytes) {
        this.headLines.push(line);
        this.headBytes += lineBytes;
        this.headLineCount += 1;
        this.artifactLines += 1;
        return;
      }
      if (this.headLines.length === 0) {
        // A single line longer than the whole head budget: keep a bounded
        // slice so the preview still starts at the head of the stream. The
        // rest of the line stays in the spool file.
        const slice = sliceHead(line, this.limits.headMaxBytes);
        this.headLines.push(slice);
        this.headBytes = Buffer.byteLength(slice, 'utf8');
        this.droppedBytes += lineBytes - this.headBytes;
        this.headClosed = true;
        this.headLineCount = 1;
        this.artifactLines += 1;
        // The excerpt shows a FRACTION of this line; the artifact holds it
        // whole, so the model has to know that the two differ here.
        this.headLineTruncated = true;
        return;
      }
      this.headClosed = true;
    }
    this.pushTail(line);
  }

  private pushTail(line: string): void {
    this.tailLines.push(line);
    this.tailBytes += Buffer.byteLength(line, 'utf8');
    this.artifactLines += 1;
    // Whole lines are dropped from the front until the tail fits its budget.
    while (this.tailBytes > this.limits.tailMaxBytes && this.tailLines.length > 1) {
      const removed = this.tailLines.shift();
      this.tailBytes -= Buffer.byteLength(removed ?? '', 'utf8');
      this.droppedBytes += Buffer.byteLength(removed ?? '', 'utf8');
    }
    if (this.tailLines.length === 1 && this.tailBytes > this.limits.tailMaxBytes) {
      // One line longer than the whole tail budget: keep its tail so the
      // preview still ends at the end of the stream.
      const trimmed = sliceTail(this.tailLines[0] ?? '', this.limits.tailMaxBytes);
      this.tailLines[0] = trimmed;
      this.droppedBytes += this.tailBytes - Buffer.byteLength(trimmed, 'utf8');
      this.tailBytes = Buffer.byteLength(trimmed, 'utf8');
    }
    // The tail holds the LAST lines of the artifact, so the line number of
    // its first line is the last line number minus the number of lines it
    // holds, plus one.
    this.tailFirstLine = this.artifactLines - this.tailLines.length + 1;
  }

  private headText(): string {
    return this.headLines.join('');
  }

  private tailText(): string {
    // The flushed partial line is the newest data, so it belongs at the
    // very end of the preview.
    return this.tailLines.join('') + (this.flushedPartial ?? '');
  }

  private closeSpool(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      /* the handle is already gone */
    }
    this.fd = null;
  }
}

/** Keeps the first `maxBytes` bytes of a string without splitting a character. */
function sliceHead(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  return new StringDecoder('utf8').write(buffer.subarray(0, maxBytes));
}

/** Keeps the last `maxBytes` bytes of a string without splitting a character. */
function sliceTail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  // Walk past the continuation bytes so the slice starts on a character.
  while (start < buffer.length) {
    const byte = buffer[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    start += 1;
  }
  return new StringDecoder('utf8').write(buffer.subarray(start));
}
