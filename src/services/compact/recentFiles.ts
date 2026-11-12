/**
 * recentFiles.ts
 *
 * Builds the "recent files" stub that is re-injected into the prompt right
 * after a compaction, plus the bounded disk reader that fills it.
 *
 * WHY this module exists: a compaction replaces every message row of the
 * session, so the `read_file` / `patch_file` / `write_file` calls that named
 * the files the session was working on are summarised away — and the model,
 * no longer able to see what it had, re-reads them all from scratch. The
 * information is recoverable: `session_recent_files` (written by
 * `fileTouchRecorder.ts`) remembers the paths, and the files themselves are on
 * disk. So the stub re-states the working set and, when a file fits WHOLE,
 * reproduces it.
 *
 * Three properties matter more than the wording:
 *
 * 1. IT MUST FIT. The stub is paid for out of the context the compaction just
 *    freed, so it can only ever be a fixed fraction of the window and of the
 *    room left below the acceptance boundary
 *    (see {@link computeBudgetForResult}) — and it must never make the
 *    result no smaller than the history it replaced, or the compaction would
 *    abort on its own `new >= old` guard.
 * 2. IT MUST BE WHOLE OR NOTHING. A `read_file` hands the model the whole
 *    file, so a 1 000-token HEAD of a 2 000-line file is not a smaller version
 *    of what the model had — it is 6 % of it, from the region it was probably
 *    not editing, and it costs a re-read on top of the tokens. A file whose
 *    whole text does not fit the per-file budget is therefore named by path,
 *    line count and a hint (`— 2 041 lines; read the region you need`) and
 *    costs one line instead of a thousand misleading tokens. Nothing is ever
 *    truncated into the stub: a complete file, or no content at all.
 * 3. IT MUST BE HONEST. The paths are the part that turns "search the repo"
 *    into "read these five", so they are always emitted; the header does not
 *    promise an excerpt per file; the block says the excerpts are a snapshot
 *    from compaction time and may be stale (it is persisted and re-sent on
 *    every later turn, so "current" would become a lie within one turn); and
 *    the two structural markers are neutralised inside file content, so a file
 *    that happens to contain `[End recent files]` cannot forge the end of the
 *    block.
 *
 * The planner is PURE apart from the injected reader: `buildRecentFilesMessage`
 * never touches the filesystem, `/proc` or the database, which is what lets the
 * tests drive it with a stub (`tests/compact-recent-files.test.mjs`). The
 * only code that reads the disk is `readRecentFileFromDisk` (`recentFilesDisk.ts`), and
 * the caller passes it in.
 */

import path from 'node:path';

import type { RecentFileRow } from '@/services/history';
import type { ChatMessage } from '@/services/llm';

import { countMessagesTokens, countTextTokens } from '@/services/tokenizer';
import { redact } from '@/tools/textSanitizer';

import {
  RECENT_FILES_LOAD_LIMIT,
  RECENT_FILES_MAX_FILES,
  RECENT_FILES_MAX_TOKENS_PER_FILE,
  RECENT_FILES_MAX_TOTAL_TOKENS,
  RECENT_FILES_MAX_WINDOW_RATIO,
  RECENT_FILES_MESSAGE_FRAMING_TOKENS,
  RECENT_FILES_MESSAGE_OVERHEAD_TOKENS,
  RECENT_FILES_MIN_TOKENS,
  RECENT_FILES_TRUNCATION_MARKER,
} from './constants';
import {
  type ChosenFile,
  countLines,
  type RecentFilesDroppedReason,
  renderStub,
} from './recentFilesRender';

/**
 * Reads one file for the stub. Injected so the planner stays pure and testable:
 * the real implementation is `readRecentFileFromDisk` (`recentFilesDisk.ts`), the tests pass a
 * lookup table.
 *
 * Returns the file's text, or `null` when it cannot (or must not) be read —
 * a deleted file, a directory, a binary, or a path outside the working
 * directory. `null` is not an error: the planner simply falls through to the
 * next file.
 */
