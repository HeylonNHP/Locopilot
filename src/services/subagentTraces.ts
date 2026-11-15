/**
 * The server's copy of what the sub-agents of each `run_subagents` call printed.
 *
 * WHY IT EXISTS. While a batch runs, the page shows each agent's output live
 * (the `subagent_*` SSE events). The page's copy goes away when the turn ends —
 * the end-of-turn reload reads the database — so the server keeps its own copy
 * and persists it ON THE TOOL MESSAGE that answers the call
 * (`ChatMessage.subagentTraces`). Hung on that message, a trace is kept and
 * dropped with it, so it has a position by construction.
 *
 * THE KEY IS (tool call id, agent id), NOT the agent id alone. Agent ids are
 * chosen by the model and are reused ("researcher" in turn 3 and again in turn
 * 9, or in two calls of one assistant message); keyed by the agent id alone they
 * all landed in one bucket. A call's agents live only inside that call.
 *
 * THE TEXT RULES are the client's, exactly. The page builds its bubble with
 * `appendSubagentLineText` (a newline BETWEEN two lines, none before the first)
 * and appends streamed chunks raw. The clear that drops a failed turn's output
 * REPLACES the page's text with this copy, so the two have to hold the same
 * characters in the same order at every point.
 */

import type { SubagentTrace } from '@/services/adapters/llmAdapter';

import { appendSubagentLineText } from '@/tools/toolOutput';

export class SubagentTraceBook {
  /** call id → agent id → text. `Map` keeps first-write order, which is the order shown. */
  private readonly calls = new Map<string, Map<string, string>>();

  /** One logical line of an agent's own output. */
  appendLine(callId: string, agentId: string, line: string): void {
    const agents = this.agentsOf(callId);
    agents.set(agentId, appendSubagentLineText(agents.get(agentId) ?? '', line));
  }

  /** Streamed model text (thinking or content), appended raw. */
  appendChunk(callId: string, agentId: string, text: string): void {
    const agents = this.agentsOf(callId);
    agents.set(agentId, (agents.get(agentId) ?? '') + text);
  }

  /**
   * Drop the last `dropChars` characters of an agent's text: the turn that
   * failed with a transient provider error and is being re-issued streamed
   * exactly that much, and the re-issue streams it again. Earlier turns of the
   * same agent are kept.
   *
   * Returns the text that remains, or `null` when nothing changed (nothing to
   * drop, or the agent has no text) — the caller then sends no event, because a
   * no-op replacement would still rewrite the page's bubble with this copy.
   * An agent whose text is dropped entirely is removed.
   */
  dropTail(callId: string, agentId: string, dropChars: number): string | null {
    const agents = this.calls.get(callId);
    if (!agents) return null;
    const current = agents.get(agentId) ?? '';
    const drop = Math.max(0, Number.isFinite(dropChars) ? dropChars : 0);
    if (drop === 0) return null;
    const remaining = current.slice(0, Math.max(0, current.length - drop));
    if (remaining === current) return null;
    if (remaining) {
      agents.set(agentId, remaining);
    } else {
      agents.delete(agentId);
    }
    return remaining;
  }

  /** The traces of one call, in the order the agents first wrote. The call is forgotten. */
  take(callId: string): SubagentTrace[] {
    const agents = this.calls.get(callId);
    this.calls.delete(callId);
    if (!agents) return [];
    return [...agents].map(([agentId, content]) => ({ agentId, content }));
  }

  private agentsOf(callId: string): Map<string, string> {
    let agents = this.calls.get(callId);
    if (!agents) {
      agents = new Map();
      this.calls.set(callId, agents);
    }
    return agents;
  }
}
