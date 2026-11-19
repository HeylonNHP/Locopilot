/**
 * Runs a model-supplied regular expression over the lines of one file with a
 * hard time limit.
 *
 * Why not just `regex.exec(line)` in a loop: a pattern with nested repetition
 * (`(a+)+$`) takes time that doubles with every character of the line it
 * fails on (measured: 2.4 s on a 29-character line), and a JavaScript regular
 * expression cannot be interrupted from the same thread. The server that runs
 * the tools also runs every conversation, so one such pattern would freeze
 * them all. A `vm` script run with `timeout` is interrupted by the engine, so
 * the loop lives in one.
 */
import vm from 'node:vm';

/** One line that matched: its 0-based index in the list, and where the match starts in it. */
export interface LineHit {
  lineIndex: number;
  matchIndex: number;
}

/** The pattern did not finish within the time given. */
export class PatternTimeoutError extends Error {
  constructor() {
    super('the pattern did not finish within the time limit');
    this.name = 'PatternTimeoutError';
  }
}

// A trailing \r is removed before matching, so `$` works in a Windows file.
const SCAN_SOURCE = `(function () {
  const found = [];
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    const match = re.exec(line);
    if (match) {
      found.push(index, match.index);
      if (found.length >= limit * 2) break;
    }
  }
  return found;
})()`;

export class LineScanner {
  private readonly script = new vm.Script(SCAN_SOURCE);
  private readonly sandbox: { re: RegExp; lines: string[]; limit: number };
  private readonly context: vm.Context;

  /** `matcher` must not carry the `g` or `y` flag: `exec` would then remember a position between lines. */
  constructor(matcher: RegExp) {
    this.sandbox = { re: matcher, lines: [], limit: 0 };
    this.context = vm.createContext(this.sandbox);
  }

  /**
   * The first `limit` matching lines, in order. Throws {@link PatternTimeoutError}
   * when the scan is still running after `timeoutMs` milliseconds.
   */
  scan(lines: string[], limit: number, timeoutMs: number): LineHit[] {
    this.sandbox.lines = lines;
    this.sandbox.limit = limit;
    let flat: number[];
    try {
      flat = this.script.runInContext(this.context, { timeout: Math.max(1, Math.ceil(timeoutMs)) });
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
      ) {
        throw new PatternTimeoutError();
      }
      throw err;
    } finally {
      this.sandbox.lines = [];
    }
    const hits: LineHit[] = [];
    for (let position = 0; position < flat.length; position += 2) {
      hits.push({ lineIndex: flat[position]!, matchIndex: flat[position + 1]! });
    }
    return hits;
  }
}
