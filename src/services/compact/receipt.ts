/**
 * receipt.ts
 *
 * The line the transcript shows after a compaction — the ONE place the user is
 * told what the compaction actually did.
 *
 * WHY this is a module and not two template literals: the manual `/compact`
 * path and the automatic path each wrote their own sentence, with different
 * wording, different number formatting and no percentage, so the same event
 * read differently depending on whether the user asked for it. Neither said
 * how much was saved as a fraction, and neither said when the result was STILL
 * too large for the window — the one outcome the user has to act on.
 *
 * NO IMPORTS, ON PURPOSE: the browser imports this to render the manual
 * receipt, so it must not reach the compaction barrel (and through it the
 * tokenizer and the LLM adapters). It is pure arithmetic over numbers.
 */

/**
 * How many characters of the user's focus note a receipt quotes back.
 *
 * WHY short: the note can be up to `COMPACT_FOCUS_MAX_CHARS` (2000)
 * characters, and the receipt is a one-line status message, not a copy of the
 * request. 60 characters is enough to recognise WHICH note was used.
 */
const RECEIPT_FOCUS_MAX_CHARS = 60;

/** The marker appended to a focus note the receipt had to cut. */
const ELLIPSIS = '…';

/** The bolt that marks a successful compaction. */
const BOLT = '⚡';

/** The sign that marks an outcome the user has to know about. */
const WARNING_SIGN = '⚠️';

/**
 * Formats one token count for a receipt: rounded, then grouped with commas.
 *
 * The grouping locale is pinned to `en-US` rather than left to the host: the
 * receipt is asserted verbatim in tests, and a build machine with a different
 * default locale (or a Node built without full ICU) would otherwise render
 * `12.880` or `12 880` and change the sentence without changing the number.
 *
 * @param value - the token count.
 * @returns the count as `181,204`.
 */
export function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** What a receipt needs to know about the compaction it reports. */
export interface CompactionReceiptInput {
  /** The size of the history before compaction, in estimated tokens. */
  oldTokenCount?: number | null;
  /** The size of the compacted history, in estimated tokens. */
  newTokenCount?: number | null;
  /** The context window the compacted history has to fit, in tokens. */
  tokenLimit?: number | null;
  /** True when the pipeline compacted on its own, false/absent when the user ran `/compact`. */
  automatic?: boolean;
  /**
   * The note the user attached to `/compact`, already normalised. Quoted back
   * so the receipt says what the summary was told to keep.
   */
  focus?: string;
}

/** The rendered receipt: the status line, plus an optional warning line. */
export interface CompactionReceipt {
  /** The status line, always non-empty. */
  text: string;
  /** The follow-up line when the compacted history is still too large, else `null`. */
  warning: string | null;
}

/** True when `value` is a count the receipt can print. */
function isCount(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Renders the note about what the user asked the summary to keep.
 *
 * The note is appended to whichever status line was produced: it records what
 * was ASKED FOR, which is true of every outcome, not a claim that the summary
 * managed to honour it.
 *
 * @param focus - the normalised focus note.
 * @returns the sentence to append, or `''` when there was no note.
 */
function formatFocusSuffix(focus: string | undefined): string {
  const trimmed = focus?.trim() ?? '';
  if (trimmed.length === 0) {
    return '';
  }
  const quoted =
    trimmed.length > RECEIPT_FOCUS_MAX_CHARS
      ? `${trimmed.slice(0, RECEIPT_FOCUS_MAX_CHARS)}${ELLIPSIS}`
      : trimmed;
  return ` Kept what you asked for: “${quoted}”.`;
}

/**
 * Renders the transcript line for one compaction.
 *
 * Five outcomes, each pinned:
 *
 *   - reduced   → `⚡ Conversation compacted: 181,204 → 12,880 tokens (~93% smaller).`
 *                  (`auto-compacted` on the automatic path; the percentage is
 *                  whole and prefixed with `~` because both counts are local
 *                  ESTIMATES, not provider-reported figures; a saving that
 *                  rounds to 0 says `(<1% smaller)` rather than claiming
 *                  `~0% smaller`, which reads as "nothing happened")
 *   - not smaller → `⚠️ Compaction could not reduce the context: 181,204 → 181,204 tokens.`
 *   - no counts  → `⚡ Conversation compacted.`
 *   - with focus → the same line, plus ` Kept what you asked for: “…”`.
 *   - still over → the same line, plus a `warning` naming both counts.
 *
 * @param input - what the compaction reported.
 * @returns the status text and, when the result is still too large, the warning.
 */
export function formatCompactionReceipt(input: CompactionReceiptInput): CompactionReceipt {
  const { oldTokenCount, newTokenCount, tokenLimit, automatic = false, focus } = input;
  const subject = automatic ? 'auto-compacted' : 'compacted';
  const suffix = formatFocusSuffix(focus);

  let text: string;
  if (!isCount(oldTokenCount) || !isCount(newTokenCount) || oldTokenCount <= 0) {
    // No usable pair of counts: a compaction happened (the caller would not be
    // rendering a receipt otherwise) but there is no ratio to report, and
    // inventing one would be worse than saying nothing.
    text = `${BOLT} Conversation ${subject}.`;
  } else if (newTokenCount >= oldTokenCount) {
    // The pipeline aborts a result that is LARGER than its input, so `>` here
    // is defence in depth; `===` is the real case, a pass that produced a
    // summary exactly as large as the history it replaced.
    text =
      `${WARNING_SIGN} Compaction could not reduce the context: ` +
      `${formatTokenCount(oldTokenCount)} → ${formatTokenCount(newTokenCount)} tokens.`;
  } else {
    const percent = Math.round(((oldTokenCount - newTokenCount) / oldTokenCount) * 100);
    const size = percent < 1 ? '(<1% smaller)' : `(~${percent}% smaller)`;
    text =
      `${BOLT} Conversation ${subject}: ` +
      `${formatTokenCount(oldTokenCount)} → ${formatTokenCount(newTokenCount)} tokens ${size}.`;
  }

  // Strictly GREATER, and only against a real window: a history exactly at the
  // limit still fits, and a caller that could not resolve a window (0) must not
  // turn every compaction into a warning.
  const overflowWarning =
    isCount(newTokenCount) && isCount(tokenLimit) && tokenLimit > 0 && newTokenCount > tokenLimit
      ? `${WARNING_SIGN} The compacted history is still over the context window ` +
        `(${formatTokenCount(newTokenCount)} of ${formatTokenCount(tokenLimit)} tokens, estimated). ` +
        'The next turn may fail.'
      : null;

  return { text: `${text}${suffix}`, warning: overflowWarning };
}
