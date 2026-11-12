/**
 * The recent-files budget, charged as three separate parts.
 *
 * `computeRecentFilesBudget` used to be an exported function of
 * `src/services/compact/recentFiles.ts` that production never called: the
 * pipeline charges the finished result through `computeBudgetForResult`. The
 * tests keep their three-part vocabulary (the summary header, the preserved
 * window, the system prompt), so the wrapper lives here, with the same
 * semantics: a part that is not a finite number is charged as 0.
 */

import { computeBudgetForResult } from '../../src/services/compact/recentFiles.ts';

const charge = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * @param {object} params
 * @param {number} params.numCtx
 * @param {number} params.acceptanceBudget
 * @param {number} params.oldTokenCount
 * @param {number} params.headerTokens - the summary message the result carries.
 * @param {number} params.windowTokens - the preserved window the result carries.
 * @param {number} params.systemPromptTokens
 * @returns {number} the tokens the stub's text may occupy (0 when too small to buy anything).
 */
export function computeRecentFilesBudget(params) {
  return computeBudgetForResult({
    numCtx: params.numCtx,
    acceptanceBudget: params.acceptanceBudget,
    oldTokenCount: params.oldTokenCount,
    resultTokens:
      charge(params.headerTokens) + charge(params.windowTokens) + charge(params.systemPromptTokens),
  });
}
