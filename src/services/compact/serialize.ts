/**
 * serialize.ts
 *
 * Tool-aware serialisation of conversation history for the compaction
 * summariser. The summariser only ever sees prose, so the flat
 * `[ROLE]: content` rendering dropped every tool call: the model never learned
 * that `npm test` had been run, that a file had been edited, or which command
 * had failed — it saw tool output floating free of the action that produced
 * it. This module renders the history as labelled blocks that carry the
 * ACTION (the projected tool arguments) next to the OUTPUT (the tool result),
 * so the summary can state what actually happened.
 *
 * Arguments are PROJECTED, never dumped raw: `write_file` / `patch_file`
 * carry whole file bodies, which would bury the conversation under megabytes
 * of source code and blow the summarisation input budget.
 *
 * Four policies live here, and all of them are observable:
 *
 * 1. REDACTION. The projected arguments AND the tool results go through
 *    `redact()`, so a secret in a command line, in a `.env` file read with
 *    `read_file`, or in a fetched page never reaches the summariser — and
 *    therefore never reaches the durable summary, which is re-sent on every
 *    later turn and can be summarised by a different provider. The redaction
 *    is ON by default and is switched off only by the user's own setting.
 * 2. THE NEAREST OWNER. A tool result is labelled with the tool that the
 *    MOST RECENT assistant row issued, not with whatever the global map
 *    happens to hold: the same tool_call id is reused by local
 *    OpenAI-compatible servers that number their calls per request, and a
 *    last-write-wins map labelled a `run_command` result as `write_file`.
 * 3. VALID JSON. The projected arguments are assembled key by key under the
 *    cap, so the emitted JSON always parses. A projection cut in the middle
 *    of a string would hand the summariser broken JSON.
 * 4. NO FORGED BOUNDARIES. A line of message text that starts with a bracket
 *    is neutralised, so a message cannot render as what looks like a
 *    genuine tool-action block.
 */

import type { ChatMessage, ToolCall } from '@/services/adapters/llmAdapter';

import { redact } from '@/tools/textSanitizer';

/** Longest single projected argument value (cut marker included). */
export const SERIALIZED_TOOL_ARG_MAX_CHARS = 300;

/** Longest whole projected argument JSON (cut marker included). */
export const SERIALIZED_TOOL_ARGS_MAX_CHARS = 400;

/**
 * The default cap for the TEXT of one tool result.
 *
 * The tool result is the only unbounded part of the serialised history: a
 * command can print megabytes, and one such row would blow the summarisation
 * input budget on its own. The cap keeps the HEAD (what happened) and the
 * TAIL (the exit code, the artifact path) and drops the middle.
 */
export const SERIALIZED_TOOL_RESULT_MAX_CHARS = 8000;

/** Appended to anything that had to be cut, so "truncated" reads differently from "empty". */
const TRUNCATION_MARKER = '…';

/** Label used when a tool result cannot be traced back to the tool call that produced it. */
const UNKNOWN_TOOL_NAME = 'unknown_tool';

/** The key that marks a projection whose pairs did not all fit inside the cap. */
const TRUNCATED_PROJECTION_KEY = '_truncated';

/** The suffix the truncation marker adds to a projection — reserved up front. */
const TRUNCATION_MARKER_SUFFIX = `,"${TRUNCATED_PROJECTION_KEY}":true`;

/** The key that carries a bare (non-JSON) argument string for a tool that is not `run_command`. */
const RAW_ARGUMENT_KEY = '_raw';

/** The share of a truncated tool result that is kept at the head. */
const TOOL_RESULT_HEAD_RATIO = 0.7;

/**
 * Keys kept for tools without a dedicated projection. Everything else is
 * dropped: an unknown tool's arguments may hold secrets or file bodies, and
 * the summarised slice must never carry them verbatim.
 *
 * The list mirrors the real tool schemas (`src/tools/tools.ts` and the
 * per-tool schema files): `process_id` belongs to `check_process_output`,
 * `skill_name` to `load_skill`, `source` to `fetch_image`, `diagram` to
 * `render_mermaid`, and `tool`/`server` to `mcp_call`. `agents` and
 * `share_summaries` belong to `run_subagents`: without them its projection
 * was EMPTY, so the summariser saw a tool call with no arguments at all and
 * could record it as "called with no arguments" — a fact that is not in the
 * history. Nothing that can carry a body or a credential is on it, and every
 * value is capped like every other value (the `agents` array is JSON-encoded
 * and then cut at the same 300-character cap).
 */
