import type { ChatMessage } from './llm';

export interface ConversationDumpInput {
  sessionId?: number | null | undefined;
  sessionName?: string | undefined;
  currentModel: string;
  baseUrl: string;
  runtimeNumCtx: number;
  savedNumCtx?: number | undefined;
  systemPrompt: string;
  messages: ChatMessage[];
  config?: unknown;
  webCompactionDebug?: string[];
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function longestBacktickRun(text: string): number {
  let maxRun = 0;
  let currentRun = 0;

  for (const char of text) {
    if (char === '`') {
      currentRun += 1;
      if (currentRun > maxRun) {
        maxRun = currentRun;
      }
    } else {
      currentRun = 0;
    }
  }

  return maxRun;
}

function fencedBlock(text: string, language = 'text'): string {
  const normalized = normalizeLineEndings(text);
  const fenceLength = Math.max(3, longestBacktickRun(normalized) + 1);
  const fence = '`'.repeat(fenceLength);
  return `${fence}${language}\n${normalized}\n${fence}`;
}

function safeJsonStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? 'null';
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return JSON.stringify(
      {
        error: 'Unable to serialize value',
        reason,
      },
      null,
      2
    );
  }
}

function sanitizeFileSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .replaceAll(/-{2,}/g, '-')
    .slice(0, 48);
}

function formatTimestamp(date = new Date()): string {
  return date.toISOString().replaceAll(/[.:]/g, '-');
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function summarizeRoles(messages: ChatMessage[]): string {
  const counts = new Map<ChatMessage['role'], number>([
    ['system', 0],
    ['user', 0],
    ['assistant', 0],
    ['tool', 0],
  ]);

  for (const message of messages) {
    counts.set(message.role, (counts.get(message.role) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([role, count]) => `${role}=${count}`)
    .join(', ');
}

function countToolCalls(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + (message.tool_calls?.length ?? 0), 0);
}

function countImages(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + (message.images?.length ?? 0), 0);
}

export function buildDumpFileName(input: ConversationDumpInput): string {
  const timestamp = formatTimestamp();
  const sessionSlug = input.sessionName ? sanitizeFileSegment(input.sessionName) : '';
  const sessionIdPart =
    typeof input.sessionId === 'number' && Number.isFinite(input.sessionId) && input.sessionId > 0
      ? String(Math.trunc(input.sessionId))
      : 'unsaved';
  const sessionPart = sessionSlug
    ? `session-${sessionIdPart}-${sessionSlug}`
    : `session-${sessionIdPart}`;
  return `locopilot-history-${sessionPart}-${timestamp}.md`;
}

function renderTextSection(title: string, text: string, language = 'text'): string {
  const trimmed = text.trim();
  const body = trimmed.length > 0 ? fencedBlock(text, language) : '_No content recorded._';

  return [`### ${title}`, '', body].join('\n');
}

function renderDebugSection(title: string, lines: string[]): string {
  return renderTextSection(title, lines.join('\n'));
}

function renderToolCallSection(
  toolCall: NonNullable<ChatMessage['tool_calls']>[number],
  callIndex: number
): string {
  return [
    `#### Tool Call ${callIndex + 1}`,
    '',
    `- Function: \`${toolCall.function.name}\``,
    '',
    fencedBlock(safeJsonStringify(toolCall), 'json'),
  ].join('\n');
}

function renderImageSection(base64: string, imageIndex: number): string {
  return [
    `#### Image ${imageIndex + 1}`,
    '',
    `- Base64 length: ${base64.length} characters`,
    '',
    fencedBlock(base64, 'text'),
  ].join('\n');
}

function renderMessageSection(message: ChatMessage, index: number): string {
  const sections: string[] = [];
  const extras: string[] = [];

  if (message.tool_calls?.length) {
    extras.push(pluralize(message.tool_calls.length, 'tool call'));
  }

  if (message.images?.length) {
    extras.push(pluralize(message.images.length, 'image'));
  }

  if (message.thinking?.trim()) {
    extras.push('thinking');
  }

  const extraSuffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
  sections.push(`### Message ${index + 1} - ${message.role}${extraSuffix}`, '', renderTextSection('Content', message.content));

  if (message.thinking?.trim()) {
    sections.push('', renderTextSection('Thinking', message.thinking, 'text'));
  }

  if (message.tool_calls?.length) {
    sections.push(
      '',
      `### Tool Calls (${message.tool_calls.length})`,
      '',
      message.tool_calls
        .map((toolCall, callIndex) => renderToolCallSection(toolCall, callIndex))
        .join('\n\n')
    );
  }

  if (message.images?.length) {
    sections.push(
      '',
      `### Images (${message.images.length})`,
      '',
      message.images.map((image, imageIndex) => renderImageSection(image, imageIndex)).join('\n\n')
    );
  }

  return sections.join('\n');
}

function renderTranscript(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    return '_No messages recorded in the current conversation._';
  }

  return messages.map((message, index) => renderMessageSection(message, index)).join('\n\n---\n\n');
}

export function buildConversationDumpMarkdown(input: ConversationDumpInput): string {
  const trimmedSessionName = input.sessionName?.trim();
  const systemPrompt =
    input.systemPrompt.trim().length > 0
      ? fencedBlock(input.systemPrompt, 'markdown')
      : '_No system prompt content was recorded._';

  const summaryLines = [
    `- Generated at: ${new Date().toISOString()}`,
    `- Session ID: ${typeof input.sessionId === 'number' && Number.isFinite(input.sessionId) && input.sessionId > 0 ? Math.trunc(input.sessionId) : '(unsaved)'}`,
    `- Session Name: ${trimmedSessionName && trimmedSessionName.length > 0 ? trimmedSessionName : '(unnamed)'}`,
    `- Current Model: ${input.currentModel}`,
    `- Base URL: ${input.baseUrl}`,
    `- Runtime num_ctx: ${input.runtimeNumCtx}`,
    `- Saved num_ctx: ${input.savedNumCtx ?? '(unset)'}`,
    `- Message Count: ${input.messages.length}`,
    `- Role Counts: ${summarizeRoles(input.messages)}`,
    `- Tool Calls: ${countToolCalls(input.messages)}`,
    `- Images: ${countImages(input.messages)}`,
  ];

  const sections = [
    '# Locopilot Conversation Dump',
    '',
    '## Summary',
    '',
    ...summaryLines,
    '',
    '## System Prompt',
    '',
    systemPrompt,
  ];

  if (input.config !== undefined) {
    sections.push(
      '',
      '## Runtime Config Snapshot',
      '',
      fencedBlock(safeJsonStringify(input.config), 'json')
    );
  }

  if (input.webCompactionDebug && input.webCompactionDebug.length > 0) {
    sections.push(
      '',
      '## Web Content Compaction Debug',
      '',
      renderDebugSection('Web Content Compaction Debug', input.webCompactionDebug)
    );
  }

  sections.push(
    '',
    '## Transcript',
    '',
    'The transcript below preserves the stored message order. Message content, thinking, tool calls, and tool responses are emitted verbatim in fenced blocks.',
    '',
    renderTranscript(input.messages)
  );

  return sections.join('\n');
}

