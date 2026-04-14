/**
 * Interrupt and TTY signal handling for Locopilot.
 *
 * This module manages the alternate interrupt key listener, raw mode state,
 * and the current interrupt flag used by the tool-call loop.
 */

import chalk from 'chalk';
import readline from 'readline';

// Set to true by requestInterrupt(); cleared by clearInterrupt().
let interruptRequested = false;

// Resolvers registered by tools (e.g. run_command) so they can be
// cancelled from outside without waiting for the natural finish.
let activeInterruptHandler: ((result: string) => void) | null = null;

let keyInterruptListener: ((s: string, k: readline.Key) => void) | null = null;
let prevRawMode: boolean | null = null;
const DEFAULT_INTERRUPT_KEY_SPEC = 'Ctrl+X';
let currentInterruptKeySpec = DEFAULT_INTERRUPT_KEY_SPEC;

export function requestInterrupt(): void {
    interruptRequested = true;
    if (activeInterruptHandler) {
        activeInterruptHandler('[Interrupted by user.]');
        activeInterruptHandler = null;
    }
}

export function registerInterruptHandler(handler: (result: string) => void): void {
    activeInterruptHandler = handler;
}

export function unregisterInterruptHandler(): void {
    activeInterruptHandler = null;
}

export function getInterruptHint(): string {
    return `Press ${chalk.bold(currentInterruptKeySpec)} to interrupt the AI loop.`;
}

export function installKeyInterruptListener(keySpec = 'Ctrl+X'): void {
    if (!process.stdin.isTTY) return;

    currentInterruptKeySpec = keySpec;
    const spec = keySpec.toLowerCase();
    const isCtrl = spec.startsWith('ctrl+');
    const keyName = isCtrl ? spec.slice(5) : spec;

    readline.emitKeypressEvents(process.stdin);

    // Always capture the current raw mode before we change anything so
    // removeKeyInterruptListener can reliably restore it.
    if (prevRawMode === null) {
        prevRawMode = process.stdin.isRaw ?? false;
    }

    if (keyInterruptListener) {
        process.stdin.off('keypress', keyInterruptListener);
        keyInterruptListener = null;
    }

    if (!process.stdin.isRaw) {
        process.stdin.setRawMode(true);
    }

    process.stdin.resume();

    keyInterruptListener = (str: string, key: readline.Key) => {
        if (!key) return;

        if (key.ctrl && key.name === 'c') {
            process.kill(process.pid, 'SIGINT');
            return;
        }

        const match = isCtrl
            ? (key.ctrl && key.name === keyName)
            : (key.name === keyName || str === keySpec);

        if (match) {
            console.log(chalk.yellow(`\n[${keySpec} pressed — interrupting AI loop...]\n`));
            requestInterrupt();
        }
    };

    process.stdin.on('keypress', keyInterruptListener);
}

export function removeKeyInterruptListener(): void {
    currentInterruptKeySpec = DEFAULT_INTERRUPT_KEY_SPEC;

    if (!process.stdin.isTTY) return;

    // Remove the listener if it's still registered.
    if (keyInterruptListener) {
        process.stdin.off('keypress', keyInterruptListener);
        keyInterruptListener = null;
    }

    // Always restore raw mode and pause stdin, even if the listener was
    // already gone.  Skipping this step is what causes the terminal freeze:
    // stdin stays in raw mode with no handler, so keypresses disappear and
    // Ctrl+C no longer generates SIGINT on Windows.
    const modeToRestore = prevRawMode ?? false;
    prevRawMode = null;
    try {
        process.stdin.setRawMode(modeToRestore);
    } catch {
        // stdin may already be closed or in an unexpected state — ignore.
    }
    process.stdin.pause();
}

export function clearInterrupt(): void {
    interruptRequested = false;
    activeInterruptHandler = null;
}

export function isInterruptRequested(): boolean {
    return interruptRequested;
}