const GENERIC_PROJECTED_KEYS = [
  'path',
  'url',
  'command',
  'query',
  'queries',
  'name',
  'id',
  'pattern',
  'target',
  'process_id',
  'skill_name',
  'source',
  'diagram',
  'tool',
  'server',
  'agents',
  'share_summaries',
] as const;

/** A projected argument value: strings are capped, numbers and booleans stay exact. */
type ProjectedValue = string | number | boolean;

/** One labelled slice of the history, as the summariser sees it. */
export interface SerializedBlock {
  /** The role tag the summariser sees, e.g. 'USER', 'ASSISTANT', 'TOOL run_command'. */
  label: string;
  /** The block's text. */
  text: string;
}

/**
 * The options of the serialiser.
 *
 * Every option is optional: the defaults are the policy the compaction
 * pipeline wants (redaction ON, a bounded tool result, the tool names derived
 * from the slice itself).
 */
export interface SerializeHistoryOptions {
  /**
   * Tool-call id → tool name, built from the FULL conversation. A tool result
   * can outlive the assistant row that issued it, so the map must not be
   * derived from the slice alone.
   */
  toolNames?: Map<string, string>;
  /**
   * Whether secrets are redacted out of the projected arguments AND the tool
   * results. Defaults to true — the same default as `Config.redactSecrets`.
   */
  redactSecrets?: boolean;
  /**
   * The cap for the text of one tool result. Defaults to
   * {@link SERIALIZED_TOOL_RESULT_MAX_CHARS}.
   */
  maxToolResultChars?: number;
}

/**
 * Cuts `text` to `maxChars` characters and marks the cut. The marker counts
 * towards the limit, so the result never exceeds `maxChars`.
 */
