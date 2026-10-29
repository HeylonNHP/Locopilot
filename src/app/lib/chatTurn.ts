import { EventSourceParserStream } from 'eventsource-parser/stream';

import type { SseEventData } from '@/app/lib/sseRouting';

/**
 * The transport half of a chat turn.
 *
 * Sending a message and retrying a failed one were two copies of the same
 * ~120 lines: post the body, turn a failed response into a readable error,
 * read the SSE stream, hand each frame to the caller. This module is that
 * half, once.
 */

type SseEventPayload = Record<string, unknown>;

/**
 * Coerce an unknown parsed JSON value into the shared SSE payload shape.
 * Non-object values are wrapped as a chunk so malformed frames still have a
 * defined shape.
 */
export function toSseEventData(value: unknown): SseEventData {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as SseEventData;
  }
  return { content: String(value) } as SseEventData;
}

/**
 * The most useful message from a failed chat response.
 *
 * The body may be plain JSON, an SSE error frame, or neither. The fields are
 * tried in the order a reader cares about: the message, then the other
 * common error fields, then any string value at all, and finally the raw
 * body (truncated).
 */
export function errorMessageFromResponse(status: number, bodyText: string): string {
  let parsedError: Record<string, unknown> | null = null;
  try {
    parsedError = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    // Not plain JSON — try the SSE format.
  }

  if (!parsedError) {
    const dataLines: string[] = [];
    for (const line of bodyText.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length > 0) {
      try {
        parsedError = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
      } catch {
        // Invalid JSON in an SSE data line — fall through to the raw body.
      }
    }
  }

  if (parsedError) {
    const message =
      parsedError.message ??
      parsedError.error ??
      parsedError.status ??
      parsedError.detail ??
      parsedError.title;
    if (typeof message === 'string' && message.length > 0) {
      return `HTTP ${status}: ${message}`;
    }
    const values = Object.values(parsedError).filter((value): value is string => {
      return typeof value === 'string';
    });
    if (values.length > 0) {
      return `HTTP ${status}: ${values[0]}`;
    }
  }

  const truncated = bodyText.length > 200 ? `${bodyText.slice(0, 200)}...` : bodyText;
  return `HTTP ${status}: ${truncated}`;
}

/**
 * Post a chat turn and hand every SSE frame to `onEvent`.
 *
 * Rejects with a readable message when the request itself fails; the frames
 * themselves are the caller's business.
 */
export async function streamChatTurn(options: {
  body: string;
  signal: AbortSignal;
  onEvent: (event: string, data: SseEventData) => void;
}): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: options.body,
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(errorMessageFromResponse(response.status, errorText));
  }

  if (!response.body) throw new Error('No response body stream');

  const eventStream = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());

  const reader = eventStream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    try {
      const parsed = toSseEventData(JSON.parse(value.data) as SseEventPayload);
      options.onEvent(value.event || 'message', parsed);
    } catch {
      options.onEvent(value.event || 'message', { content: value.data });
    }
  }
}
