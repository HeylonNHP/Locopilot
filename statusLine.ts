/**
 * Status line helper for Locopilot's terminal UI.
 *
 * This module maintains a small live-line display while the assistant is
 * thinking or tools are executing. It shows the current phase, optional model
 * name, and token usage with a spinner. The status line is updated on a short
 * interval and cleared when the turn is complete.
 */
import readline from 'readline';
import chalk from 'chalk';
import { getTerminalWidth } from './terminalWidth.js';

type StatusSnapshot = {
    phase: string;
    tokensUsed: number;
    tokenLimit: number;
    model?: string;
    tokenSource?: 'estimated' | 'ollama';
    vramUsed?: number | undefined;
};

let state: StatusSnapshot | null = null;
let ticker: NodeJS.Timeout | null = null;
let spinner = 0;
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function render() {
    const out = process.stdout;
    if (!out || !out.isTTY || !state) return;

    const pct = state.tokenLimit > 0
        ? Math.min(100, Math.round((state.tokensUsed / state.tokenLimit) * 100))
        : 0;

    const frame = FRAMES[(spinner++ ) % FRAMES.length];
    const pctColor = pct >= 90 ? chalk.red : pct >= 75 ? chalk.yellow : chalk.green;

    const left = `${chalk.dim(frame)} ${formatPhase(state.phase)} ${chalk.dim(state.model ? '[' + state.model + ']' : '')}`.trim();
    let right = state.tokenSource === 'ollama'
        ? `${pctColor(`${state.tokensUsed}/${state.tokenLimit} tokens`)} ${chalk.dim(`(${pct}%)`)}${chalk.cyan.dim(' (ollama)')}`
        : `${pctColor(`${pct}%`)}${chalk.dim(' (estimated)')}`;

    if (state.vramUsed !== undefined && state.vramUsed > 0) {
        const gb = (state.vramUsed / (1024 ** 3)).toFixed(1);
        right += chalk.dim(' | ') + chalk.cyan(`VRAM: ${gb} GB`);
    }

    const cols = getTerminalWidth(out);
    const gap = Math.max(1, cols - stringWidth(left) - stringWidth(right));

    readline.cursorTo(out, 0);
    readline.clearLine(out, 0);
    out.write(left + ' '.repeat(gap) + right);
}

function stringWidth(s: string) {
    const stripped = s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
    return [...stripped].length;
}

function formatPhase(phase: string): string {
    if (phase.startsWith('Tool call:')) {
        return chalk.cyan.bold(phase);
    }
    return phase;
}

export function updateLiveStatus(next: StatusSnapshot) {
    state = next;
    render();
    if (ticker) return;
    ticker = setInterval(render, 120);
    ticker.unref();
}

export function updatePhase(phase: string, stats?: Partial<Omit<StatusSnapshot, 'phase'>>) {
    state = {
        phase,
        tokensUsed: stats?.tokensUsed ?? state?.tokensUsed ?? 0,
        tokenLimit: stats?.tokenLimit ?? state?.tokenLimit ?? 0,
        model: stats?.model ?? state?.model ?? '',
        tokenSource: stats?.tokenSource ?? state?.tokenSource ?? 'estimated',
        vramUsed: stats?.vramUsed ?? state?.vramUsed ?? undefined,
    };
    render();
}

export function updateVram(usedBytes?: number) {
    if (!state) return;
    state.vramUsed = usedBytes;
    render();
}

export function clearLiveStatus() {
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
    state = null;
    if (!process.stdout.isTTY) return;
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
}
