import type { ToolSchema } from '@/tools/tools';

export const createSkillToolSchema: ToolSchema = {
  name: 'create_skill',
  description: String.raw`Create or overwrite a skill definition. By default the skill is written to .locopilot/skills/<name>/SKILL.md under the current working directory. Pass location="user-profile" to write into the user-profile skills directory (~/.locopilot/skills/ on Linux, %USERPROFILE%\.locopilot\skills\ on Windows) instead, so the skill follows the user across projects. Use this when the user asks you to create a new skill, or when you determine a reusable capability would help. The skill will be available immediately after creation. You can also use this to update an existing skill by providing the same name.`,
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
      location: {
        type: 'string',
        enum: ['project', 'user-profile'],
        description: String.raw`Where to write the skill. 'project' (default) writes to .locopilot/skills/ under the current working directory. 'user-profile' writes to the user profile (~/.locopilot/skills/ on Linux, %USERPROFILE%\.locopilot\skills\ on Windows). Use 'user-profile' for skills that should follow the user across projects.`,
      },
    },
    required: ['name', 'description', 'body'],
  },
};

export function getToolPrompt(): string {
  const s = createSkillToolSchema;
  const p = s.parameters.properties;
  return (
    `10. ${s.name}(name, description, body, alwaysApply?, autoInvoke?, globPatterns?, allowedTools?, location?)\n` +
    `   ${s.description}\n\n` +
    `   - name: ${p.name!.description}\n` +
    `   - description: ${p.description!.description}\n` +
    `   - body: ${p.body!.description}\n` +
    `   - alwaysApply: ${p.alwaysApply!.description}\n` +
    `   - autoInvoke: ${p.autoInvoke!.description}\n` +
    `   - globPatterns: ${p.globPatterns!.description}\n` +
    `   - allowedTools: ${p.allowedTools!.description}\n` +
    `   - location: ${p.location!.description}\n`
  );
}
