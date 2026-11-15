/**
 * One-time migration: legacy `subagent_log` rows → traces on the tool message.
 *
 * A trace used to be a row of its own whose only position was its place in the
 * list. It now lives on the `tool` row that answers the `run_subagents` call
 * (`messages.subagent_traces`). This module PLANS the move for one session — it
 * reads rows and returns what to write — and `history.ts` applies it in a
 * transaction. It is pure so that every shape a legacy session can be in is
 * testable without a database.
 *
 * WHAT A LEGACY SESSION LOOKS LIKE. Two layouts exist, and a third that is a
 * bug's leftovers:
 *
 *  1. Logs BEFORE their call: the server saved `[log rows…, assistant(tool_calls),
 *     tool results…]`. Each log belongs to the next `run_subagents` result.
 *  2. Logs AFTER everything: a manual `/compact` rewrote the conversation as
 *     `[compacted messages…, every log row…]`. The logs are in their original
 *     order, but the calls of the summarised part of the conversation no longer
 *     exist.
 *  3. Logs with no call at all (auto-compact deleted the call, or the call was
 *     summarised away).
 *
 * HOW A LOG FINDS ITS CALL. The arguments of every `run_subagents` call name
 * its agents (`agents[].id`), so a log is only ever attached to a call that
 * names its agent — never by position alone.
 *
 *  - Pass 1 (layout 1): the NEAREST FOLLOWING call that names the agent, without
 *    leaving the user turn the log is in.
 *  - Pass 2 (layout 2), for the logs pass 1 left over: walked from the LAST log
 *    backwards, each to the LATEST call BEFORE it that names its agent and has
 *    no trace for it yet (a call always precedes its trace). The surviving
 *    calls are a suffix of the original ones and the logs are in the original
 *    order, so the last log is the last call's — which is exactly the alignment
 *    this gives.
 *  - What still has no call is dropped: its call was summarised away or
 *    deleted, and the summary already covers it.
 */

import type { SubagentTrace } from '@/services/adapters/llmAdapter';

import { canonicalSubagentId } from '@/tools/toolOutput';

/** The columns of a stored message that the planner needs. */
export interface LegacyRow {
  id: number;
  role: string;
  content: string;
  /** `messages.subagent_id` (set on `subagent_log` rows). */
  subagentId: string;
  /** `messages.tool_calls`, the raw JSON of an assistant row. */
  toolCalls: string;
  /** `messages.tool_call_id` (set on `tool` rows). */
  toolCallId: string;
}

export interface SubagentLogMigrationPlan {
  /** Tool row id → the traces to store on it (only rows that gain traces). */
  traces: Map<number, SubagentTrace[]>;
  /** Every `subagent_log` row id: all of them are deleted, attached or not. */
  deleteIds: number[];
  /** Logs that found a call. */
  attached: number;
  /** Logs that found none and are dropped. */
  dropped: number;
}

const RUN_SUBAGENTS = 'run_subagents';

/** One `run_subagents` call: its result row, and the agents its arguments name. */
interface CallSite {
  resultRowIndex: number;
  /** Canonical ids; `null` when the arguments could not be read (then any agent fits). */
  agentIds: Set<string> | null;
}

function parseArguments(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
}

/** The agent ids a `run_subagents` call's arguments name, or null when unreadable. */
function agentIdsOf(args: unknown): Set<string> | null {
  const parsed = parseArguments(args);
  const agents = parsed?.agents;
  if (!Array.isArray(agents)) return null;
  const ids = new Set<string>();
  for (const agent of agents) {
    const id = (agent as { id?: unknown } | null)?.id;
    if (typeof id === 'string') ids.add(canonicalSubagentId(id));
  }
  return ids;
}

/** Every `run_subagents` call in the session, keyed by its call id. */
function collectCalls(rows: LegacyRow[]): Map<string, Set<string> | null> {
  const calls = new Map<string, Set<string> | null>();
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.toolCalls);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const call of parsed) {
      const entry = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      if (typeof entry.id === 'string' && entry.function?.name === RUN_SUBAGENTS) {
        calls.set(entry.id, agentIdsOf(entry.function.arguments));
      }
    }
  }
  return calls;
}

/** Whether a call (that names `names`, or anything when null) fits an agent. */
function fits(names: Set<string> | null, agentId: string): boolean {
  return names === null || names.has(agentId);
}

/**
 * Plan the migration of one session's rows (in storage order).
 *
 * @param rows - every row of the session, ordered by id.
 */
export function planSubagentLogMigration(rows: LegacyRow[]): SubagentLogMigrationPlan {
  const calls = collectCalls(rows);
  const sites: CallSite[] = [];
  rows.forEach((row, index) => {
    if (row.role === 'tool' && calls.has(row.toolCallId)) {
      sites.push({ resultRowIndex: index, agentIds: calls.get(row.toolCallId) ?? null });
    }
  });

  /**
   * Result row index → agent id → the trace and the index of the log it came
   * from. The log's index is the order the agents are shown in, whichever pass
   * attached them.
   */
  const filled = new Map<number, Map<string, { content: string; order: number }>>();
  const attach = (site: CallSite, agentId: string, order: number): void => {
    const agents = filled.get(site.resultRowIndex) ?? new Map();
    agents.set(agentId, { content: rows[order]!.content, order });
    filled.set(site.resultRowIndex, agents);
  };
  const isFree = (site: CallSite, agentId: string): boolean =>
    !filled.get(site.resultRowIndex)?.has(agentId);

  const logIndexes: number[] = [];
  rows.forEach((row, index) => {
    if (row.role === 'subagent_log') logIndexes.push(index);
  });
  const agentOf = (index: number): string => canonicalSubagentId(rows[index]!.subagentId);

  // Pass 1: the nearest following call that names the agent, within the turn.
  const leftover: number[] = [];
  for (const index of logIndexes) {
    const agentId = agentOf(index);
    let turnEnd = rows.length;
    for (let i = index + 1; i < rows.length; i += 1) {
      if (rows[i]!.role === 'user') {
        turnEnd = i;
        break;
      }
    }
    const site = sites.find(
      (candidate) =>
        candidate.resultRowIndex > index &&
        candidate.resultRowIndex < turnEnd &&
        fits(candidate.agentIds, agentId) &&
        isFree(candidate, agentId)
    );
    if (site) {
      attach(site, agentId, index);
    } else {
      leftover.push(index);
    }
  }

  // Pass 2: from the last leftover backwards, each to the latest free call that
  // names its agent.
  let dropped = 0;
  for (const index of leftover.toReversed()) {
    const agentId = agentOf(index);
    const site = sites.findLast(
      (candidate) =>
        candidate.resultRowIndex < index &&
        fits(candidate.agentIds, agentId) &&
        isFree(candidate, agentId)
    );
    if (site) {
      attach(site, agentId, index);
    } else {
      dropped += 1;
    }
  }

  const traces = new Map<number, SubagentTrace[]>();
  for (const [resultRowIndex, agents] of filled) {
    traces.set(
      rows[resultRowIndex]!.id,
      [...agents]
        .toSorted(([, a], [, b]) => a.order - b.order)
        .map(([agentId, { content }]) => ({ agentId, content }))
    );
  }
  return {
    traces,
    deleteIds: logIndexes.map((index) => rows[index]!.id),
    attached: logIndexes.length - dropped,
    dropped,
  };
}
