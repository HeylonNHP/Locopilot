import { sendOllamaChat, type ChatMessage } from './ollamaApi.js';

export interface UncertaintyDetectionResult {
    nudge: boolean;
    confidence: number;
    reasons: string[];
}

const FALLBACK_RESULT: UncertaintyDetectionResult = {
    nudge: false,
    confidence: 0,
    reasons: [],
};

function normalizeConfidence(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

function parseResult(raw: string): UncertaintyDetectionResult {
    const trimmed = raw.trim();
    const jsonStart = trimmed.indexOf('{');
    const jsonEnd = trimmed.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd <= jsonStart) return FALLBACK_RESULT;

    try {
        const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as {
            nudge?: unknown;
            confidence?: unknown;
            reasons?: unknown;
        };

        const nudge = parsed.nudge === true;
        const confidence = normalizeConfidence(parsed.confidence);
        const reasons = Array.isArray(parsed.reasons)
            ? parsed.reasons
                .map((reason) => String(reason).trim())
                .filter((reason) => reason.length > 0)
                .slice(0, 3)
            : [];

        return { nudge, confidence, reasons };
    } catch {
        return FALLBACK_RESULT;
    }
}

export async function detectUncertainty(
    baseUrl: string,
    model: string,
    lastAssistantResponse: string,
    numCtx: number,
): Promise<UncertaintyDetectionResult> {
    const text = lastAssistantResponse.trim();
    if (!text) return FALLBACK_RESULT;

    const messages: ChatMessage[] = [
        {
            role: 'system',
            content:
                'You detect uncertainty in an assistant reply. Return JSON only with this exact shape: ' +
                '{"nudge": boolean, "confidence": number, "reasons": string[]}. ' +
                'Set nudge=true when the reply contains hedging, guessing, uncertainty, or lack of verification. ' +
                'confidence must be between 0 and 1. Keep reasons short.',
        },
        {
            role: 'user',
            content:
                'Analyze this assistant reply only:\n\n' +
                text +
                '\n\nReturn JSON only.',
        },
    ];

    try {
        const response = await sendOllamaChat(baseUrl, {
            model,
            messages,
            tools: [],
            numCtx,
        });

        const modelOutput = response.message.content ?? '';
        return parseResult(modelOutput);
    } catch {
        return FALLBACK_RESULT;
    }
}
