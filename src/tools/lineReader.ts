import type { FileHandle } from 'node:fs/promises';

/** Bytes read from a file in one read. A file is read in pieces, so its length is not limited. */
export const READ_PIECE_BYTES = 256 * 1024;
/** Lines handed to the matcher at a time. */
export const BATCH_LINES = 4096;
/** Characters handed to the matcher at a time, so a batch of long lines stays small. */
export const BATCH_CHARS = 1024 * 1024;

/** The sizes a file is read and matched in. Tests make them small to reach the edges. */
export interface LineReadSizes {
  pieceBytes: number;
  batchLines: number;
  batchChars: number;
}

export const DEFAULT_LINE_READ_SIZES: LineReadSizes = {
  pieceBytes: READ_PIECE_BYTES,
  batchLines: BATCH_LINES,
  batchChars: BATCH_CHARS,
};

/** Reading or decoding a file failed. `reason` is the error that failed. */
export class FileReadError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super('the file could not be read');
    this.name = 'FileReadError';
    this.reason = reason;
  }
}

/**
 * Reads the lines of files in batches. One reader serves a whole search and
 * reads one file at a time, so it owns one buffer for all of them.
 *
 * The split is the one search_files has always used: lines end at "\n" (a "\r"
 * before it stays here; the matcher removes it), the piece after a final "\n" is
 * not a line, and a file with no "\n" at all is one line, empty or not. A byte
 * order mark is kept, as Buffer.toString keeps it.
 */
export class LineReader {
  private readonly sizes: LineReadSizes;
  private readonly piece: Buffer;

  constructor(sizes: LineReadSizes = DEFAULT_LINE_READ_SIZES) {
    this.sizes = sizes;
    this.piece = Buffer.allocUnsafe(sizes.pieceBytes);
  }

  /**
   * The lines of an open file, `batchLines` at a time, in order. `keepGoing` is
   * asked before each read; when it answers false the reader stops and yields
   * nothing more, so lines read but not yet passed on are not searched. A
   * failure while reading or decoding is thrown as a {@link FileReadError};
   * anything else is not wrapped.
   */
  batches(handle: FileHandle, keepGoing: () => boolean): AsyncGenerator<string[]> {
    return this.wrapFailures(handle, keepGoing);
  }

  private async *wrapFailures(
    handle: FileHandle,
    keepGoing: () => boolean
  ): AsyncGenerator<string[]> {
    try {
      yield* this.linesOf(handle, keepGoing);
    } catch (err) {
      throw new FileReadError(err);
    }
  }

  private async *linesOf(handle: FileHandle, keepGoing: () => boolean): AsyncGenerator<string[]> {
    const { sizes, piece } = this;
    // ignoreBOM keeps a byte order mark in the text, as the whole-file read did.
    const decoder = new TextDecoder('utf8', { ignoreBOM: true });
    /** Pieces of the line in progress, joined only when the line ends. */
    let partial: string[] = [];
    let batch: string[] = [];
    let batchChars = 0;
    let sawLineBreak = false;

    for (;;) {
      if (!keepGoing()) return;
      const { bytesRead } = await handle.read(piece, 0, sizes.pieceBytes, null);
      const atEnd = bytesRead === 0;
      const text = decoder.decode(piece.subarray(0, bytesRead), { stream: !atEnd });

      let start = 0;
      let end = text.indexOf('\n');
      while (end !== -1) {
        sawLineBreak = true;
        const head = text.slice(start, end);
        const line = partial.length === 0 ? head : partial.join('') + head;
        partial = [];
        batch.push(line);
        batchChars += line.length;
        start = end + 1;
        if (batch.length >= sizes.batchLines || batchChars >= sizes.batchChars) {
          yield batch;
          batch = [];
          batchChars = 0;
        }
        end = text.indexOf('\n', start);
      }
      const rest = text.slice(start);
      if (rest !== '') partial.push(rest);
      if (atEnd) break;
    }

    const tail = partial.join('');
    if (tail !== '' || !sawLineBreak) batch.push(tail);
    if (batch.length > 0) yield batch;
  }
}
