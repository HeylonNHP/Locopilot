import { stripControlSequences } from './textSanitizer';

export interface ToolOutputSink {
  writeLine(message: string): void;
  writeInline(message: string): void;
  clearInline(): void;
  /**
   * Optional: attribute a completed output line to a sub-agent without
   * embedding a display-only prefix in the line's text. The message should
   * represent one logical line; callers split multiline writes before
   * forwarding them.
   */
  writeAgentLine?(agentId: string, message: string): void;
  /**
   * Optional: called with raw LLM token chunks during a sub-agent turn so
   * callers (e.g. the web SSE route) can stream thinking/content live.
   * The default terminal sink ignores this — it only shows finalised output.
   */
  writeAgentChunk?(agentId: string, type: 'thinking' | 'content', text: string): void;
  /**
   * Optional: report live tokens-per-second during a sub-agent turn so the
   * web UI can show the sub-agent's generation speed in the status bar.
   */
  reportTps?(tps: number | null): void;
  /**
   * Optional: drop the END of a sub-agent's streamed output so a re-issued
   * turn does not duplicate it.
   *
   * WHY THIS EXISTS. A sub-agent's turn that fails with a transient
   * provider error is RE-ISSUED (see the transient-retry branch in
   * src/tools/impl/subAgentTool.ts). The chunks the failed attempt already
   * streamed are already in the agent's bubble and in the text the caller
   * will persist, so without this the re-issued turn appends the SAME text
   * a second time.
   *
   * The drop is a TRUNCATION, not a delete: drop the last `dropChars`
   * characters of this agent's streamed output (the output of a turn that
   * is being re-issued). `dropChars` counts exactly the characters the
   * re-issued turn wrote to the sink, so the text of the agent's EARLIER
   * turns survives — a sub-agent is a MULTI-TURN loop and the re-issued
   * turn streams its own text again, never the earlier turns' text.
   *
   * The sink owns whatever it has already shown for that agent, so the
   * implementation must drop BOTH the live bubble and the persisted text.
   * Like `writeAgentChunk`, this is OPTIONAL: every call site has to guard
   * it, because a sink that does not stream sub-agent output has nothing
   * to clear. A sink that DOES stream chunks but cannot clear them would
   * silently re-duplicate the text, so that case is logged instead of
   * passing unnoticed (see `clearTurnOutput` in
   * src/tools/impl/subAgentTool.ts).
   */
  clearAgentContent?(agentId: string, dropChars: number): void;
}

/**
 * The ONE key a sub-agent's output is filed under.
 *
 * WHY IT EXISTS. The chat route keeps every write for one sub-agent in one
 * bucket, and that bucket becomes the agent's client bubble AND the
 * persisted `subagent_log` row. Two agents whose ids differ only in
 * surrounding whitespace would collapse into ONE bucket — one bubble, one
 * row — and one agent's clear would truncate the OTHER agent's text.
 *
 * So the id is canonicalised ONCE, at the source (the sub-agent tool), and
 * the route derives its bucket key from THIS function: the two spellings can
 * never drift apart. The rule is "strip the control sequences, then trim":
 * a carriage return or an escape sequence in an id would otherwise split
 * one id into two visual ids, and the surrounding whitespace is never
 * meaningful. An id that is empty after that falls back to the shared
 * `__subagent__` bucket.
 */
export function canonicalSubagentId(agentId: string): string {
  return stripControlSequences(agentId).trim() || '__subagent__';
}

/**
 * Append one LOGICAL LINE to a sub-agent's transcript.
 *
 * WHY THE RULE IS SHAPED THIS WAY. The client builds the agent's bubble
 * with exactly this rule (src/app/lib/chatStore.ts, the `SUBAGENT_OUTPUT`
 * case): a newline BETWEEN two entries and none before the first one. The
 * server keeps its own copy of the same text (the bucket the persisted
 * `subagent_log` row is built from), and the clear that drops a failed
 * turn's output REPLACES the client's bubble with the server's copy — so
 * the two copies have to hold the same characters in the same order at
 * every point. When they did not, the replacement rewrote (and visibly
 * reordered) the text that was supposed to survive.
 *
 * The streamed chunks are appended raw by BOTH sides (`writeAgentChunk` on
 * the server, `SUBAGENT_CHUNK` in the store), so only the LINE handling
 * has to agree.
 */
export function appendSubagentLineText(previous: string, line: string): string {
  return previous ? `${previous}\n${line}` : line;
}

export const noopToolOutputSink: ToolOutputSink = {
  writeLine(): void {},
  writeInline(): void {},
  clearInline(): void {},
};