function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 1)}${TRUNCATION_MARKER}`;
}

/**
 * Renders an argument value as text. Objects and arrays are JSON-encoded
 * first so their size is bounded by the same cap as a plain string.
 */
function stringifyArgumentValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // A value that cannot be encoded (circular structure) is dropped rather
    // than failing the whole compaction.
    return '';
  }
}

/**
 * A projected argument value: redacted (when redaction is on), then capped.
 *
 * WHY redact HERE: a command line is a place people paste secrets. The tool
 * RESULT of `run_command` is redacted by the capture, but the tool CALL is
 * not — the arguments were dropped by the old flattening, so they never
 * reached the summariser. Now that they do, a secret typed into a command
 * would be carried into the summary verbatim. Redacting the projected value
 * keeps the summariser's input as safe as the output it is summarising.
 */
function capArgumentValue(value: unknown, redactSecrets: boolean): ProjectedValue {
  if (typeof value === 'number') {
    // A number carries no secret and no length, so it stays exact — a
    // `process_id` rendered as `"42"` would read as a string.
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const text = stringifyArgumentValue(value);
  // Redact BEFORE capping: a secret cut in half by the cap would not match
  // the rules and would survive.
  return capText(redactSecrets ? redact(text) : text, SERIALIZED_TOOL_ARG_MAX_CHARS);
}

/** The arguments of a tool call, and whether they arrived as a bare string. */
interface NormalisedArguments {
  /** The arguments as a record; empty when they arrived as a bare string. */
  args: Record<string, unknown>;
  /** True when the arguments arrived as a string that is not a JSON object. */
  isBareString: boolean;
}

/**
 * Normalises the `arguments` field of a tool call into a plain record. Some
 * providers hand the arguments over as a JSON string; those are parsed when
 * they parse, and otherwise kept as a single opaque value so the call is not
 * silently lost.
 */
function normaliseToolArguments(rawArguments: unknown): NormalisedArguments {
  if (typeof rawArguments === 'string') {
    try {
      const parsed: unknown = JSON.parse(rawArguments);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { args: parsed as Record<string, unknown>, isBareString: false };
      }
    } catch {
      // Not JSON — fall through to the bare-string handling below.
    }
    return { args: {}, isBareString: true };
  }
  if (rawArguments !== null && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return { args: rawArguments as Record<string, unknown>, isBareString: false };
  }
  return { args: {}, isBareString: false };
}

/**
 * Builds the projection for one tool call. The whitelist is deliberately
 * strict: only the arguments that describe WHAT happened are kept, never the
 * payload that carries it.
 */
function projectToolArguments(
  toolName: string,
  rawArguments: unknown,
  redactSecrets: boolean
): Record<string, ProjectedValue> {
  const { args, isBareString } = normaliseToolArguments(rawArguments);

  if (isBareString) {
    // A bare string is a COMMAND only for `run_command`. For every other tool
    // it is an opaque value with no key of its own — labelling it
    // `{"command":"src/a.ts"}` would tell the summariser that a command ran
    // when a file was read, and the dedicated `read_file` projection would
    // drop it entirely.
    if (toolName === 'run_command') {
      return { command: capArgumentValue(rawArguments, redactSecrets) };
    }
    return { [RAW_ARGUMENT_KEY]: capArgumentValue(rawArguments, redactSecrets) };
  }

  switch (toolName) {
    case 'run_command': {
      const command = args['command'];
      return command === undefined ? {} : { command: capArgumentValue(command, redactSecrets) };
    }
    case 'read_file': {
      const projection: Record<string, ProjectedValue> = {};
      const path = args['path'];
      if (path !== undefined) {
        projection['path'] = capArgumentValue(path, redactSecrets);
      }
      const startLine = args['start_line'];
      if (typeof startLine === 'number') {
        projection['start_line'] = startLine;
      } else if (typeof startLine === 'string') {
        projection['start_line'] = capArgumentValue(startLine, redactSecrets);
      }
      const endLine = args['end_line'];
      if (typeof endLine === 'number') {
        projection['end_line'] = endLine;
      } else if (typeof endLine === 'string') {
        projection['end_line'] = capArgumentValue(endLine, redactSecrets);
      }
      return projection;
    }
    case 'write_file': {
      const projection: Record<string, ProjectedValue> = {};
      const path = args['path'];
      if (path !== undefined) {
        projection['path'] = capArgumentValue(path, redactSecrets);
      }
      // The body is never carried — only its size, so the summariser knows a
      // large edit happened without paying for the file content.
      const content = args['content'];
      if (typeof content === 'string') {
        projection['content_length'] = content.length;
      }
      return projection;
    }
    case 'patch_file': {
      // Only the path: the patch bodies are the file content itself.
      const path = args['path'];
      return path === undefined ? {} : { path: capArgumentValue(path, redactSecrets) };
    }
    case 'fetch_url': {
      const url = args['url'];
      return url === undefined ? {} : { url: capArgumentValue(url, redactSecrets) };
    }
    case 'web_search': {
      const queries = args['queries'];
      if (queries !== undefined) {
        return { queries: capArgumentValue(queries, redactSecrets) };
      }
      // The web_search tool also accepts a single `prompt`; keeping it means
      // the summariser still learns what was searched for.
      const prompt = args['prompt'];
      return prompt === undefined ? {} : { prompt: capArgumentValue(prompt, redactSecrets) };
    }
    default: {
      const projection: Record<string, ProjectedValue> = {};
      for (const key of GENERIC_PROJECTED_KEYS) {
        const value = args[key];
        if (value === undefined) {
          continue;
        }
        projection[key] = capArgumentValue(value, redactSecrets);
      }
      return projection;
    }
  }
}

/**
 * Renders the projected arguments as compact JSON.
 *
 * The pairs are added one by one, under the cap, so the emitted string is
 * ALWAYS valid JSON: cutting a finished JSON string in the middle would hand
 * the summariser broken JSON (`{"path":"ppp…","url":"uuu…`). The room for the
 * truncation marker is reserved before the first pair is added, so the marker
 * can never push the result over the cap either.
 */
function buildProjectionJson(projection: Record<string, ProjectedValue>): string {
  const keptPairs: string[] = [];
  let dropped = false;

  for (const [key, value] of Object.entries(projection)) {
    const pair = `${JSON.stringify(key)}:${JSON.stringify(value)}`;
    const candidate = keptPairs.length > 0 ? `${keptPairs.join(',')},${pair}` : pair;
    // The marker is reserved for EVERY candidate, so a pair is only kept when
    // the result still fits with the marker added.
    if (`{${candidate}${TRUNCATION_MARKER_SUFFIX}}`.length > SERIALIZED_TOOL_ARGS_MAX_CHARS) {
      dropped = true;
      continue;
    }
    keptPairs.push(pair);
  }

  if (!dropped) {
    return `{${keptPairs.join(',')}}`;
  }
  const marker = `"${TRUNCATED_PROJECTION_KEY}":true`;
  const body = keptPairs.length > 0 ? `${keptPairs.join(',')},${marker}` : marker;
  return `{${body}}`;
}

/**
 * Renders the projected arguments as compact JSON, capped so a single tool
 * call can never dominate the summarisation input.
 */
function serializeToolArguments(
  toolName: string,
  rawArguments: unknown,
  redactSecrets: boolean
): string {
  const projection = projectToolArguments(toolName, rawArguments, redactSecrets);
  return buildProjectionJson(projection);
}

/**
 * The message body, trimmed. Surrounding whitespace is noise for the
 * summariser and would blur the blank-line separator between blocks.
 */
function messageText(message: ChatMessage): string {
  const content: unknown = message.content;
  return typeof content === 'string' ? content.trim() : '';
}

/**
 * Neutralises a forged block boundary.
 *
 * The blocks are joined with a blank line and every block starts with
 * `[LABEL]:`, so a message whose text contains a line that starts with a
 * bracket renders as what looks like a genuine block — a user could make the
 * summariser believe a tool had run. A space after the newline keeps every
 * line of message text from starting with a bracket. The rest of the text is
 * left alone: a stack trace stays a stack trace.
 *
 * The `\r\n[` case is covered by the same rule — the `\n[` inside it is the
 * match — so a Windows line ending cannot smuggle a block past the guard.
 */
function escapeBlockBoundaries(text: string): string {
  return text.replaceAll('\n[', '\n [');
}

/**
 * The marker that says how much of a tool result was left out.
 *
 * It does NOT start with a bracket: the marker must not look like a block
 * label, and it must survive the boundary guard unchanged.
 */
function omissionMarker(omittedChars: number): string {
  return `\n\n${TRUNCATION_MARKER} ${omittedChars} characters omitted ${TRUNCATION_MARKER}\n\n`;
}

/**
 * Caps the text of a tool result, keeping the HEAD and the TAIL.
 *
 * The head is what happened; the tail is what a command ends with — the exit
 * code, the artifact path, the final error. The middle is dropped, with a
 * marker that says how much was left out.
 */
function capToolResult(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }

  let marker = '';
  let head = '';
  let tail = '';
  // The marker states the omitted count, and the omitted count depends on the
  // marker's own length, so the split is computed until both agree. The
  // loop runs a couple of times at most: the digit count of the omitted
  // number is the only thing that can move.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const budget = Math.max(0, maxChars - marker.length);
    const headChars = Math.floor(budget * TOOL_RESULT_HEAD_RATIO);
    const tailChars = budget - headChars;
    head = text.slice(0, headChars);
    tail = tailChars > 0 ? text.slice(text.length - tailChars) : '';
    const omitted = text.length - head.length - tail.length;
    const nextMarker = omissionMarker(omitted);
    if (nextMarker === marker) {
      break;
    }
    marker = nextMarker;
  }
  return `${head}${marker}${tail}`;
}

