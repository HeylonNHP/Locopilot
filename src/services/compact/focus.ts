/**
 * focus.ts
 *
 * Normalisation of the optional focus note a user can type after `/compact`.
 *
 * NO IMPORTS, ON PURPOSE, AND THAT IS THE CONTRACT. The browser reads
 * {@link COMPACT_FOCUS_MAX_CHARS} to refuse an over-long note before it is
 * even sent, and the server reads {@link normaliseCompactionFocus} to sanitise
 * it. If this module imported the compaction barrel it would drag the
 * tokenizer, the LLM adapters and (transitively) `node:crypto` into the client
 * bundle, so it stays a leaf: pure functions over a string, nothing else.
 *
 * WHY the focus is COLLAPSED TO ONE LINE rather than escaped or stripped:
 * the note is interpolated into the summariser's system prompt, and a prompt
 * is a document whose STRUCTURE carries meaning. A note that can emit its own
 * line breaks can emit a line that reads like one of the prompt's own
 * constructs — a `Rules:` heading that redefines the rules below it, a
 * `[USER]:` block label that makes the model believe the history contains a
 * turn the user never wrote, or a bare section header that the model then
 * treats as the section list. No amount of escaping makes that safe, because
 * the model does not parse escape sequences. Collapsing every run of
 * whitespace to a single space means the note can only ever be WORDS INSIDE a
 * sentence: it cannot open a line, so it cannot impersonate a structural
 * element of the prompt.
 */

/**
 * The longest focus note the pipeline accepts, in characters.
 *
 * WHY a limit at all: the note is measured against the summariser's input
 * budget (it is part of the prompt), so an unbounded note could crowd out the
 * history the summary is supposed to record. 2000 characters is roughly 500
 * tokens — a paragraph of instruction, not a document.
 *
 * WHY it is REJECTED rather than truncated: the user typed the note to steer
 * the summary, and the part that would be silently dropped is the TAIL — the
 * qualification, the exception, the "but keep the failing test output". A 400
 * that names the limit lets them keep the part they cared about.
 */
export const COMPACT_FOCUS_MAX_CHARS = 2000;

/**
 * The longest RAW focus note the route even looks at, in characters.
 *
 * WHY it exists on top of {@link COMPACT_FOCUS_MAX_CHARS}: that limit is
 * checked on the NORMALISED note, and normalising a 10 MB string means walking
 * every character (`stripControlCharacters`) and collapsing every whitespace
 * run — the whole thing is materialised, twice, before the 400 that was always
 * going to be sent. This is a cheap `string.length` read on the RAW value, and
 * it is a GENEROUS multiple (4× the real limit), so an ordinary over-long note
 * — one the normaliser might still collapse under the limit, which is why the
 * limit is checked on the normalised form — still reaches the normaliser. Only
 * a note that is orders of magnitude too big is refused here, with the same
 * 400 and the same wording as the normalised check.
 */
export const COMPACT_FOCUS_RAW_MAX_CHARS = COMPACT_FOCUS_MAX_CHARS * 4;

/** The highest C0 control code (`U+0000`–`U+001F`). */
const CONTROL_CODE_MAX = 0x1f;
/** DEL, which sits alone between the C0 and C1 control blocks. */
const DELETE_CODE = 0x7f;
/** The highest C1 control code (`U+0080`–`U+009F`). */
const C1_CONTROL_CODE_MAX = 0x9f;

/**
 * Replaces every control character with a space.
 *
 * WHY a hand-written loop instead of a `[\u0000-\u001f]` regex: a regex that
 * names control characters is a lint error (`no-control-regex`) in every
 * configuration that has ever shipped it, and the rule is right — such a
 * pattern is nearly always a mistake. Writing the range as NUMBERS keeps the
 * intent visible and the linter honest.
 *
 * @param value - the raw string.
 * @returns the same text with each control character turned into a space.
 */
function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isControl =
      code <= CONTROL_CODE_MAX || (code >= DELETE_CODE && code <= C1_CONTROL_CODE_MAX);
    result += isControl ? ' ' : character;
  }
  return result;
}

/**
 * Normalises a focus note into the form the prompt can safely carry.
 *
 * The three steps each remove one way the note could reach the prompt in a
 * shape the prompt did not intend:
 *
 *   1. A non-string (a number, an object, `null`, an absent field) is not a
 *      note at all — `undefined` keeps the caller on the existing,
 *      focus-free path rather than sending `"42"` into the prompt.
 *   2. Control characters become spaces, so `\r\n` and `\u0000` cannot act as
 *      line or field separators.
 *   3. Every run of whitespace collapses to ONE space and the ends are
 *      trimmed, so the note is a single line by construction. A newline that
 *      survives this step would be the injection vector described in the file
 *      header.
 *
 * @param value - whatever the client or the request body supplied.
 * @returns the normalised note, or `undefined` when there is nothing to say.
 */
export function normaliseCompactionFocus(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const singleLine = stripControlCharacters(value).replaceAll(/\s+/gu, ' ').trim();
  return singleLine.length > 0 ? singleLine : undefined;
}
