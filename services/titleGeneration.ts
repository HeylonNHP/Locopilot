/**
 * titleGeneration.ts
 *
 * LLM-based session title generation with deterministic fallback,
 * input sanitization, and post-response validation to reject junk titles.
 */

import { sendLlmChat } from './llm';
import type { ChatMessage } from './llm';

const TITLE_MAX_LEN = 80;
const TITLE_MIN_LEN = 3;

const TITLE_BLOCKLIST = new Set([
    'json', 'title', 'chat', 'conversation', 'response', 'answer', 'result',
    'output', 'text', 'summary', 'object', 'array', 'unknown', 'untitled',
    'generated', 'session', 'example', 'test', 'error', 'null', 'undefined',
]);

/** Returns whether a title is semantically useful, plus an optional rejection reason. */
export function isValidTitle(title: string): { valid: boolean; reason?: string } {
    const stripped = title.replace(/^\p{Extended_Pictographic}\s*/u, '').trim().toLowerCase();
    const plain = stripped.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

    if (plain.length < TITLE_MIN_LEN) {
        return { valid: false, reason: 'too short' };
    }

    const words = plain.split(/\s+/).filter(Boolean);
    if (words.length < 2 && plain.length < 6) {
        return { valid: false, reason: 'too few words' };
    }

    if (TITLE_BLOCKLIST.has(plain) || TITLE_BLOCKLIST.has(stripped)) {
        return { valid: false, reason: 'blocklisted generic word' };
    }

    return { valid: true };
}

