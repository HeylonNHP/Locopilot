/**
 * mermaidRecovery.ts
 *
 * Mermaid pre-display validation and recovery policy.
 *
 * Locopilot's `render_mermaid` tool is *advisory* — the model may skip it, and
 * nothing else checks a ```mermaid fence before the client tries to draw it.
 * When a fence fails to render the user sees an "Unable to render diagram"
 * panel instead of their diagram. This module is the shared policy that lets
 * the chat loop reject such a response and hand the syntax errors back to the
 * model as an automatic fix-up prompt, retrying until every fence is valid.
 *
 * Scope ceiling: validation is PARSE-level, never render-level. Rendering
 * needs real SVG layout (`CSSStyleSheet`, `getComputedTextLength`), which jsdom
 * does not implement, so a fence that parses but throws during `mermaid.render`
 * cannot be caught here. This module therefore catches malformed fences, which
 * is the common failure when a model hand-writes a diagram.
 *
 * The tracker, nudge builder and detection helper deliberately mirror
 * `emptyResponseRecovery.ts` so the two recovery loops behave identically —
 * but they are SEPARATE trackers, so neither streak can starve the other.
 */

import type { ChatMessage } from '@/services/llm';

import { MAX_MERMAID_RECOVERY_ATTEMPTS } from '@/constants';
import { ServerMermaidEnvironmentError, withServerMermaidEnvironment } from '@/lib/serverMermaid';
import { SYNTHETIC_NUDGE_END, SYNTHETIC_NUDGE_MARKER } from '@/services/compact';

/** A fenced ```mermaid block found in an assistant response. */
export interface MermaidFence {
  /** 0-based position of this fence among the response's mermaid fences. */
  index: number;
  /** The diagram source, exactly as the client renderer will receive it. */
  source: string;
}

/** A fence that failed to parse, with the human-readable reason. */
export interface MermaidFenceError extends MermaidFence {
  error: string;
}

/**
 * Longest diagram source echoed back to the model inside a fix-up nudge.
 * A pathological fence should not balloon the context; the model already has
 * its own response in the history, so a truncated echo is only a pointer.
 */
const MAX_ECHOED_SOURCE_CHARS = 1200;

/**
 * True when the text could contain a mermaid fence at all. Callers use this as
 * a cheap pre-check so ordinary turns never pay mermaid's (one-time, ~3s)
 * jsdom cold start.
 */