export type RecentFileReader = (absPath: string) => Promise<string | null>;

/** The input to {@link buildRecentFilesMessage}. */
export interface RecentFilesPlanInput {
  /** The rows to consider, newest first (as `loadRecentFiles` returns them). */
  files: RecentFileRow[];
  /** The most tokens the stub's TEXT may occupy — see {@link computeBudgetForResult}. */
  budgetTokens: number;
  /** The model whose tokenizer measures the stub. */
  model: string;
  /** Whether file content is run through `redact()` before being measured. */
  redactSecrets: boolean;
  /** The reader (see {@link RecentFileReader}). */
  readExcerpt: RecentFileReader;
  /**
   * Paths that are ALREADY in the preserved window, verbatim (see
   * {@link pathsNamedInToolCalls}). They keep their bullet — the list is what
   * matters — but they are not reproduced again: the window below carries the
   * `read_file` result and its arguments, so a second copy of the same file is
   * pure waste.
   */
  inContextPaths?: readonly string[];
  /** Epoch milliseconds to render the ages against; defaults to `Date.now()`. */
  now?: number;
}

/** What {@link buildRecentFilesMessage} produced. */
export interface RecentFilesPlan {
  /** The message body — empty when the stub was dropped entirely. */
  text: string;
  /** `countTextTokens(text, model)`: what the TEXT costs (the message adds 5). */
  tokensUsed: number;
  /** The paths whose bullets are in `text`, in the order rendered. */
  included: string[];
  /** Why the stub is incomplete (see {@link RecentFilesDroppedReason}). */
  dropped: RecentFilesDroppedReason;
}

/**
 * The tools whose touch is an EDIT rather than a look.
 *
 * WHY it matters: slots and content are allocated in priority order, and a file
 * the session has WRITTEN is both more likely to be the thing it is working on
 * and less recoverable from the summary (the summariser is told to record "every
 * file touched", but only a path). A file that was merely read is at least
 * still findable in a summary that names it.
 */
const RECENT_FILES_EDIT_TOOLS: ReadonlySet<string> = new Set(['patch_file', 'write_file']);

/** A plan with no text at all, for the early exits. */
function emptyPlan(dropped: RecentFilesDroppedReason): RecentFilesPlan {
  return { text: '', tokensUsed: 0, included: [], dropped };
}

/** True for a finite number (the store is JS-written, but never trust a row). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Keeps only the rows that can be rendered, newest first, capped at
 * {@link RECENT_FILES_LOAD_LIMIT}.
 *
 * WHY a validation pass and not a `slice`: the rows come from the database and
 * the planner is the last place that can refuse one. A row with no path renders
 * as `-  (read_file, …)` and a row with a `NaN` timestamp renders as
 * `NaN d ago` — both are worse than leaving the row out.
 *
 * WHY the cap is the LOAD limit and not the five the stub shows: five dead
 * paths must not be able to starve the five slots (see
 * {@link buildRecentFilesMessage}), so the planner — not this function — decides
 * which five of the candidates are worth a slot.
 *
 * Newest first, ties broken by path so the same-millisecond touches (which the
 * recorder does produce, and which the loader orders deterministically) stay
 * deterministic here too.
 */
export function selectRecentFiles(files: readonly RecentFileRow[]): RecentFileRow[] {
  const seen = new Set<string>();
  const valid: RecentFileRow[] = [];
  for (const row of Array.isArray(files) ? files : []) {
    if (typeof row !== 'object' || row === null) continue;
    const rawPath = typeof row.path === 'string' ? row.path.trim() : '';
    if (rawPath === '') continue;
    if (seen.has(rawPath)) continue;
    seen.add(rawPath);
    valid.push({
      path: rawPath,
      tool: typeof row.tool === 'string' ? row.tool.trim() : '',
      // A hit count that is not a positive integer cannot be rendered honestly,
      // and this row has certainly been touched once (it exists because of one).
      hits: isFiniteNumber(row.hits) && row.hits >= 1 ? Math.floor(row.hits) : 1,
      lastSeenAt: isFiniteNumber(row.lastSeenAt) ? row.lastSeenAt : 0,
    });
  }
  valid.sort(byRecencyThenPath);
  return valid.slice(0, RECENT_FILES_LOAD_LIMIT);
}

