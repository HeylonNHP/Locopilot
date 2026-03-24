import * as readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You > '
});

const commands = ['/new', '/model', '/settings', '/compact', '/sessions', '/delete', '/nudge', '/exit', '/help'];
let lastMenuLines = 0;

function clearMenu() {
    if (lastMenuLines > 0) {
        // Save cursor pos (not strictly needed if we just move up and clear)
        for (let i = 0; i < lastMenuLines; i++) {
            process.stdout.write('\x1B[1E'); // move down 1 line
            process.stdout.write('\x1B[2K'); // clear line
        }
        process.stdout.write(`\x1B[${lastMenuLines}F`); // move UP N lines
        lastMenuLines = 0;
    }
}

function drawMenu() {
    const line = rl.line;
    if (line.startsWith('/')) {
        const matches = commands.filter(c => c.startsWith(line));
        if (matches.length > 0) {
            // Save cursor position
            process.stdout.write('\x1B[s');
            
            // Draw menu below
            for (const m of matches) {
                process.stdout.write('\n\x1B[2K\x1B[2m  ' + m + '\x1B[0m');
            }
            
            // Restore cursor position
            process.stdout.write('\x1B[u');
            lastMenuLines = matches.length;
        } else {
            clearMenu();
        }
    } else {
        clearMenu();
    }
}

rl.prompt();

process.stdin.on('keypress', (char, key) => {
    // Only redraw on keypress to keep it responsive
    clearMenu();
    drawMenu();
});

rl.on('line', (line) => {
    clearMenu();
    console.log("Submitted:", line);
    rl.prompt();
});
