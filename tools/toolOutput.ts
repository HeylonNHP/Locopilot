export interface ToolOutputSink {
    writeLine(message: string): void;
    writeInline(message: string): void;
    clearInline(): void;
    /**
     * Optional: called with raw LLM token chunks during a sub-agent turn so
     * callers (e.g. the web SSE route) can stream thinking/content live.
     * The default terminal sink ignores this — it only shows finalised output.
     */
    writeAgentChunk?(agentId: string, type: 'thinking' | 'content', text: string): void;
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

export const noopToolOutputSink: ToolOutputSink = {
    writeLine(): void {},
    writeInline(): void {},
    clearInline(): void {},
};
