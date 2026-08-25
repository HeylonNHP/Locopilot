/**
 * chatSession.ts - System prompt construction for the chat session
 *
 * This module previously contained CLI orchestration logic (session state,
 * token tracking, auto-compaction, AI turn processing). That orchestration now
 * lives server-side in the API routes. The only remaining export is
 * `createSystemPrompt`, used by the web UI's chat API route.
 */

import { getToolSystemPrompt } from '@/tools/tools';

import {
  buildAlwaysApplyPrompt,
  buildAvailableSkillsSummary,
  getCachedSkills,
  getEnabledSkills,
  invalidateSkillCache,
  loadSkillState,
} from './skillManager';

/**
 * Creates the system prompt for the chat session
 *
 * `citeSources` (default true) injects a global directive requiring the model
 * to cite web-research sources as numbered links with a trailing Sources list.
 * The numbered SOURCES block is always present in web_search/fetch_url tool
 * results; this directive is the behavioural instruction to actually cite them.
 */
export function createSystemPrompt(
  visionSupported?: boolean,
  yoloMode: boolean = false,
  citeSources: boolean = true
): string {
  const now = new Date();
  const dateTimeStr = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });

  // Refresh skill cache at conversation boundaries (start / compaction)
  invalidateSkillCache();

  // Load skills from the unified cache so system prompt and load_skill agree
  const allSkills = getCachedSkills();
  const state = loadSkillState();
  const enabledSkills = getEnabledSkills(allSkills, state);
  const alwaysApplySection = buildAlwaysApplyPrompt(enabledSkills);
  const availableSkillsSection = buildAvailableSkillsSummary(enabledSkills);

  return (
    `You are Locopilot, a helpful AI assistant running inside a web application.\n` +
    `Current date and time: ${dateTimeStr}\n` +
    `${alwaysApplySection}` +
    `${citeSources ? buildCitationDirective() : ''}` +
    `\n${getToolSystemPrompt(yoloMode, visionSupported)}${availableSkillsSection}` +
    `\nYou may call \`load_skill\` to load the full instructions for any available skill listed above.\n` +
    `Skill creation: You can create new skills for the user by calling create_skill(name, description, body, ...). This writes a SKILL.md file to .locopilot/skills/<name>/ that becomes immediately available. Use this proactively when the user describes a reusable convention or workflow they'd like to preserve. You can also update existing skills by calling create_skill with the same name.\n`
  );
}

/**
 * The global citation directive appended to the system prompt when the
 * user's "Cite Web Sources" setting is on. Mirrors the "belt and suspenders"
 * pattern used by Claude Code: a standing instruction paired with a per-result
 * reminder (see `appendCitationReminder` in toolRegistry.ts). Numbered format
 * matches the SOURCES block appended to every web_search/fetch_url result.
 */
function buildCitationDirective(): string {
  return (
    '\n' +
    'CITATIONS — after web research:\n' +
    'After using web_search or fetch_url to answer, you MUST cite your sources.\n' +
    '- Place a numbered link ([1], [2], ...) immediately after each claim taken from the web.\n' +
    '- End your answer with a "Sources:" section listing every source you used, one per line, as:\n' +
    '  [n] Source Name — full URL\n' +
    '- Use ONLY the real URLs that appeared in the tool results\' SOURCES block. Never invent,\n' +
    '  guess, or fabricate URLs, and never use result_N placeholders.\n' +
    '- If a claim did not come from a retrieved source, do not attach a citation to it.\n\n'
  );
}
