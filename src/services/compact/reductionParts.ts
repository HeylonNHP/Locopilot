/**
 * reductionParts.ts
 *
 * The pure half of the map-reduce reduction: how partial summaries are labelled,
 * batched, paired and — when the round cap is reached — merged without a model
 * call. No model call, no progress, no state; the only outside input is the
 * tokenizer's count of a part.
 *
 * `reduceSummaryGroups` (reduce.ts) drives these round by round and owns the
 * termination guarantee: the number of parts strictly decreases every round
 * because `batchReductionParts` falls back to pairing.
 */

import { countCalibratedTextTokens } from '@/services/tokenizer';

import { REDUCTION_FAN_IN, SUMMARY_SECTIONS } from './constants';

/** One partial summary on its way into a combine request. */
export interface ReductionPart {
  /** The number the part is labelled with (`[PART n]:`). */
  number: number;
  /** The partial summary itself. */
  text: string;
}

/**
 * The text of one combine request: the labelled parts, joined by a blank
 * line.
 */
export function buildReductionBatchText(parts: ReductionPart[]): string {
  return parts.map((part) => `[PART ${part.number}]:\n${part.text}`).join('\n\n');
}

/**
 * The fixed prefix of the combine request's user message.
 */
export const REDUCTION_REQUEST_USER_PREFIX =
  'Combine the following partial summaries into one coherent summary:\n\n';

/**
 * Builds the batches for ONE reduction round.
 *
 * The batches are bounded by the parts budget (what is left of the safe input
 * budget once the combine prompt is paid for) as well as by the fan-in
 * count. A part that does not fit is sent on its own — nothing is ever
 * DROPPED.
 *
 * WHY the pairing fallback exists: when EVERY part is bigger than half the
 * parts budget, each batch holds exactly ONE part, so the number of parts
 * would not shrink and the recursion would repeat for ever — one model call
 * per part per round, with no termination (measured: 51 → 26 → 26 → 26… at a
 * 2048-token context, and no progress at all at 1024). The count MUST
 * strictly decrease every round, so when the budget-based batching does not
 * shrink it, the parts are merged in PAIRS for that round — the budget is
 * ignored for that round, because a pair of partial summaries is the
 * smallest unit that can shrink. The count then at least halves.
 *
 * Exported so the guarantee can be tested without a model call.
 */
export function batchReductionParts(
  parts: ReductionPart[],
  partsBudget: number,
  model: string
): ReductionPart[][] {
  if (parts.length === 0) {
    return [];
  }
  if (parts.length === 1) {
    return [[parts[0]!]];
  }

  const batches: ReductionPart[][] = [];
  let current: ReductionPart[] = [];
  for (const part of parts) {
    const candidate = [...current, part];
    const candidateTokens = countCalibratedTextTokens(
      buildReductionBatchText(candidate),
      model,
      'summarise'
    );
    const exceedsFanIn = current.length >= REDUCTION_FAN_IN;
    const exceedsBudget = current.length > 0 && candidateTokens > partsBudget;
    if (exceedsFanIn || exceedsBudget) {
      batches.push(current);
      current = [part];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    batches.push(current);
  }

  // The progress guarantee: the round must produce FEWER batches than there
  // were parts, or the recursion would never end.
  if (batches.length >= parts.length) {
    return pairReductionParts(parts);
  }
  return batches;
}

/**
 * Merges the parts in PAIRS — the fallback that guarantees the count at
 * least halves.
 */
function pairReductionParts(parts: ReductionPart[]): ReductionPart[][] {
  const batches: ReductionPart[][] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const first = parts[index];
    if (!first) {
      continue;
    }
    const second = parts[index + 1];
    batches.push(second ? [first, second] : [first]);
  }
  return batches;
}

/**
 * A line that opens a section of a structured summary.
 */
const REDUCTION_SECTION_LINE = /^([A-Z][A-Za-z]*(?: [A-Za-z]+)*):/;

/**
 * The marker that separates two merged pieces in the final concatenation.
 */
const REDUCTION_CONCATENATION_MARKER = ' | ';

/**
 * Splits one partial summary into its leading text and its sections.
 */
function splitReductionPart(text: string): { lead: string; sections: [string, string][] } {
  const leadLines: string[] = [];
  const sections: [string, string][] = [];
  let currentName: string | null = null;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentName === null) {
      return;
    }
    const body = currentLines.join('\n').trim();
    if (body.length > 0) {
      sections.push([currentName, body]);
    }
  };

  for (const line of text.split(/\r?\n/)) {
    const match = REDUCTION_SECTION_LINE.exec(line);
    const label = match?.[1];
    if (label) {
      flush();
      currentName = label;
      currentLines = [line.slice(match[0].length).trim()];
      continue;
    }
    if (currentName === null) {
      leadLines.push(line);
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return { lead: leadLines.join('\n').trim(), sections };
}

/**
 * Merges the remaining partial summaries into ONE text WITHOUT a model call.
 *
 * This is the last resort of the reduction: the parts are merged section by
 * section (so the result keeps the shape of a structured summary) and a short
 * marker separates two pieces that came from different parts. Each piece
 * keeps its OWN section label, so every part's text survives the merge
 * verbatim — nothing is dropped, and every piece can still be read on its
 * own.
 *
 * Exported so the "no part is dropped" property can be tested offline.
 */
export function concatenateReductionParts(parts: ReductionPart[]): string {
  const leads: string[] = [];
  const bySection = new Map<string, string[]>();

  for (const part of parts) {
    const { lead, sections } = splitReductionPart(part.text);
    if (lead.length > 0) {
      leads.push(lead);
    }
    for (const [name, body] of sections) {
      // The piece keeps its own label: the merge must not lose the fact
      // that the text belongs to that section.
      const piece = `${name}: ${body}`;
      const pieces = bySection.get(name);
      if (pieces) {
        pieces.push(piece);
      } else {
        bySection.set(name, [piece]);
      }
    }
  }

  const blocks: string[] = [];
  if (leads.length > 0) {
    blocks.push(leads.join(REDUCTION_CONCATENATION_MARKER));
  }
  for (const section of SUMMARY_SECTIONS) {
    const pieces = bySection.get(section);
    if (!pieces || pieces.length === 0) {
      continue;
    }
    blocks.push(pieces.join(REDUCTION_CONCATENATION_MARKER));
  }
  // A section that is not one of the six (a part that used a different
  // label) must not be dropped either.
  for (const [name, pieces] of bySection) {
    if ((SUMMARY_SECTIONS as readonly string[]).includes(name)) {
      continue;
    }
    blocks.push(pieces.join(REDUCTION_CONCATENATION_MARKER));
  }

  return blocks.join('\n\n');
}