/**
 * The text of a tool result: redacted (when redaction is on), then capped.
 *
 * WHY redact a RESULT here: only the output of `run_command` was redacted,
 * and only at capture. A `read_file` of a `.env`, a `fetch_url` of a page
 * that carries a key, a `read_pdf` — none of those went through the
 * redactor, and their content went into the summariser input verbatim and
 * then into the durable summary, which is re-sent on every later turn and
 * can be summarised by a different provider.
 */
function toolResultText(
  message: ChatMessage,
  redactSecrets: boolean,
  maxToolResultChars: number
): string {
  const raw = messageText(message);
  if (raw.length === 0) {
    return '';
  }
  // Redact BEFORE the cut: a secret cut in half by the cap would not match
  // the rules and would survive.
  const redacted = redactSecrets ? redact(raw) : raw;
  return capToolResult(redacted, maxToolResultChars);
}

/**
 * The name of the tool a call invoked.
 *
 * The persisted `tool_calls` JSON is not validated row by row, so a malformed
 * row must not abort the compaction: a call without a usable name is
 * `unknown_tool`.
 */
function toolCallName(toolCall: ToolCall): string {
  const name = toolCall.function?.name;
  return typeof name === 'string' && name.length > 0 ? name : UNKNOWN_TOOL_NAME;
}