/** Sanitizes message content before it is fed to the title LLM. */
export function sanitizeContentForTitle(content: string): string {
    return content
        .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
        .replace(/\x1B\[[0-9;]*m/g, '')
        .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image]')
        .replace(/```[\s\S]*?```/g, '[code]')
        .replace(/\{[^{}]*"name"\s*:\s*"[^"]+"[^{}]*\}/g, '[tool]')
        .replace(/https?:\/\/[^\s]+/g, '[link]')
        .replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '').replace(/_/g, '').replace(/~/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function looksLikeApology(title: string): boolean {
    return /\b(?:i['’]?m sorry|sorry|apolog(?:y|ize)|can(?:'t|not)|cannot|unable|won't|will not|no permission|cannot create|cannot write|no access|not allowed)\b/i.test(title);
}

function extractTitleFromResponse(raw: string): string {
    const line = raw.split('\n').find((l) => l.trim().length > 0) ?? '';
    let t = line.trim();

    const jsonMatch = t.match(/^\s*\{\s*"title"\s*:\s*"(.+?)"\s*\}\s*$/);
    if (jsonMatch) t = jsonMatch[1]!;

    t = t
        .replace(/^['"''']+|['"''']+$/g, '')
        .replace(/^(?:title|session|conversation|chat)\s*[:\-–—]\s*/i, '')
        .replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '').replace(/_/g, '').replace(/~/g, '')
        .replace(/^\[emoji\]\s*/i, '').replace(/^\[System:[^\]]*\]\s*/i, '')
        .replace(/[.,;:!?]+$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return t.slice(0, TITLE_MAX_LEN).trim();
}

export async function generateSessionTitle(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    numCtx: number,
    onProgress?: (message: string) => void,
): Promise<string> {
    if (messages.length <= 1) {
        throw new Error('Not enough conversation history to generate a session title.');
    }

    const isSmallModel = /(?:^|[-_\s])(?:7b|8b|3b|4b|small|mini)(?:[-_\s]|$)/i.test(model);
    const cappedNumCtx = Math.min(numCtx, isSmallModel ? 4096 : 8192);

    const trimmedHistory = messages.length > 64
        ? [messages[0]!, ...messages.slice(-63)]
        : messages;

    let conversationText = trimmedHistory
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => {
            const sanitized = sanitizeContentForTitle(m.content ?? '');
            const truncated = sanitized.length > 300 ? `${sanitized.slice(0, 300)}...` : sanitized;
            return `[${m.role.toUpperCase()}] ${truncated}`;
        })
        .join('\n\n');

    if (conversationText.length > 4000) {
        conversationText = `${conversationText.slice(0, 4000)}\n[...truncated]`;
    }

    const firstUserContent = messages.find((m) => m.role === 'user')?.content?.trim() ?? '';

    const strategies: Array<{ system: string; user: string; format?: string | Record<string, unknown> }> = [
        {
            system:
                'You are a concise session title generator. Given a conversation between a user and an AI assistant, ' +
                'generate a short descriptive title (2-8 words) and pick a single relevant emoji that captures the topic.\n' +
                'Respond with ONLY a JSON object in this exact format: {"title": "<emoji> <title>"}\n' +
                'Rules:\n' +
                '- 2 to 8 words, under 80 characters (emoji does not count toward the word limit)\n' +
                '- Pick one relevant emoji that represents the main topic\n' +
                '- Capture the main topic or task\n' +
                '- Do NOT use generic words like "json", "title", "chat", "response", "result", "output", "text", or "conversation"\n' +
                '- Do NOT include refusals, apologies, or limitation language in the title',
            user: `Generate a short session title for this conversation:\n\n${conversationText}\n\nRespond with JSON only.`,
            format: 'json',
        },
        {
            system:
                'You are a concise session title generator. Given a conversation between a user and an AI assistant, ' +
                'generate a short descriptive title (2-8 words) and pick a single relevant emoji that captures the topic.\n\n' +
                'Good examples:\n' +
                '[USER] How do I fix a 503 error on Nginx?\n' +
                '[ASSISTANT] Check upstream server configs and restart.\n' +
                '→ 🌐 Nginx 503 Error Troubleshooting\n\n' +
                '[USER] Explain how Python async/await works\n' +
                '[ASSISTANT] Async/await is syntactic sugar over coroutines...\n' +
                '→ 🐍 Python Async/Await Explained\n\n' +
                'Bad examples (NEVER do this):\n' +
                '→ json\n' +
                '→ title\n' +
                '→ response\n' +
                '→ Chat\n\n' +
                'Rules:\n' +
                '- Return ONLY the emoji + title — no quotes, no prefixes, no explanation\n' +
                '- 2 to 8 words, under 80 characters (emoji does not count toward the word limit)\n' +
                '- Pick one relevant emoji that represents the main topic\n' +
                '- Capture the main topic or task\n' +
                '- Do NOT use generic words like "json", "title", "chat", "response", "result", "output", "text", or "conversation"\n' +
                '- Do NOT include refusals, apologies, or limitation language in the title',
            user: `Generate a short session title for this conversation:\n\n${conversationText}\n\nTitle:`,
        },
        {
            system:
                'You generate short titles for chat conversations. Pick one relevant emoji and output exactly one line: <emoji> <title>. ' +
                'No quotes, no formatting, no prefixes like "Title:". Just the emoji and title. ' +
                'Do NOT use generic words like "json", "title", "chat", "response", "result", "output", "text", or "conversation".',
            user: `Conversation:\n${conversationText.slice(0, 2000)}\n\nShort title (2-8 words):`,
        },
        {
            system:
                'Generate a brief title for this chat. Pick one relevant emoji and output only the emoji + title text. ' +
                'Do NOT use generic words like "json", "title", "chat", "response", "result", "output", "text", or "conversation".',
            user: `${conversationText.slice(0, 1500)}\n\nTitle:`,
        },
    ];

    let lastError: string | null = null;

    for (let attempt = 0; attempt < strategies.length; attempt += 1) {
        const strategy = strategies[attempt]!;

        onProgress?.(
            attempt > 0
                ? `Retrying title generation (attempt ${attempt + 1}/${strategies.length})...`
                : 'Generating session title...',
        );

        try {
            const response = await sendLlmChat(baseUrl, {
                model,
                messages: [
                    { role: 'system', content: strategy.system },
                    { role: 'user', content: strategy.user },
                ],
                tools: [],
                numCtx: cappedNumCtx,
                ...(strategy.format ? { format: strategy.format } : {}),
                options: {
                    temperature: 0.2,
                    num_predict: 128,
                },
            });

            const rawContent = response.message?.content?.trim() ?? '';
            if (!rawContent) {
                lastError = 'empty response';
                continue;
            }

            let title = '';
            if (rawContent.startsWith('{') || rawContent.startsWith('[')) {
                try {
                    const parsed = JSON.parse(rawContent);
                    if (parsed && typeof parsed.title === 'string') {
                        title = extractTitleFromResponse(parsed.title);
                    }
                } catch {
                    /* ignore */
                }
            }
            if (!title) {
                title = extractTitleFromResponse(rawContent);
            }
            if (!title) {
                lastError = 'extracted title was empty';
                continue;
            }
            if (looksLikeApology(title)) {
                lastError = 'apology or refusal detected';
                continue;
            }

            const validation = isValidTitle(title);
            if (!validation.valid) {
                lastError = `title rejected: ${validation.reason} ("${title}")`;
                continue;
            }

            return /^\p{Extended_Pictographic}/u.test(title) ? title : `💬 ${title}`;
        } catch (err) {
            lastError = err instanceof Error ? err.message : 'Unknown error';
            continue;
        }
    }

    if (firstUserContent.length > 0) {
        const fallback = firstUserContent.replace(/\s+/g, ' ').trim().slice(0, 60).trim();
        if (fallback.length > 0) {
            onProgress?.('Using first message as fallback title.');
            return `💬 ${fallback}`;
        }
    }

    throw new Error(
        lastError
            ? `Title generation failed after ${strategies.length} attempts: ${lastError}`
            : 'The model returned an empty title after multiple attempts.',
    );
}
