/**
 * app/lib/logger.ts
 *
 * Tiny server-side logger: chalk-colored tags, timestamps, structured fields,
 * and a group() wrapper. No external deps beyond chalk@5 (already installed).
 */
import chalk from 'chalk';
import { inspect } from 'node:util';

const TAG_WIDTH = 12;
const TIMESTAMP_WIDTH = 8; // "HH:MM:SS"
const SEP = '  '; // column separator (matches the literal used in emit())
const FIELDS_MAX_LENGTH = 200;

// ANSI escape sequence pattern: matches CSI (ESC[) and OSC (ESC]) forms,
// including the 7-bit ESC introducer and the parameter / intermediate /
// final bytes that follow. Covers both SGR (color) and cursor-control
// sequences — enough to strip chalk's color codes for length measurement.
const ESC = String.fromCodePoint(0x001b);
const BELL = String.fromCodePoint(0x0007);
const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`${ESC}\[(?:\d{1,3}(?:;\d{1,3})*)?[A-Za-z]|${ESC}][^${ESC}]*(?:${ESC}[${BELL}\\]|.)`,
  'g'
);

function stripAnsi(input: string): string {
  return input.replaceAll(ANSI_ESCAPE_PATTERN, '');
}

// Shared Date instance — avoids one `new Date()` allocation per log call.
const sharedDate = new Date();

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_COLOR: Record<Level, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
};

const LEVEL_CONSOLE: Record<Level, 'log' | 'warn' | 'error'> = {
  debug: 'log',
  info: 'log',
  warn: 'warn',
  error: 'error',
};

function timestamp(): string {
  sharedDate.setTime(Date.now());
  return sharedDate.toISOString().slice(11, 19); // HH:MM:SS
}

function formatFields(fields?: Record<string, unknown>): string {
  if (!fields) return '';
  const inspected = inspect(fields, { colors: true, breakLength: Infinity, depth: 0 });
  if (!inspected || inspected === '{}') return '';
  const visible = stripAnsi(inspected);
  if (visible.length > FIELDS_MAX_LENGTH) {
    // Slice the *visible* string so we never cut a multi-byte ANSI escape
    // mid-sequence (which would leave the trailing log lines mis-colored).
    // The plain ellipsis is appended after stripping, so it does not get
    // mangled by chalk's color-codes and renders consistently.
    return `${visible.slice(0, FIELDS_MAX_LENGTH - 1)  }…`;
  }
  return inspected;
}

function indentMultiline(text: string, indent: string): string {
  if (!text.includes('\n')) return text;
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : indent + line))
    .join('\n');
}

function emit(level: Level, tag: string, message: string, fields?: Record<string, unknown>): void {
  const ts = chalk.gray(timestamp());
  const coloredTag = LEVEL_COLOR[level](tag.padEnd(TAG_WIDTH));
  // Continuation lines align under the start of the message column:
  //   HH:MM:SS (8) + SEP (2) + TAG (12) + SEP (2) = 24 spaces of leading indent.
  const messageIndent = ' '.repeat(TIMESTAMP_WIDTH + SEP.length + TAG_WIDTH + SEP.length);
  const boldMsg = chalk.bold(indentMultiline(message, messageIndent));
  const suffix = formatFields(fields);
  const line = suffix
    ? `${ts}${SEP}${coloredTag}${SEP}${boldMsg}${SEP}${suffix}`
    : `${ts}${SEP}${coloredTag}${SEP}${boldMsg}`;
  // eslint-disable-next-line no-console -- this logger IS the abstraction over console; all log output funnels through here.
  console[LEVEL_CONSOLE[level]](line);
}

export const logger = {
  debug: (tag: string, message: string, fields?: Record<string, unknown>) =>
    emit('debug', tag, message, fields),
  info: (tag: string, message: string, fields?: Record<string, unknown>) =>
    emit('info', tag, message, fields),
  warn: (tag: string, message: string, fields?: Record<string, unknown>) =>
    emit('warn', tag, message, fields),
  error: (tag: string, message: string, fields?: Record<string, unknown>) =>
    emit('error', tag, message, fields),

  group(label: string, fn: () => void): void {
    // eslint-disable-next-line no-console -- typeof check on console.group is not a call but the rule flags property access.
    if (typeof console.group === 'function') {
      // eslint-disable-next-line no-console -- logger.group() wraps console.group/groupEnd as the public API.
      console.group(label);
      try {
        fn();
      } finally {
        // eslint-disable-next-line no-console -- paired with the console.group above.
        console.groupEnd();
      }
    } else {
      // eslint-disable-next-line no-console -- polyfill fallback when console.group is unavailable.
      console.log(`\u250C\u2500 ${label}`);
      try {
        fn();
      } finally {
        // eslint-disable-next-line no-console -- closing polyfill fallback.
        console.log('\u2514\u2500');
      }
    }
  },
};
