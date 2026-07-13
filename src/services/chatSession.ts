/**
 * chatSession.ts - System prompt construction for the chat session
 *
 * This module previously contained CLI orchestration logic (session state,
 * token tracking, auto-compaction, AI turn processing). That orchestration now
 * lives server-side in the API routes. The only remaining export is
 * `createSystemPrompt`, used by the web UI's chat API route.
 */

import { getToolSystemPrompt } from '../tools/tools';
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
 */
export function createSystemPrompt(visionSupported?: boolean, yoloMode: boolean = false): string {
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
    `\n${getToolSystemPrompt(yoloMode, visionSupported)}${availableSkillsSection}` +
    `\nYou may call \`load_skill\` to load the full instructions for any available skill listed above.\n` +
    `Skill creation: You can create new skills for the user by calling create_skill(name, description, body, ...). This writes a SKILL.md file to .locopilot/skills/<name>/ that becomes immediately available. Use this proactively when the user describes a reusable convention or workflow they'd like to preserve. You can also update existing skills by calling create_skill with the same name.\n`
  );
}