/** Newest first; the same millisecond is ordered by path, so the order is deterministic. */
function byRecencyThenPath(left: RecentFileRow, right: RecentFileRow): number {
  if (right.lastSeenAt !== left.lastSeenAt) return right.lastSeenAt - left.lastSeenAt;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/**
 * Orders the selected files for SLOT allocation: edits first, then reads, then
 * recency.
 *
 * WHY this order and not plain recency: the slots are the scarce resource (a
 * bullet costs a line, and only five files get one). A `read_file` is the
 * cheapest touch to lose — the summary names the path and the model can re-read
 * it — while a `patch_file` / `write_file` marks the file the session is
 * CHANGING, which is what "continuation" means. Recency breaks ties, so within
 * a tier the newest edit still wins.
 *
 * The returned array is a new array; the input is not reordered.
 */
export function sortFilesForExcerpts(files: readonly RecentFileRow[]): RecentFileRow[] {
  const tier = (file: RecentFileRow) => (RECENT_FILES_EDIT_TOOLS.has(file.tool) ? 0 : 1);
  return [...files].sort((left, right) => {
    const leftTier = tier(left);
    const rightTier = tier(right);
    if (leftTier !== rightTier) return leftTier - rightTier;
    return byRecencyThenPath(left, right);
  });
}

/**
 * Inspects one candidate: reads it, and decides whether it can be reproduced.
 *
 * Never throws — the reader is arbitrary code as far as this module is
 * concerned, and one bad file must not cost the other four.
 */
async function inspectFile(
  file: RecentFileRow,
  input: RecentFilesPlanInput,
  inContext: ReadonlySet<string>,
  model: string
): Promise<ChosenFile> {
  let raw: string | null;
  try {
    raw = await input.readExcerpt(file.path);
  } catch {
    // A reader that throws is a reader that could not read.
    raw = null;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return { file, missing: 'unreadable' };

  // A body the reader cut is NOT the file: it can never be reproduced whole,
  // however few tokens the head happens to be (see the module header).
  const truncated = raw.endsWith(RECENT_FILES_TRUNCATION_MARKER);
  const text = truncated ? raw.slice(0, raw.length - RECENT_FILES_TRUNCATION_MARKER.length) : raw;
  const lineCount = countLines(text);

  if (inContext.has(file.path) || inContext.has(path.resolve(file.path))) {
    return { file, lineCount, missing: 'in-context' };
  }

  const prepared = input.redactSecrets ? redact(text) : text;
  if (prepared.trim() === '') return { file, lineCount, missing: 'unreadable' };
  if (truncated || countTextTokens(prepared, model) > RECENT_FILES_MAX_TOKENS_PER_FILE) {
    return { file, lineCount, truncated, missing: 'oversize' };
  }
  return { file, lineCount, content: prepared };
}

/**
 * Computes how many tokens the recent-files stub's TEXT may occupy, charged
 * against a result that already EXISTS. Pure.
 *
 * The stub is built after the compaction's final message list is known, and
 * that list is the only thing it has to fit next to. After a retry the final
 * history's summary, window and system prompt are not separable cheaply (the
 * retry returns messages, not a breakdown), but their SUM is exactly
 * `stats.newTokenCount` — which is all the arithmetic needs.
 *
 * Two ceilings, and the smaller wins:
 *
 * - `min(RECENT_FILES_MAX_TOTAL_TOKENS, floor(numCtx * 0.1))` — the stub's
 *   share of the WINDOW. 5000 tokens is nothing on a 200k window and a fifth
 *   of a 24k one, so the flat cap alone cannot be the answer. The message
 *   framing is subtracted from it, because the ceiling is a ceiling for the
 *   MESSAGE and this number budgets the text.
 * - everything the compaction result can still grow by — the acceptance
 *   boundary, minus what the result already carries (the summary header, the
 *   preserved window, the system prompt), minus the stub's own message framing.
 *
 * The `min(acceptanceBudget, max(0, oldTokenCount - 1))` cap is load-bearing:
 * the pipeline aborts a compaction whose result is not smaller than its input
 * (`evaluateCompactionSizes` → `aborted`), so a stub that ate the whole
 * acceptance budget on a history that was not near it would turn a successful
 * compaction into a thrown error. Charging the stub against `old - 1` (not
 * `old`) keeps at least one token of saving when that is the tighter bound.
 *
 * Returns 0 — never a token count too small to buy anything — below
 * {@link RECENT_FILES_MIN_TOKENS}, so the caller has one condition to test.
 */
export function computeBudgetForResult(params: {
  /** The context window the compaction runs against. */
  numCtx: number;
  /** `floor(numCtx * COMPACT_ACCEPTANCE_HEADROOM)` — where the result must land. */
  acceptanceBudget: number;
  /** The tokens of the history being replaced (the abort guard's left side). */
  oldTokenCount: number;
  /** The tokens the finished result already carries, system prompt included. */
  resultTokens: number;
}): number {
  const charge = (value: number) => (isFiniteNumber(value) ? value : 0);
  const numCtx = Math.max(0, charge(params.numCtx));
  const ceiling = Math.min(
    RECENT_FILES_MAX_TOTAL_TOKENS,
    Math.floor(numCtx * RECENT_FILES_MAX_WINDOW_RATIO)
  );
  const boundary = Math.min(
    charge(params.acceptanceBudget),
    Math.max(0, charge(params.oldTokenCount) - 1)
  );
  const room = boundary - charge(params.resultTokens) - RECENT_FILES_MESSAGE_OVERHEAD_TOKENS;
  // The framing is subtracted ONCE, from whichever ceiling binds: both of them
  // bound the MESSAGE (`budget` is a budget for the text), so both have to pay
  // for the 5 tokens the message itself costs.
  const budget = Math.max(
    0,
    Math.min(ceiling, Math.floor(room)) - RECENT_FILES_MESSAGE_FRAMING_TOKENS
  );
  return budget < RECENT_FILES_MIN_TOKENS ? 0 : budget;
}

/**
 * Attaches the stub to a FINISHED history, or refuses to.
 *
 * WHY this is a function with a return value and not three lines inline: the
 * invariant it enforces is the one the whole feature is judged on — "if the
 * progress line says the files were attached, they are in the returned
 * messages" — and a function can be driven with a history that fits and a
 * history that does not, while an inline `splice` can only be inspected.
 *
 * The message goes directly after the summary (index 0), because that is the
 * only position this code may assume: after the summary it reads as part of
 * "what came before", while after the window it would read as the newest event
 * in the conversation.
 *
 * Returns the NEW array (the input is not mutated), or `null` when attaching
 * would push the result back to — or past — the size of the history it
 * replaced. That second check is not decoration: `evaluateCompactionSizes`
 * ABORTS a compaction whose result is not smaller than its input, so a stub
 * that un-shrank the history would surface as a failed compaction.
 */
export function attachRecentFilesMessage(params: {
  /** The finished history, summary first. */
  messages: readonly ChatMessage[];
  /** The stub message to insert at index 1. */
  message: ChatMessage;
  /** The model whose tokenizer measures the result. */
  model: string;
  /** The tokens of the system prompt the next request carries. */
  systemPromptTokens: number;
  /** The tokens of the history being replaced (the abort guard's left side). */
  oldTokenCount: number;
  /** Where the result has to land (`floor(numCtx * headroom)`). */
  acceptanceBudget: number;
}): ChatMessage[] | null {
  const candidate = [...params.messages];
  candidate.splice(1, 0, params.message);
  const systemPromptTokens = isFiniteNumber(params.systemPromptTokens)
    ? params.systemPromptTokens
    : 0;
  const tokens = countMessagesTokens(candidate, params.model) + systemPromptTokens;
  if (!(tokens < params.oldTokenCount)) return null;
  if (isFiniteNumber(params.acceptanceBudget) && tokens > params.acceptanceBudget) return null;
  return candidate;
}

/**
 * Adds every form a path may be matched by: as written, resolved against the
 * process cwd, and (when a `root` is given) resolved against that root.
 *
 * The rows are stored absolute and the model writes relative paths as often as
 * absolute ones, so a path is compared in all of its forms.
 */
function addPathForms(forms: Set<string>, rawPath: string, root?: string): void {
  forms.add(rawPath);
  forms.add(path.resolve(rawPath));
  if (typeof root === 'string' && root.trim() !== '') forms.add(path.resolve(root, rawPath));
}

/**
 * The paths a history's tool calls name, resolved as far as `root` allows.
 *
 * WHY this exists: the preserved window is several turns of verbatim history, so
 * the files touched most recently are usually ALREADY in it — complete, with
 * the tool result the model itself asked for. Reproducing them in the stub pays
 * a second time for the same bytes. The scan is deliberately shallow (the
 * `path` argument of a tool call, which is the only place a file tool names a
 * file) and deliberately tolerant: the model writes relative paths as often as
 * absolute ones, and the row is stored absolute, so a candidate is matched by
 * the string as written, resolved against the process cwd, and resolved against
 * the request's working-directory root.
 *
 * Never throws: a `tool_calls` payload is whatever the model emitted.
 */
export function pathsNamedInToolCalls(
  messages: readonly ChatMessage[],
  root?: string
): Set<string> {
  const found = new Set<string>();
  const remember = (rawPath: string) => addPathForms(found, rawPath, root);
  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message !== 'object' || message === null) continue;
    if (message.role !== 'assistant') continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
      const args: unknown = call?.function?.arguments;
      let parsed: unknown = args;
      if (typeof args === 'string') {
        try {
          parsed = JSON.parse(args);
        } catch {
          continue;
        }
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const rawPath = (parsed as { path?: unknown }).path;
      if (typeof rawPath === 'string' && rawPath.trim() !== '') remember(rawPath.trim());
    }
  }
  return found;
}

