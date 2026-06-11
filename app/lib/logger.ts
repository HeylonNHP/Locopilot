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
const SEP = '  ';          // column separator (matches the literal used in emit())
const FIELDS_MAX_LENGTH = 200;

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_COLOR: Record<Level, (s: string) => string> = {
    debug: chalk.gray,
    info:  chalk.cyan,
    warn:  chalk.yellow,
    error: chalk.red,
};

const LEVEL_CONSOLE: Record<Level, 'log' | 'warn' | 'error'> = {
    debug: 'log',
    info:  'log',
    warn:  'warn',
    error: 'error',
};

function timestamp(): string {
    return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

function formatFields(fields?: Record<string, unknown>): string {
    if (!fields) return '';
    const inspected = inspect(fields, { colors: true, breakLength: Infinity, depth: 0 });
    if (!inspected || inspected === '{}') return '';
    if (inspected.length > FIELDS_MAX_LENGTH) {
        return inspected.slice(0, FIELDS_MAX_LENGTH - 1) + '\u2026';
    }
    return inspected;
}

function indentMultiline(text: string, indent: string): string {
    if (!text.includes('\n')) return text;
    return text.split('\n').map((line, i) => (i === 0 ? line : indent + line)).join('\n');
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
    console[LEVEL_CONSOLE[level]](line);
}

export const logger = {
    debug: (tag: string, message: string, fields?: Record<string, unknown>) => emit('debug', tag, message, fields),
    info:  (tag: string, message: string, fields?: Record<string, unknown>) => emit('info',  tag, message, fields),
    warn:  (tag: string, message: string, fields?: Record<string, unknown>) => emit('warn',  tag, message, fields),
    error: (tag: string, message: string, fields?: Record<string, unknown>) => emit('error', tag, message, fields),

    group(label: string, fn: () => void): void {
        if (typeof console.group === 'function') {
            console.group(label);
            try { fn(); } finally { console.groupEnd(); }
        } else {
            console.log(`\u250C\u2500 ${label}`);
            try { fn(); } finally { console.log('\u2514\u2500'); }
        }
    },
};
