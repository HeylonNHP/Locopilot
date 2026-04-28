import chalk from 'chalk';
import { getTerminalWidth } from '../terminalWidth.js';

const LOGO_LINES = [
    `    __                        _ __      __ `,
    `   / /   ____  _________  ___(_) /___  / /_`,
    `  / /   / __ \\/ ___/ __ \\/ __ \\ / / __ \\/ __/`,
    ` / /___/ /_/ / /__/ /_/ / /_/ / / /_/ / /_ `,
    `/_____/\\____/\\___/\\____/ .___/_/_/\\____/\\__/ `,
    `                      /_/                    `
];

export function printSplashScreen(): void {
    const columns = getTerminalWidth();
    
    console.log(); // Top padding
    
    // Print each line of the logo centered
    for (const line of LOGO_LINES) {
        const paddingLength = Math.max(0, Math.floor((columns - line.length) / 2));
        const padding = ' '.repeat(paddingLength);
        // Using a gradient-like bold color or just cyan. bold cyan is nice.
        console.log(chalk.cyan.bold(padding + line));
    }

    // Print subtitle centered below
    const subtitle = "Local, Private, Safe AI Assistant";
    const subtitlePaddingLength = Math.max(0, Math.floor((columns - subtitle.length) / 2));
    const subtitlePadding = ' '.repeat(subtitlePaddingLength);
    console.log(chalk.dim(subtitlePadding + subtitle));
    
    console.log(); // Bottom padding
}