/**
 * Builds the recent-files stub, or an empty plan when it cannot be built.
 *
 * Order of operations, and why it is this order:
 *
 * 1. The candidates are walked in PRIORITY order (edits before reads, then
 *    recency — see {@link sortFilesForExcerpts}) up to
 *    {@link RECENT_FILES_MAX_FILES} slots. A candidate that cannot be read does
 *    NOT take a slot: it would spend one of five on a path the model cannot
 *    open, so the walk continues past it and only backfills with dead paths if
 *    the list would otherwise be short. That is what makes
 *    {@link RECENT_FILES_LOAD_LIMIT} live — five dead heads can no longer
 *    starve five readable files further down the table.
 * 2. The MANDATORY part (header + one bullet per chosen file + the closing
 *    marker) is rendered and measured. If it does not fit, slots are dropped
 *    from the end until it does; if not even one fits there is no stub.
 * 3. Content is then bought in the same priority order, each file WHOLE or not
 *    at all, each measured against the real tokenizer, and accepted only if the
 *    WHOLE text still fits. A file that does not fit is left as its line-count
 *    bullet — the hint costs one line and is true, while a truncated head costs
 *    a thousand tokens and points at the wrong region.
 * 4. Redaction happens BEFORE measurement, because `redact()` shortens the
 *    text: measuring first and redacting after would hand the model a block
 *    smaller than the one that was paid for, while measuring an unredacted
 *    string and sending a redacted one would make `tokensUsed` a lie.
 * 5. Paths are never redacted: a path is not a secret, and a mangled path is a
 *    file the model cannot open.
 *
 * @param input - see {@link RecentFilesPlanInput}.
 */
