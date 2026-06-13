import type { ToolSchema } from '../../tools/tools';

export const loadSkillToolSchema: ToolSchema = {
  name: 'load_skill',
  description:
    "Loads the full instructions for a named skill. Call this when you determine an available skill is relevant to the current task. Returns the skill's complete instruction body.",
  parameters: {
    type: 'object',
    properties: {
      skill_name: {
        type: 'string',
        description:
          'The name of the skill to load (e.g., "react-best-practices"). Look at "Available Skills" in the system prompt for valid names.',
      },
    },
    required: ['skill_name'],
  },
};

export function getToolPrompt(): string {
  const s = loadSkillToolSchema;
  return (
    `9. ${s.name}(skill_name)\n` +
    `   ${s.description}\n\n` +
    `   - skill_name: ${s.parameters.properties.skill_name!.description}\n`
  );
}
