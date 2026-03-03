import readline from 'readline';
import chalk from 'chalk';

type StatusSnapshot = {
    phase: string;
    tokensUsed: number;
    tokenLimit: number;
    model?: string;
    tokenSource?: 'estimated' | 'ollama';
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

    const left = `${chalk.dim(frame)} ${state.phase} ${chalk.dim(state.model ? '[' + state.model + ']' : '')}`.trim();
    const right = `${pctColor(`${state.tokensUsed}/${state.tokenLimit} tokens`)} ${chalk.dim(`(${pct}%)`)}${state.tokenSource === 'ollama' ? chalk.cyan.dim(' (ollama)') : ''}`;

    const cols = out.columns || 80;
    const gap = Math.max(1, cols - stringWidth(left) - stringWidth(right));

    readline.cursorTo(out, 0);
    readline.clearLine(out, 0);
    out.write(left + ' '.repeat(gap) + right);
}

function stringWidth(s: string) {
    return [...s].length;
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
    };
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
