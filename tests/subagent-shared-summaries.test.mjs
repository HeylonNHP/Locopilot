/**
 * Regression checks for the run_subagents shared-summary guidance.
 *
 * These checks are network-free. They verify that the schema and both prompt
 * surfaces consistently recommend sharing for dependent workflows while
 * preserving an explicit opt-out for genuinely independent work.
 */

import { describe, expect, test } from '@jest/globals';

const {
  SHARED_SUMMARIES_GUIDANCE,
  getToolPrompt: getSubAgentPrompt,
  subAgentToolSchema,
} = await import('../src/tools/impl/subAgentTool.ts');
const { getToolSystemPrompt } = await import('../src/tools/tools.ts');

const schemaGuidance = subAgentToolSchema.parameters.properties.share_summaries?.description;
const subAgentPrompt = getSubAgentPrompt();
const toolSystemPrompt = getToolSystemPrompt(true);

describe('run_subagents shared-summary guidance', () => {
  test('schema exposes the shared guidance', () => {
    expect(schemaGuidance).toBe(SHARED_SUMMARIES_GUIDANCE);
  });

  test('schema recommends sharing for dependent workflows', () => {
    expect(schemaGuidance ?? '').toMatch(/dependent workflows/i);
    expect(schemaGuidance ?? '').toMatch(/research.*implementation.*review/i);
    expect(schemaGuidance ?? '').toMatch(/omit share_summaries or set it to true/i);
  });

  test('schema preserves an explicit independent-work opt-out', () => {
    expect(schemaGuidance ?? '').toMatch(/set share_summaries to false/i);
    expect(schemaGuidance ?? '').toMatch(/genuinely independent/i);
    expect(schemaGuidance ?? '').toMatch(/blind reviews/i);
  });

  test('generated sub-agent prompt uses the schema guidance', () => {
    expect(subAgentPrompt).toContain(`- share_summaries: ${SHARED_SUMMARIES_GUIDANCE}`);
  });

  test('global tool policy repeats the default-on recommendation', () => {
    expect(toolSystemPrompt).toContain(`- ${SHARED_SUMMARIES_GUIDANCE}`);
  });
});
