/**
 * The control sequences that are removed from command output.
 *
 * WHY the 8-bit CSI forms are spelled out: the capture works on the RAW BYTES
 * of the stream (the artifact has to keep the invalid UTF-8), so the
 * stripping happens on the byte level. A CSI sequence is introduced by ESC
 * (0x1b), by the UTF-8 encoding of U+009B (0xc2 0x9b) or by the raw 0x9b
 * byte — and the raw byte is only a control character when it does not
 * continue a UTF-8 sequence, which is what the look-behind checks. Without
 * that check the third byte of a three-byte character (U+201B, for example)
 * would be eaten and the character destroyed.
 */
const CONTROL_SEQUENCE = new RegExp(
  [
    `${String.fromCodePoint(0x1b)}[#();?[]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\d<=>A-ORZcf-nqry]`,
    `${String.fromCodePoint(0xc2)}${String.fromCodePoint(0x9b)}[#();?[]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\d<=>A-ORZcf-nqry]`,
    `(?<![\\u0080-\\u00f4])${String.fromCodePoint(0x9b)}[#();?[]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\d<=>A-ORZcf-nqry]`,
  ].join('|'),
  'g'
);

/**
 * Removes the terminal control sequences and the carriage returns from a
 * piece of text.
 *
 * WHY the carriage return goes instead of being normalised: a CR in front of
 * a LF is the CRLF of a Windows line ending, and a CR in front of anything
 * else is a cursor move that would overwrite text the model has already
 * read. Dropping every CR turns both into what the model should see.
 */
export function stripControlSequences(text: string): string {
  return text.replaceAll('\r', '').replaceAll(CONTROL_SEQUENCE, '');
}

/**
 * Strips terminal control sequences before command output is sent to the model.
 * Kept in a leaf module so command execution does not depend on the tool registry.
 *
 * The capture does this itself, in the pass that redacts (see
 * {@link SecretRedactor}); this helper is the same rule for a piece of text
 * that is already decoded.
 */
export function sanitize(text: string): string {
  return stripControlSequences(text);
}

/**
 * The text that stands in for a secret.
 *
 * WHY a fixed marker: the model has to be able to tell "a secret was here"
 * from "the command printed nothing here". A marker that looks like ordinary
 * output would be read as data.
 */
export const REDACTED = '[REDACTED]';

/** One redaction rule: a pattern and what replaces it. */
interface RedactionRule {
  /**
   * The pattern. It has to stay LINEAR: a rule that can backtrack into an
   * exponential number of states would hang on a single huge line, and a
   * command is free to print one.
   */
  readonly pattern: RegExp;
  /** The replacement, with `$1` style references to the pattern's groups. */
  readonly replacement: string;
}

/**
 * The rules, in the order they are applied.
 *
 * Every rule keeps the label and drops the value: the model still learns
 * WHICH credential leaked (an `api_key=` tells it more than a bare marker)
 * without learning the credential itself.
 */
const REDACTION_RULES: readonly RedactionRule[] = [
  // An Authorization header: the scheme stays, the credential goes.
  {
    pattern: /\b(authorization\s*:\s*)(bearer|basic|token)\s+([\w+./=~-]+)/gi,
    replacement: `$1$2 ${REDACTED}`,
  },
  // A bearer token on its own — in a header the rule above did not match,
  // or in a log line that printed the scheme without the label. The token
  // has to be long enough to be a token: "a bearer of bad news" is prose.
  {
    pattern: /\b(bearer)\s+([\w+./=~-]{6,})/gi,
    replacement: `$1 ${REDACTED}`,
  },
  // A JSON web token: three base64url segments, the first one always "eyJ".
  // The segments are bounded on purpose: an unbounded segment would make
  // the rule scan the rest of a 10 MB line for every "eyJ" in it, which is
  // quadratic.
  {
    pattern: /\beyJ[\w=-]{0,64}(?:\.[\w=-]{1,4096}){2}/g,
    replacement: REDACTED,
  },
  // OpenAI-style API keys ("sk-", "sk-proj-") and their underscore spelling.
  {
    pattern: /\bsk[_-][\w-]+/g,
    replacement: REDACTED,
  },
  // Slack tokens (bot, app, user, workspace and refresh tokens).
  {
    pattern: /\bxox[abprs]-[\w-]+/g,
    replacement: REDACTED,
  },
  // GitHub personal, OAuth, server and refresh tokens.
  {
    pattern: /\bgh[oprs]_\w+/g,
    replacement: REDACTED,
  },
  // GitHub fine-grained personal access tokens.
  {
    pattern: /\bgithub_pat_\w+/g,
    replacement: REDACTED,
  },
  // GitLab personal access tokens.
  {
    pattern: /\bglpat-[\w-]+/g,
    replacement: REDACTED,
  },
  // AWS access key identifiers.
  {
    pattern: /\b(?:AKIA|ASIA)[\dA-Z]{16}\b/g,
    replacement: REDACTED,
  },
  // Google API keys.
  {
    pattern: /\bAIza[\w-]{35}\b/g,
    replacement: REDACTED,
  },
  // A credential in a query string or in an environment assignment. The
  // value ends at the first space, quote, ampersand, semicolon or comma.
  // The key has to START with the secret word: a rule that matches a
  // variable-length prefix would rescan the line for every candidate.
  {
    pattern:
      /\b((?:secret|token|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|credential)s?\s*=\s*)(?:"[^\n"]*"|'[^\n']*'|[^\s&,;]+)/gi,
    replacement: `$1${REDACTED}`,
  },
  // The same credentials in a YAML file, where the separator is a colon.
  // "token" is left out on purpose: "token: expired" is prose.
  {
    pattern:
      /\b((?:password|passwd|secret|api[_-]?key|apikey|private[_-]?key|credential)s?\s*:\s*)(?:"[^\n"]*"|'[^\n']*'|[^\s&,;]+)/gi,
    replacement: `$1${REDACTED}`,
  },
  // The environment variables that are secret by name. They are spelled out
  // instead of matched by a suffix, for the reason given above.
  {
    pattern:
      /\b((?:aws_secret_access_key|aws_session_token|github_token|gitlab_token|slack_token|openai_api_key|anthropic_api_key|google_api_key|npm_token)\s*=\s*)(?:"[^\n"]*"|'[^\n']*'|[^\s&,;]+)/gi,
    replacement: `$1${REDACTED}`,
  },
];

