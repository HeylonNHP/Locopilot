const DEFAULT_TERMINAL_WIDTH = 80;

export function getTerminalWidth(
    stream: Pick<NodeJS.WriteStream, 'isTTY' | 'columns'> = process.stdout,
    fallbackWidth: number = DEFAULT_TERMINAL_WIDTH,
): number {
    const width = stream.isTTY ? stream.columns : undefined;
    return typeof width === 'number' && width > 0 ? width : fallbackWidth;
}
