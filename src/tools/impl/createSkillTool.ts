import type { ToolSchema } from '../../tools/tools';

export const createSkillToolSchema: ToolSchema = {
  name: 'create_skill',
  description:
    'Create or overwrite a skill definition in .locopilot/skills/<name>/SKILL.md. Use this when the user asks you to create a new skill, or when you determine a reusable capability would help. The skill will be available immediately after creation. You can also use this to update an existing skill by providing the same name.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill identifier — use kebab-case, no spaces (e.g., "react-best-practices")',
      },
      description: {
        type: 'string',
        description:
          'Brief description of what this skill does and when to use it (under 250 chars)',
      },
      body: {
        type: 'string',
        description:
          'The full markdown body containing the skill instructions. Write specific, actionable guidance.',
      },
      alwaysApply: {
        type: 'boolean',
        description:
          'If true, this skill is injected into every system prompt automatically. Use sparingly — only for universal conventions.',
      },
      autoInvoke: {
        type: 'boolean',
        description:
          'If true, this skill is listed as available and the model can call load_skill to retrieve it. Default true.',
      },
      globPatterns: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional file glob patterns that activate this skill (e.g., ["*.tsx", "*.jsx"])',
      },
      allowedTools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of tool names this skill is restricted to (e.g., ["read_file", "patch_file"])',
      },
    },
    required: ['name', 'description', 'body'],
  },
};

export function getToolPrompt(): string {
  const s = createSkillToolSchema;
  return (
    `10. ${s.name}(name, description, body, alwaysApply?, autoInvoke?, globPatterns?, allowedTools?)\n` +
    `   ${s.description}\n\n` +
    `   - name: ${s.parameters.properties.name!.description}\n` +
    `   - description: ${s.parameters.properties.description!.description}\n` +
    `   - body: ${s.parameters.properties.body!.description}\n` +
    `   - alwaysApply: ${s.parameters.properties.alwaysApply!.description}\n` +
    `   - autoInvoke: ${s.parameters.properties.autoInvoke!.description}\n` +
    `   - globPatterns: ${s.parameters.properties.globPatterns!.description}\n` +
    `   - allowedTools: ${s.parameters.properties.allowedTools!.description}\n`
  );
}
