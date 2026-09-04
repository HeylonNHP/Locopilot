/**
 * constants.ts
 *
 * Shared ratio/limit constants for the compaction pipeline. Centralising these
 * keeps budget maths, distillation limits and prompt wording consistent across
 * the split / distill / summarise / reduce modules so the whole pipeline stays
 * in one easily-tuned place.
 */

// ---- Conversation summariser prompt ----
export const SUMMARY_PREAMBLE =
  '[This conversation history has been compacted. What follows is a concise ' +
  'summary of everything important that has occurred so far. Treat it as ' +
  'authoritative context for continuing the conversation.]';

// ---- Synthetic system-generated user-role nudges ----
// Server-generated LLM-only nudges (post-compaction "please continue",
// empty-response recovery, prompt-loop continuation) are pushed into the
// in-memory history with role 'user'. They are NOT real user prompts, so the
// compaction pipeline's latest-user-message anchor must never latch onto one
// — anchoring on a nudge would let the real user prompt be summarised away
// on a second compaction within the same turn. Every synthetic nudge starts
// its content with this marker so the anchor can recognise and skip it.
export const SYNTHETIC_NUDGE_MARKER = '[System notice: ';
export const SYNTHETIC_NUDGE_END = ' [End system notice]';

// Post-compaction nudge adaptive directive. Once compaction has fired this
// many times in the same turn (main chat loop or sub-agent), the nudge stops
// saying "please continue" and starts telling the model to economise — it is
// demonstrably thrashing against the context window. Shared so the main
// route and sub-agents switch behaviour at the same threshold.
export const COMPACTION_ADAPTIVE_DIRECTIVE_THRESHOLD = 2;
export const COMPACTION_ADAPTIVE_DIRECTIVE =
  ' You are repeatedly hitting the context limit — be economical with tool ' +
  'output, avoid re-reading large files or repeating searches, and consider ' +
  'whether your current approach is viable or should be changed.';

// Continuation directive sent after the FIRST auto-compaction. The wording
// differs slightly between the main loop and sub-agents because the latter
// is resuming a delegated task rather than the user's original request. Kept
// here (next to COMPACTION_ADAPTIVE_DIRECTIVE) so both consumers can swap to
// the adaptive directive at the same threshold without copy-pasted literals
// drifting again.
export const COMPACTION_INITIAL_DIRECTIVE = {
  main: ' Please continue working on the original task without asking for confirmation.',
  subAgent: 'Please continue working on that request without asking for confirmation.',
} as const;

// ---- History splitting / preservation ratios ----
export const MIN_SUMMARISE_TOKENS = 200;
export const PRESERVE_RECENT_TOKENS_RATIO = 0.12;
export const RECENT_TOKEN_BUDGET_FLOOR_RATIO = 0.03;
export const RECENT_TOKEN_BUDGET_CEILING_RATIO = 0.3;
export const MIN_PRESERVED_TOKEN_BUDGET = 300;
export const MIN_TO_SUMMARISE_RATIO = 0.25;

// ---- Summary token budgets ----
export const SUMMARY_TARGET_TOKENS_RATIO = 0.1;
export const SUMMARY_MAX_TOKENS_RATIO = 0.18;
export const SUMMARY_NUM_PREDICT_BUFFER_RATIO = 1.2;
export const MIN_TARGET_TOKENS_RATIO = 0.04;
export const MAX_TARGET_TOKENS_FLOOR = 500;
export const MAX_SUMMARY_TOKENS_FLOOR = 600;
export const MAX_SUMMARY_TOKENS_FLOOR_RATIO = 0.05;
export const MAX_SUMMARY_TOKENS_CEILING = 1200;
export const MAX_SUMMARY_TOKENS_CEILING_RATIO = 0.3;
export const MIN_SUMMARY_TOKENS_RATIO = 0.65;
export const SOURCE_CAP_RATIO = 0.7;

// Compacted result must fit within this fraction of numCtx to be accepted
// without triggering an automatic aggressive retry pass.
export const COMPACT_ACCEPTANCE_HEADROOM = 0.9;

// ---- Tool-output distillation ----
export const TOOL_DISTILL_SYSTEM_PROMPT =
  'You are a tool-output distiller. You will be given one tool result from an AI chat. ' +
  'Produce a compact, loss-minimised digest that preserves durable technical value.\n' +
  'Keep: concrete facts, file paths, URLs, commands, exit codes, errors, versions, and final outcomes.\n' +
  'Drop: boilerplate formatting, duplicated lines, verbose prose, and filler.\n' +
  'If this output is already concise, return a near-verbatim version.\n' +
  'Write plain text only (no markdown).';
export const TOOL_DISTILL_CHAR_THRESHOLD = 1200;
export const TOOL_DISTILL_MAX_CHARS = 2400;
export const TOOL_DISTILL_NUM_PREDICT = 1024;

// ---- Chunked (map-reduce) compaction ----
// The fraction of the model context window reserved for the input of a single
// summarisation request. Keeping this well below 1.0 leaves room for the
// instruction prompt and the model's output while still staying far under the
// hard model limit.
export const SAFE_INPUT_BUDGET_RATIO = 0.6;
// Maximum number of partial summaries combined in a single reduction request.
export const REDUCTION_FAN_IN = 4;
// Instruction used when combining partial summaries into one coherent summary.
export const REDUCTION_COMBINE_SYSTEM_PROMPT =
  'You are a conversation summariser working in a map-reduce pipeline. ' +
  'You will be given several PARTIAL summaries of sections of a conversation. ' +
  'Combine them into ONE coherent, dense narrative summary that preserves every ' +
  'decision, fact, file path, code snippet, command, result and unresolved task. ' +
  'Keep chronology and causality clear (what happened, why, and the latest status). ' +
  'Strip only filler/repetition. Write in third person. ' +
  'Return ONLY plain summary text (no headings, no markdown, no commentary).';
