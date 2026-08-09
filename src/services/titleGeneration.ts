/**
 * titleGeneration.ts
 *
 * LLM-based session title generation with deterministic fallback,
 * input sanitization, and post-response validation to reject junk titles.
 */

import { type ReasoningEffort } from '@/types/chatConfig';

import { type ChatMessage, type LlmRequestContext, sendLlmChat } from './llm';

const TITLE_MAX_LEN = 80;
const TITLE_MIN_LEN = 3;

const TITLE_BLOCKLIST = new Set([
  'json',
  'title',
  'chat',
  'conversation',
  'response',
  'answer',
  'result',
  'output',
  'text',
  'summary',
  'object',
  'array',
  'unknown',
  'untitled',
  'generated',
  'session',
  'example',
  'test',
  'error',
  'null',
  'undefined',
]);

/** Returns whether a title is semantically useful, plus an optional rejection reason. */
export function isValidTitle(title: string): { valid: boolean; reason?: string } {
  const stripped = title
    .replace(/^(?:\p{Emoji}\p{Emoji_Modifier}?)+/u, '')
    .trim()
    .toLowerCase();
  const plain = stripped.replaceAll(/[^\p{L}\p{N}]+/gu, ' ').trim();

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
  return (
    content
      // CDATA sections: Ollama/DeepSeek models wrap <thinking> blocks in
      // <![CDATA[...]]>; strip the full CDATA wrapper first so the inner
      // <thinking> pattern below doesn't leave orphan CDATA markers.
      .replaceAll(/<!\[CDATA\[[\S\s]*?]]>/g, '')
      .replaceAll(/<thinking>[\S\s]*?<\/thinking>/g, '')
      // <think>...</think> tags used by DeepSeek R1 and QwQ models.
      .replaceAll(/<think>[\S\s]*?<\/think>/g, '')
      .replaceAll(new RegExp(String.raw`${String.fromCodePoint(0x001b)}\[\d;]*m`, 'g'), '')
      .replaceAll(/data:image\/[^;]+;base64,[\d+/=A-Za-z]+/g, '[image]')
      .replaceAll(/```[\S\s]*?```/g, '[code]')
      .replaceAll(/{[^{}]*"name"\s*:\s*"[^"]+"[^{}]*}/g, '[tool]')
      .replaceAll(/https?:\/\/\S+/g, '[link]')
      // Windows absolute paths (e.g. C:\Users\foo\bar.xml or \\server\share)
      .replaceAll(/(?:[A-Za-z]:\\|\\\\)[^\s"'),;<>\]`]+/g, '[path]')
      // Unix absolute paths (e.g. /home/user/file.txt)
      .replaceAll(/\/(?:[\w.-]+\/)+[\w.-]+/g, '[path]')
      .replaceAll('**', '')
      .replaceAll('*', '')
      .replaceAll('`', '')
      .replaceAll('_', '')
      .replaceAll('~', '')
      .replaceAll(/\s+/g, ' ')
      .trim()
  );
}
function looksLikeApology(title: string): boolean {
  return /\b(?:i'?m sorry|sorry|apolog(?:y|ize)|can(?:'t|not)|cannot|unable|won't|will not|no permission|cannot create|cannot write|no access|not allowed)\b/i.test(
    title
  );
}

/** Fallback emoji used when the LLM fails to include one after all retry attempts. */
const FALLBACK_EMOJI = '💬';

function extractTitleFromResponse(raw: string): string {
  const line = raw.split('\n').find((l) => l.trim().length > 0) ?? '';
  let t = line.trim();

  const jsonMatch = t.match(/^\s*{\s*"title"\s*:\s*"(.+?)"\s*}\s*$/);
  if (jsonMatch) t = jsonMatch[1]!;

  t = t
    .replaceAll(/^["']+|["']+$/g, '')
    .replace(/^(?:title|session|conversation|chat)\s*[:–—-]\s*/i, '')
    .replaceAll('**', '')
    .replaceAll('*', '')
    .replaceAll('`', '')
    .replaceAll('_', '')
    .replaceAll('~', '')
    .replace(/^\[emoji]\s*/i, '')
    .replace(/^\[system:[^\]]*]\s*/i, '')
    .replace(/[!,.:;?]+$/, '')
    .replaceAll(/\s{2,}/g, ' ')
    .trim();

  return t.slice(0, TITLE_MAX_LEN).trim();
}

export async function generateSessionTitle(
  ctx: LlmRequestContext,
  model: string,
  messages: ChatMessage[],
  numCtx: number,
  onProgress?: (message: string) => void,
  think?: boolean,
  reasoningEffort?: ReasoningEffort
): Promise<string> {
  if (messages.length <= 1) {
    throw new Error('Not enough conversation history to generate a session title.');
  }

  const isSmallModel = /(?:^|[\s_-])(?:7b|8b|3b|4b|small|mini)(?:[\s_-]|$)/i.test(model);
  const cappedNumCtx = Math.min(numCtx, isSmallModel ? 4096 : 8192);

  const trimmedHistory = messages.length > 64 ? [messages[0]!, ...messages.slice(-63)] : messages;

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

  const SHARED_RULES =
    '- The FIRST character MUST be a single relevant emoji — this is mandatory, never skip it\n' +
    '- Summarise what the USER WANTED TO DO or the topic discussed — not the literal text they typed\n' +
    '- 3 to 6 words after the emoji that a human could glance at to recognise the conversation\n' +
    '- Under 55 characters total (emoji does not count)\n' +
    '- Do NOT include file paths, URLs, code snippets, variable names, or quoted strings\n' +
    '- Do NOT use generic filler words like "chat", "conversation", "response", "result", or "output"\n' +
    '- Do NOT include refusals, apologies, or limitation language';

  const SHARED_EXAMPLES =
    'Examples — note every title starts with an emoji:\n' +
    '  [USER] Can you review C:\\Users\\foo\\report.xml?  →  📄 XML Report Review\n' +
    '  [USER] Give me a fun fact about https://en.wikipedia.org/wiki/Moon  →  🌕 Moon Fun Facts\n' +
    '  [USER] Perform investigation using subagents with web searches  →  🔍 Web Investigation with Subagents\n' +
    '  [USER] How do I fix a 503 error on Nginx?  →  🌐 Nginx 503 Error Fix\n' +
    '  [USER] Help me write a Python script to rename files  →  🐍 Python File Rename Script\n\n' +
    'Bad titles (NEVER produce these):\n' +
    '  ❌ XML Report Review  (missing leading emoji)\n' +
    '  ❌ C:\\Users\\foo\\report.xml  (raw file path)\n' +
    '  ❌ Give me a fun fact about https://  (raw user message)\n' +
    '  ❌ Perform investigation using subagents with web searches to s  (truncated input)';

  const strategies: Array<{
    system: string;
    user: string;
    format?: string | Record<string, unknown>;
  }> = [
    {
      system:
        `You are a concise session title generator. Given a conversation between a user and an AI assistant, ` +
        `generate a short human-readable title. The title MUST start with a single relevant emoji.\n` +
        `Respond with ONLY a JSON object in this exact format: {"title": "<emoji> <title>"}\n\n${
          SHARED_EXAMPLES
        }\n\nRules:\n${SHARED_RULES}`,
      user: `Generate a short session title for this conversation:\n\n${conversationText}\n\nRespond with JSON only.`,
      format: 'json',
    },
    {
      system:
        `You are a concise session title generator. Given a conversation between a user and an AI assistant, ` +
        `generate a short human-readable title. The title MUST start with a single relevant emoji.\n\n${
          SHARED_EXAMPLES
        }\n\nRules:\n${SHARED_RULES}\n` +
        `- Return ONLY the emoji + title — no quotes, no prefixes, no explanation`,
      user: `Generate a short session title for this conversation:\n\n${conversationText}\n\nTitle (emoji first):`,
    },
    {
      system:
        'Give this chat conversation a short title. ' +
        'IMPORTANT: the title MUST begin with a relevant emoji — never omit it. ' +
        'Output exactly one line in this format: <emoji> <title>. ' +
        'No quotes, no formatting, no prefixes. ' +
        "Summarise the user's goal in 3-6 words — never use raw file paths, URLs, or literal user input.",
      user: `Conversation:\n${conversationText.slice(0, 2000)}\n\nShort title (emoji then 3-6 words):`,
    },
    {
      system:
        'Give this chat a short title. ' +
        'The title MUST start with an emoji. Output only: <emoji> <title>. ' +
        'Describe the topic or goal in plain words. Never copy file paths, URLs, or raw input into the title.',
      user: `${conversationText.slice(0, 1500)}\n\nTitle (start with emoji):`,
    },
  ];

  let lastError: string | null = null;

  for (let attempt = 0; attempt < strategies.length; attempt += 1) {
    const strategy = strategies[attempt]!;

    onProgress?.(
      attempt > 0
        ? `Retrying title generation (attempt ${attempt + 1}/${strategies.length})...`
        : 'Generating session title...'
    );

    try {
      const response = await sendLlmChat(ctx, {
        model,
        messages: [
          { role: 'system', content: strategy.system },
          { role: 'user', content: strategy.user },
        ],
        tools: [],
        numCtx: cappedNumCtx,
        ...(think === undefined ? {} : { think }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(strategy.format ? { format: strategy.format } : {}),
        options: {
          temperature: 0.2,
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

      if (!/^(?:\p{Emoji}\p{Emoji_Modifier}?)+/u.test(title)) {
        // LLM ignored the emoji requirement — retry with the next strategy
        // unless this is the last one, in which case prepend the fallback.
        if (attempt < strategies.length - 1) {
          lastError = 'title missing required leading emoji';
          continue;
        }
        return `${FALLBACK_EMOJI} ${title}`;
      }
      return title;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Unknown error';
      continue;
    }
  }

  if (firstUserContent.length > 0) {
    // Sanitize to strip file paths, URLs, code, etc. then derive a
    // human-readable fallback rather than truncating raw input mid-word.
    let fallback = sanitizeContentForTitle(firstUserContent);
    // Strip common prompt filler at the start ("please", "can you", etc.)
    fallback = fallback
      .replace(
        /^(?:please\b[\s,]*|can\s+you\b[\s,]*|could\s+you\b[\s,]*|help\s+me\b[\s,]*|i\s+(?:need|want)\s+(?:to\s+)?|give\s+me\b[\s,]*)/i,
        ''
      )
      .trim();
    // Take only the first sentence/clause to avoid overly long fallbacks
    const clause = fallback.match(/^[^\n!,.;?]+/)?.[0]?.trim() ?? fallback;
    // Trim to 45 chars ending on a whole word
    let short =
      clause.length > 45
        ? clause
            .slice(0, 45)
            .replace(/\s\S+$/, '')
            .trim()
        : clause;
    // Capitalise first letter
    short = short.charAt(0).toUpperCase() + short.slice(1);
    // Reject if only placeholder tokens remain after sanitization
    const isOnlyPlaceholders = /^(?:\[(?:path|link|code|tool|image)]\s*)+$/i.test(short);
    if (!isOnlyPlaceholders && short.length >= TITLE_MIN_LEN) {
      onProgress?.('Using first message as fallback title.');
      return `${FALLBACK_EMOJI} ${short}`;
    }
  }

  throw new Error(
    lastError
      ? `Title generation failed after ${strategies.length} attempts: ${lastError}`
      : 'The model returned an empty title after multiple attempts.'
  );
}
