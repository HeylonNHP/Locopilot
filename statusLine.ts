import readline from 'readline';
import chalk from 'chalk';

let timer: NodeJS.Timeout | null = null;
let frameIndex = 0;
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface StatusSnapshot {
    phase: string;
    tokensUsed: number;
    tokenLimit: number;
    model: string;
}

let snapshot: StatusSnapshot | null = null;

function draw(): void {
    if (!process.stdout.isTTY || !snapshot) return;

    const percentage = snapshot.tokenLimit > 0
        ? Math.min(100, Math.round((snapshot.tokensUsed / snapshot.tokenLimit) * 100))
        : 0;
    const frame = frames[frameIndex % frames.length];
    frameIndex += 1;

    const color = percentage >= 90
        ? chalk.red
        : percentage >= 75
            ? chalk.yellow
            : chalk.green;

    const line = `${chalk.dim(frame)} ${snapshot.phase} ${chalk.dim('[' + snapshot.model + ']')} | ` +
        `${color(`${snapshot.tokensUsed}/${snapshot.tokenLimit} tokens`)} ${chalk.dim(`(${percentage}%)`)}`;

    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(line);
}

export function updateLiveStatus(next: StatusSnapshot): void {
    snapshot = next;
    draw();

    if (timer) return;
    timer = setInterval(draw, 120);
    timer.unref();
}

export function clearLiveStatus(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    snapshot = null;

    if (!process.stdout.isTTY) return;
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
}