/** The header that opens a PEM key block. */
const PRIVATE_KEY_BEGIN = /-{5}begin [\d a-z]*private key-{5}/i;
/** The header that closes a PEM key block. */
const PRIVATE_KEY_END = /-{5}end [\d a-z]*private key-{5}/i;
/** The same two, but able to walk a whole text. */
const PRIVATE_KEY_BEGIN_SCAN = /-{5}begin [\d a-z]*private key-{5}/gi;
const PRIVATE_KEY_END_SCAN = /-{5}end [\d a-z]*private key-{5}/gi;

/**
 * Applies the value rules to a piece of text.
 *
 * The rules are independent of each other, so a plain sequence of global
 * replacements is enough — and it keeps every rule linear.
 */
function applyValueRules(text: string): string {
  let result = text;
  for (const rule of REDACTION_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/**
 * Removes whole PEM private key blocks.
 *
 * WHY a scan and not one regex: the obvious pattern
 * `BEGIN ... PRIVATE KEY-----[\s\S]*?END ... PRIVATE KEY-----` costs O(n)
 * for EVERY header it finds, so a text with many headers would be
 * quadratic. The scan walks every block exactly once.
 */
function redactPrivateKeyBlocks(text: string): string {
  if (!text.includes('PRIVATE KEY')) return text;
  let result = '';
  let cursor = 0;
  PRIVATE_KEY_BEGIN_SCAN.lastIndex = 0;
  for (;;) {
    const begin = PRIVATE_KEY_BEGIN_SCAN.exec(text);
    if (!begin) break;
    const start = begin.index;
    PRIVATE_KEY_END_SCAN.lastIndex = start + begin[0].length;
    const end = PRIVATE_KEY_END_SCAN.exec(text);
    if (!end) {
      // An unterminated block: everything from the header on is key
      // material, so the rest of the text goes with it.
      return result + text.slice(cursor, start) + REDACTED;
    }
    result += text.slice(cursor, start) + REDACTED;
    cursor = end.index + end[0].length;
    PRIVATE_KEY_BEGIN_SCAN.lastIndex = cursor;
  }
  return result + text.slice(cursor);
}

/**
 * Replaces the secrets in a piece of text with {@link REDACTED}.
 *
 * The function is pure and linear: it never looks outside the text it is
 * given and it never backtracks into an exponential number of states, so a
 * single enormous line costs one pass and no more.
 *
 * It redacts and nothing else — the control sequences are stripped by the
 * capture, in the same pass that redacts (see {@link SecretRedactor}).
 */
export function redact(text: string): string {
  return applyValueRules(redactPrivateKeyBlocks(text));
}

/**
 * Redacts the secrets out of a stream of bytes, one line at a time.
 *
 * WHY lines: the output of a command arrives in arbitrary chunks, and a
 * secret that straddles a chunk boundary would survive a per-chunk pass
 * (the head of it in one chunk, the tail in the next, neither of them a
 * match). A line is only complete when its newline arrives, so the
 * redaction always sees the whole secret. A secret does not span a newline
 * — the one exception, a PEM key block, is tracked with its own state.
 *
 * WHY bytes: the artifact has to hold the stream's bytes, invalid UTF-8
 * included. The text is decoded as latin1, which maps every byte to one
 * code point, so the ASCII patterns match exactly and the bytes that are
 * not part of a secret survive untouched.
 *
 * WHY the pending line is kept as pieces and not as one string: a command is
 * free to print a single enormous line, and a pending buffer that is
 * re-scanned (and re-copied) on every append makes the capture quadratic in
 * the length of that line — ten megabytes took 29 ms, a hundred took 2.3 s,
 * and the server stalled for the whole of it. The pieces are appended and
 * joined exactly once, when the line completes, so an append costs the chunk
 * and nothing else. The rules themselves are line-local (a quoted value
 * cannot span a newline), which is what makes the line the natural unit.
 */
export class SecretRedactor {
  /** The pieces of the trailing incomplete line, in order. */
  private pendingParts: string[] = [];
  /** The length of the trailing incomplete line, in characters. */
  private pendingLength = 0;
  private insidePrivateKey = false;

  /**
   * Feeds bytes and returns the redacted bytes of every COMPLETE line.
   *
   * The trailing incomplete line is held back until its newline arrives, so
   * a secret is never split across two calls.
   */
  append(chunk: Buffer): Buffer {
    const text = chunk.toString('latin1');
    if (text.length === 0) return Buffer.alloc(0);
    let output = '';
    let start = 0;
    for (;;) {
      // The newline is looked for in the NEW chunk only. Scanning the whole
      // pending buffer on every append is what made the capture quadratic.
      const index = text.indexOf('\n', start);
      if (index === -1) break;
      output += this.redactLine(this.takeLine(text.slice(start, index + 1)), true);
      start = index + 1;
    }
    if (start < text.length) {
      this.pendingParts.push(text.slice(start));
      this.pendingLength += text.length - start;
    }
    return Buffer.from(output, 'latin1');
  }

  /**
   * The redacted form of the trailing incomplete line.
   *
   * WHY it exists: the timeout path hands the model a snapshot of a command
   * that is still running, and its newest line has not ended yet. The
   * preview never commits — the line is redacted again, properly, when it
   * completes.
   */
  peek(): Buffer {
    if (this.pendingLength === 0) return Buffer.alloc(0);
    return Buffer.from(this.redactLine(this.pendingParts.join(''), false), 'latin1');
  }

  /**
   * Commits the trailing incomplete line and returns it, redacted.
   *
   * Called once, when the stream is over: the line will never be completed
   * by more output.
   */
  flush(): Buffer {
    if (this.pendingLength === 0) return Buffer.alloc(0);
    const line = this.pendingParts.join('');
    this.pendingParts = [];
    this.pendingLength = 0;
    return Buffer.from(this.redactLine(line, true), 'latin1');
  }

  /**
   * Joins the pending pieces with the tail of the line that just completed
   * and empties the pending buffer.
   */
  private takeLine(tail: string): string {
    const line = this.pendingParts.length > 0 ? `${this.pendingParts.join('')}${tail}` : tail;
    this.pendingParts = [];
    this.pendingLength = 0;
    return line;
  }

  /**
   * Redacts one line and strips its control sequences.
   *
   * WHY the stripping happens HERE and not on the preview: the artifact and
   * the preview are two views of ONE stream. Stripping in the same pass
   * that redacts is what keeps the two views from disagreeing — the file on
   * the disk holds exactly what the model was shown.
   */
  private redactLine(line: string, commit: boolean): string {
    return stripControlSequences(this.redactSecrets(line, commit));
  }

  /**
   * Redacts one line.
   *
   * `commit` is false for a preview: the state of the key-block tracker
   * must not move before the line is really finished.
   */
  private redactSecrets(line: string, commit: boolean): string {
    if (this.insidePrivateKey) {
      const end = PRIVATE_KEY_END.exec(line);
      if (!end) return '';
      if (commit) this.insidePrivateKey = false;
      // The marker was already emitted where the block started; only the
      // text after the block survives.
      return applyValueRules(line.slice(end.index + end[0].length));
    }
    const begin = PRIVATE_KEY_BEGIN.exec(line);
    if (!begin) return applyValueRules(line);
    const after = line.slice(begin.index + begin[0].length);
    const end = PRIVATE_KEY_END.exec(after);
    if (end) {
      // The whole block fits on this line.
      return (
        applyValueRules(line.slice(0, begin.index)) +
        REDACTED +
        applyValueRules(after.slice(end.index + end[0].length))
      );
    }
    // The block continues on the next line: swallow it until it ends.
    if (commit) this.insidePrivateKey = true;
    return applyValueRules(line.slice(0, begin.index)) + REDACTED;
  }
}
