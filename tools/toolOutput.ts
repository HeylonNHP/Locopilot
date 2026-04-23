export interface ToolOutputSink {
    writeLine(message: string): void;
    writeInline(message: string): void;
    clearInline(): void;
}

export const terminalToolOutputSink: ToolOutputSink = {
    writeLine(message: string): void {
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