export async function buildRecentFilesMessage(
  input: RecentFilesPlanInput
): Promise<RecentFilesPlan> {
  const now = isFiniteNumber(input.now) ? input.now : Date.now();
  const model = input.model;
  const candidates = selectRecentFiles(input.files ?? []);
  if (candidates.length === 0) return emptyPlan('no-files');

  const budget = isFiniteNumber(input.budgetTokens) ? Math.floor(input.budgetTokens) : 0;
  if (budget < RECENT_FILES_MIN_TOKENS) return emptyPlan('no-budget');

  const inContext = new Set<string>();
  for (const rawPath of input.inContextPaths ?? []) {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') continue;
    addPathForms(inContext, rawPath);
  }

  // 1. The slot walk. Readable files take the slots; unreadable candidates are
  // remembered but only used to backfill, so they cannot cost a slot.
  const usable: ChosenFile[] = [];
  const unreadable: ChosenFile[] = [];
  for (const file of sortFilesForExcerpts(candidates)) {
    if (usable.length >= RECENT_FILES_MAX_FILES) break;
    const entry = await inspectFile(file, input, inContext, model);
    if (entry.missing === 'unreadable') {
      unreadable.push(entry);
      continue;
    }
    usable.push(entry);
  }
  let chosen = usable;
  if (chosen.length < RECENT_FILES_MAX_FILES && unreadable.length > 0) {
    chosen = [...chosen, ...unreadable.slice(0, RECENT_FILES_MAX_FILES - chosen.length)];
  }
  if (chosen.length === 0) return emptyPlan('no-files');

  // 2. The mandatory part, shrunk from the end (the lowest-priority slot) until
  // it fits. Below the floor this cannot bite, but the planner must not depend
  // on a constant for its own correctness.
  const noContent = new Map<string, string>();
  while (
    chosen.length > 0 &&
    countTextTokens(renderStub(chosen, noContent, now, false), model) > budget
  ) {
    chosen = chosen.slice(0, -1);
  }
  if (chosen.length === 0) return emptyPlan('no-budget');

  // 3. Content, whole file or nothing, in priority order.
  const contents = new Map<string, string>();
  let sawNoRoom = false;
  chosen = chosen.map((entry) => ({ ...entry }));
  for (const entry of chosen) {
    if (entry.content === undefined) continue;
    const candidate = new Map(contents);
    candidate.set(entry.file.path, entry.content);
    if (countTextTokens(renderStub(chosen, candidate, now, false), model) <= budget) {
      contents.set(entry.file.path, entry.content);
      continue;
    }
    // Readable, whole, and still unaffordable: the bullet keeps its line count
    // and the hint, and says the budget — not the file — is why.
    entry.missing = 'no-room';
    sawNoRoom = true;
  }

  let text = renderStub(chosen, contents, now, false);
  if (sawNoRoom) {
    const withOmission = renderStub(chosen, contents, now, true);
    if (countTextTokens(withOmission, model) <= budget) text = withOmission;
  }

  return {
    text,
    tokensUsed: countTextTokens(text, model),
    included: chosen.map((entry) => entry.file.path),
    dropped: droppedReason(chosen, contents.size, sawNoRoom),
  };
}

/** Why the stub carries no content, in order of how much it explains. */
function droppedReason(
  chosen: readonly ChosenFile[],
  contentCount: number,
  sawNoRoom: boolean
): RecentFilesDroppedReason {
  if (contentCount > 0) return 'none';
  if (chosen.every((entry) => entry.missing === 'unreadable')) return 'unreadable';
  if (sawNoRoom) return 'no-budget';
  if (chosen.some((entry) => entry.missing === 'oversize')) return 'oversize';
  return 'in-context';
}
