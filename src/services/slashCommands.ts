/**
 * Canonical list of Locopilot slash commands.
 *
 * Previously the dispatch switch in `useSlashCommands.ts`, the autocomplete
 * list in `ChatInput.tsx`, and the help-text block in `useSlashCommands.ts`
 * each maintained their own hardcoded command set. They are kept in sync
 * here so adding a new command requires a single append.
 */

export type SlashCommandName =
  | 'help'
  | 'clear'
  | 'clear-images'
  | 'new'
  | 'settings'
  | 'sessions'
  | 'delete'
  | 'model'
  | 'compact'
  | 'title'
  | 'dump'
  | 'nudge'
  | 'mcp'
  | 'ctx';

/**
 * Slash commands available to the user. `command` is the slash-prefixed form
 * (e.g. `/compact`) used in autocomplete and help text; `name` is the
 * un-prefixed form used in the dispatch switch.
 */
export interface SlashCommand {
  /** Slash-prefixed form (matches the user's typed input). */
  command: `/${SlashCommandName}`;
  /** Un-prefixed form (matches `case` labels in `useSlashCommands.ts`). */
  name: SlashCommandName;
  /** Short help string surfaced via `/help` and the input's autocomplete. */
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { command: '/help', name: 'help', description: 'Show available commands.' },
  {
    command: '/clear',
    name: 'clear',
    description: 'Clear the active conversation and start fresh.',
  },
  {
    command: '/clear-images',
    name: 'clear-images',
    description: 'Remove all attached images from the active conversation.',
  },
  {
    command: '/new',
    name: 'new',
    description: 'Start a new session.',
  },
  {
    command: '/settings',
    name: 'settings',
    description: 'Open the settings modal.',
  },
  {
    command: '/sessions',
    name: 'sessions',
    description: 'Switch between persistent sessions.',
  },
  {
    command: '/delete',
    name: 'delete',
    description: 'Delete the active session.',
  },
  {
    command: '/model',
    name: 'model',
    description: 'Refresh and switch LLM models mid-conversation.',
  },
  {
    command: '/compact',
    name: 'compact',
    description: 'Force conversation summarisation to recover context.',
  },
  {
    command: '/title',
    name: 'title',
    description: 'Regenerate the session title.',
  },
  {
    command: '/dump',
    name: 'dump',
    description: 'Export the current conversation history to a markdown debug file.',
  },
  {
    command: '/nudge',
    name: 'nudge',
    description: 'Manually inject a tool-use reminder.',
  },
  { command: '/mcp', name: 'mcp', description: 'Manage MCP server connections.' },
  {
    command: '/ctx',
    name: 'ctx',
    description: 'Show current context usage and limits.',
  },
];

/** Slash-prefixed names (for autocomplete). */
export const SLASH_COMMAND_STRINGS: readonly string[] = SLASH_COMMANDS.map((c) => c.command);

/** Un-prefixed names (for dispatch). */
export const SLASH_COMMAND_NAMES: readonly SlashCommandName[] = SLASH_COMMANDS.map((c) => c.name);