/**
 * Maps every tool_call id in the history to the name of the tool it invoked.
 *
 * FIRST WINS on purpose: the same tool_call id can be reused by a later turn
 * (local OpenAI-compatible servers number their calls per request), and a
 * last-write-wins map would label the FIRST turn's tool result with the
 * SECOND turn's tool name. The map is only the fallback for a tool result
 * whose owning assistant is not part of the serialised slice — the nearest
 * owner always wins (see {@link resolveToolName}).
 *
 * Callers usually build this from the FULL conversation, because a tool
 * result can outlive the assistant row that issued it — an orphan tool row
 * keeps its content, it just loses its name.
 */
export function buildToolNameMap(messages: ChatMessage[]): Map<string, string> {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    for (const toolCall of message.tool_calls ?? []) {
      const id = toolCall?.id;
      if (typeof id !== 'string' || id.length === 0 || toolNames.has(id)) {
        continue;
      }
      toolNames.set(id, toolCallName(toolCall));
    }
  }
  return toolNames;
}

/**
 * The name of the tool that produced a tool message.
 *
 * The NEAREST owner wins: the tool calls of the most recent assistant row are
 * consulted first, because the same tool_call id is reused by later turns and
 * a global map cannot tell the two apart. The global map is only the
 * fallback for a tool row whose owning assistant is not part of this slice,
 * and a row that neither knows is a true orphan: `unknown_tool`.
 */
function resolveToolName(
  message: ChatMessage,
  toolNames: Map<string, string>,
  recentAssistantToolNames: Map<string, string>
): string {
  const toolCallId = message.tool_call_id;
  if (!toolCallId) {
    return UNKNOWN_TOOL_NAME;
  }
  const recent = recentAssistantToolNames.get(toolCallId);
  if (recent && recent.length > 0) {
    return recent;
  }
  const fallback = toolNames.get(toolCallId);
  return fallback && fallback.length > 0 ? fallback : UNKNOWN_TOOL_NAME;
}

/**
 * Splits a history into labelled blocks, one per meaningful part of each
 * message. A tool call becomes its own block so the summariser sees the
 * action next to the tool output that answers it.
 *
 * The `thinking` field is never included: it is the model's scratch work, the
 * recent window keeps it, the summarised slice must not.
 */
export function serializeHistoryForSummary(
  messages: ChatMessage[],
  options?: SerializeHistoryOptions
): SerializedBlock[] {
  const resolvedToolNames = options?.toolNames ?? buildToolNameMap(messages);
  const redactSecrets = options?.redactSecrets ?? true;
  const maxToolResultChars = options?.maxToolResultChars ?? SERIALIZED_TOOL_RESULT_MAX_CHARS;
  const blocks: SerializedBlock[] = [];

  // The tool calls of the most recent assistant row. A tool result that
  // follows it belongs to THAT turn, even when a later turn reuses the same
  // tool_call id.
  let recentAssistantToolNames = new Map<string, string>();

  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        const text = messageText(message);
        if (text.length > 0) {
          blocks.push({ label: 'USER', text: escapeBlockBoundaries(text) });
        }
        break;
      }
      case 'assistant': {
        const text = messageText(message);
        if (text.length > 0) {
          blocks.push({ label: 'ASSISTANT', text: escapeBlockBoundaries(text) });
        }
        const toolNamesOfRow = new Map<string, string>();
        for (const toolCall of message.tool_calls ?? []) {
          const toolName = toolCallName(toolCall);
          const id = toolCall?.id;
          if (typeof id === 'string' && id.length > 0) {
            toolNamesOfRow.set(id, toolName);
          }
          blocks.push({
            label: `ASSISTANT -> ${toolName}`,
            text: serializeToolArguments(toolName, toolCall.function?.arguments, redactSecrets),
          });
        }
        recentAssistantToolNames = toolNamesOfRow;
        break;
      }
      case 'tool': {
        const text = toolResultText(message, redactSecrets, maxToolResultChars);
        if (text.length === 0) {
          break;
        }
        blocks.push({
          label: `TOOL ${resolveToolName(message, resolvedToolNames, recentAssistantToolNames)}`,
          text: escapeBlockBoundaries(text),
        });
        break;
      }
      case 'system': {
        // System rows are filtered out by the compaction pipeline before this
        // point — they are never part of the summarised slice.
        break;
      }
    }
  }

  return blocks;
}

/**
 * The blocks joined with a blank line — the exact text handed to the
 * summariser.
 */
export function serializeHistoryForSummaryText(
  messages: ChatMessage[],
  options?: SerializeHistoryOptions
): string {
  return serializeHistoryForSummary(messages, options)
    .map((block) => `[${block.label}]: ${block.text}`)
    .join('\n\n');
}
