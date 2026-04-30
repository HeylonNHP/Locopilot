import chalk from 'chalk';
import { isAbsolute, parse } from 'node:path';
import { getTerminalWidth } from '../terminalWidth';

export interface ToolOutputSink {
    writeLine(message: string): void;
    writeInline(message: string): void;
    clearInline(): void;
}

export type ConfirmationPrompt = (message: string) => Promise<boolean>;

export type ToolTranscriptTone = 'info' | 'success' | 'warning' | 'error';

export type ToolTranscriptRowKind = 'text' | 'path' | 'block';

export interface ToolTranscriptRow {
    label: string;
    value: string;
    kind?: ToolTranscriptRowKind;
}

export interface ToolTranscriptOptions {
    title: string;
    tone?: ToolTranscriptTone;
    rows?: ToolTranscriptRow[];
    trailer?: string;
    terminalWidth?: number;
}

function indentLines(text: string, indent: string): string {
    return text
        .split(/\r?\n/)
        .map((line) => indent + line)
        .join('\n');
}

function shortenAbsolutePathIfNeeded(value: string, maxWidth: number): string {
    if (maxWidth <= 0 || !isAbsolute(value) || value.length <= maxWidth) {
        return value;
    }

    const root = parse(value).root;
    if (!root) {
        return value;
    }

    const separator = value.includes('\\') ? '\\' : '/';
    const segments = value
        .slice(root.length)
        .split(/[\\/]+/)
        .filter((segment) => segment.length > 0);

    if (segments.length === 0) {
        return value.length <= maxWidth ? value : value.slice(-maxWidth);
    }

    for (let tailCount = Math.min(segments.length, 3); tailCount >= 1; tailCount -= 1) {
        const tail = segments.slice(-tailCount).join(separator);
        const candidate = `${root}...${separator}${tail}`;
        if (candidate.length <= maxWidth) {
            return candidate;
        }
    }

    if (segments.length > 3) {
        const head = segments[0] ?? '';
        const tail = segments[segments.length - 1] ?? '';
        const candidate = `${root}${head}${separator}...${separator}${tail}`;
        if (candidate.length <= maxWidth) {
            return candidate;
        }
    }

    const tail = segments[segments.length - 1] ?? '';
    const tailBudget = Math.max(1, maxWidth - root.length - 4);
    const tailSlice = tail.length > tailBudget ? tail.slice(-tailBudget) : tail;
    const fallback = `${root}...${separator}${tailSlice}`;
    if (fallback.length <= maxWidth) {
        return fallback;
    }

    return fallback.slice(-maxWidth);
}

function formatTranscriptTitle(title: string, tone: ToolTranscriptTone): string {
    switch (tone) {
        case 'success':
            return chalk.green.bold(title);
        case 'warning':
            return chalk.yellow.bold(title);
        case 'error':
            return chalk.red.bold(title);
        default:
            return chalk.cyan.bold(title);
    }
}

export function formatToolTranscript(options: ToolTranscriptOptions): string {
    const rows = options.rows ?? [];
    const width = options.terminalWidth ?? getTerminalWidth();
    const labelWidth = rows.reduce((max, row) => Math.max(max, row.label.length), 0);
    const lines = [formatTranscriptTitle(options.title, options.tone ?? 'info')];

    for (const row of rows) {
        if (row.kind === 'block') {
            lines.push(`  ${row.label}:`);
            lines.push(indentLines(row.value.length > 0 ? row.value : '(empty)', '    '));
            continue;
        }

        const paddedLabel = row.label.padEnd(labelWidth);
        const prefix = `  ${paddedLabel}: `;
        const availableWidth = width - prefix.length;
        const value = row.kind === 'path'
            ? shortenAbsolutePathIfNeeded(row.value, availableWidth)
            : row.value;

        lines.push(prefix + value);
    }

    if (options.trailer && options.trailer.trim().length > 0) {
        lines.push(indentLines(options.trailer.trimEnd(), '  '));
    }

    return lines.join('\n');
}

export const terminalToolOutputSink: ToolOutputSink = {
    writeLine(message: string): void {
        this.clearInline();
        console.log(message);
    },
    writeInline(message: string): void {
        process.stdout.write(message);
    },
    clearInline(): void {
        if (!process.stdout.isTTY) {
            return;
        }

        process.stdout.cursorTo(0);
        process.stdout.clearLine(0);
    },
};

let activeOutputSink: ToolOutputSink = terminalToolOutputSink;

export function getActiveOutputSink(): ToolOutputSink {
    return activeOutputSink;
}

export function setActiveOutputSink(sink: ToolOutputSink): void {
    activeOutputSink = sink;
}