export function mayContainMermaidFence(markdown: string): boolean {
  return /```mermaid|~~~mermaid/i.test(markdown);
}

/**
 * Extract every *closed* ```mermaid fenced block from markdown.
 *
 * This intentionally mirrors the fence-walking semantics of the client
 * renderer's `extractFrozenBlocks` (`MarkdownMessage.tsx`) so the server
 * validates exactly the blocks the browser is about to draw — same opening
 * fence regex, same backtick/tilde matching with a closing fence of
 * equal-or-greater length, same trailing-newline trim, and the same
 * language detection. Unclosed fences are skipped: the client classifies
 * them as streaming tail and never renders them, so a trailing fence that is
 * merely incomplete must not be reported as a syntax error.
 */
export function extractMermaidFences(markdown: string): MermaidFence[] {
  const fences: MermaidFence[] = [];
  const fence = /^[\t ]*(`{3,}|~{3,})[^\n]*$/gm;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = fence.exec(markdown)) !== null) {
    const opener = match[1] ?? '';
    const openerChar = opener[0];
    const openerLen = opener.length;
    const openLineEnd = match.index + match[0].length + 1; // past the newline
    const language = match[0].slice(openerLen).trim().toLowerCase();

    const closeRe = new RegExp(
      `^[ \\t]*${openerChar === '`' ? '`' : '~'}{${openerLen},}[ \\t]*$`,
      'gm'
    );
    closeRe.lastIndex = openLineEnd;
    const close = closeRe.exec(markdown);
    if (!close) {
      // Unclosed fence — the client treats this as an in-flight streaming
      // tail and renders nothing, so there is nothing to validate.
      break;
    }

    const closeLineEnd = close.index + close[0].length + 1;

    if (language === 'mermaid') {
      fences.push({
        index: index++,
        source: markdown.slice(openLineEnd, close.index).replace(/\n$/, ''),
      });
    }

    // Skip past the closing fence, exactly as the client does.
    fence.lastIndex = closeLineEnd;
  }

  return fences;
}

/**
 * Parse-check every ```mermaid fence in the markdown.
 *
 * Returns one entry per INVALID fence (empty array means all good). Both the
 * happy and unhappy paths use the same Mermaid v11 idiom already proven in
 * `renderMermaidTool`: `parse(..., { suppressErrors: true })` returns `false`
 * instead of throwing, and an unsuppressed re-parse then captures the
 * human-readable message for the model.
 *
 * A `ServerMermaidEnvironmentError` is an infrastructure failure (jsdom /
 * mermaid failed to load), not a diagram error, so it is swallowed and
 * reported as "no problems" — a broken validation environment must never
 * block the user from seeing their response.
 */
export async function validateMermaidFences(markdown: string): Promise<MermaidFenceError[]> {
  const fences = extractMermaidFences(markdown);
  if (fences.length === 0) return [];

  const errors: MermaidFenceError[] = [];

  try {
    await withServerMermaidEnvironment(async (mermaid) => {
      for (const fence of fences) {
        const parseResult = await mermaid.parse(fence.source, { suppressErrors: true });
        if (parseResult === false) {
          let detail = 'Mermaid syntax error: the diagram source could not be parsed.';
          try {
            await mermaid.parse(fence.source);
          } catch (parseErr) {
            detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
          }
          errors.push({ ...fence, error: detail });
        }
      }
    });
  } catch (err) {
    if (err instanceof ServerMermaidEnvironmentError) {
      return [];
    }
    throw err;
  }

  return errors;
}

/** Trim an echoed diagram to a bounded size for the nudge. */
function boundSource(source: string): string {
  if (source.length <= MAX_ECHOED_SOURCE_CHARS) return source;
  return `${source.slice(0, MAX_ECHOED_SOURCE_CHARS)}\n… (truncated)`;
}

/**
 * Build the synthetic user-role nudge injected after a response whose mermaid
 * fences failed to parse. Returns a fresh object each call — never share one
 * instance across messages, since message arrays are mutated by their owning
 * loops.
 *
 * The `SYNTHETIC_NUDGE_MARKER` prefix is mandatory: `isSyntheticNudge`
 * (`src/services/compact/split.ts`) relies on it so compaction's
 * latest-user-message anchor never latches onto this rather than the real
 * user prompt.
 */
export function buildMermaidRecoveryNudge(errors: MermaidFenceError[]): ChatMessage {
  const lines: string[] = [
    `${SYNTHETIC_NUDGE_MARKER}Your response contains ${
      errors.length === 1 ? 'a Mermaid diagram' : `${errors.length} Mermaid diagrams`
    } that failed to parse, so ${errors.length === 1 ? 'it' : 'they'} cannot be shown to the user.`,
    '',
  ];

  errors.forEach((entry, position) => {
    lines.push(
      `Diagram ${position + 1} of ${errors.length} — parse error:`,
      entry.error.trim(),
      '',
      'Source:',
      '```',
      boundSource(entry.source),
      '```',
      ''
    );
  });

  lines.push(
    'Fix the syntax in the diagram source(s) above and re-send your COMPLETE response, ',
    'keeping everything else identical to what you produced. Output the corrected ',
    'diagram(s) inside a ```mermaid fenced code block. If you cannot fix a diagram, ',
    'remove that fence or replace it with plain text rather than emitting invalid syntax.',
    SYNTHETIC_NUDGE_END
  );

  return { role: 'user', content: lines.join('\n') };
}

/**
 * Tracks the consecutive mermaid-invalid-response streak for one chat request.
 * The owning loop asks `shouldRecover()` after each candidate final reply,
 * calls `recordAttempt()` when it injects the fix-up nudge, and calls
 * `reset()` whenever a response was accepted (no mermaid fence, or every
 * fence valid) — so the cap counts *consecutive* rejections, not total ones.
 */
export class MermaidRecoveryTracker {
  private attempts = 0;

  /** True when at least one more retry is allowed for the current streak. */
  shouldRecover(): boolean {
    return this.attempts < MAX_MERMAID_RECOVERY_ATTEMPTS;
  }

  /** Record that a fix-up nudge is being injected for this streak. */
  recordAttempt(): void {
    this.attempts += 1;
  }

  /** Reset the streak — a response with no invalid mermaid fences. */
  reset(): void {
    this.attempts = 0;
  }

  /** Number of recovery attempts recorded since the last reset. */
  get attemptsUsed(): number {
    return this.attempts;
  }
}
