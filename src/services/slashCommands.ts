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
    description: 'Set the context window size (e.g. /ctx 8192).',
  },
];

/** Slash-prefixed names (for autocomplete). */
export const SLASH_COMMAND_STRINGS: readonly string[] = SLASH_COMMANDS.map((c) => c.command);

/** Un-prefixed names (for dispatch). */
export const SLASH_COMMAND_NAMES: readonly SlashCommandName[] = SLASH_COMMANDS.map((c) => c.name);

const SLASH_COMMAND_NAME_SET: ReadonlySet<string> = new Set<string>(SLASH_COMMAND_NAMES);

/** True when `value` is one of the known un-prefixed command names. */
export function isSlashCommandName(value: string): value is SlashCommandName {
  return SLASH_COMMAND_NAME_SET.has(value);
}

/**
 * How the composer's submit handler should treat a raw input string.
 *
 * - `command`         — the first token is a known command; dispatch it.
 * - `unknown-command` — a bare `/<single-word>` that matches nothing. The UI
 *                       hints at `/help` and MUST leave the text in the
 *                       composer: the user's text is never thrown away.
 * - `message`         — everything else, including lines that merely start
 *                       with a slash because they are filesystem paths.
 */
export type SlashInputRoute =
  | { kind: 'command'; name: SlashCommandName; args: string }
  | { kind: 'unknown-command'; name: string }
  | { kind: 'message' };

/**
 * Classifies raw composer input before it is routed.
 *
 * The old routing rule was `input.startsWith('/')`, which meant any prompt
 * that began with a path — `/home/me/notes.txt`, `/mnt/x/repo — why does this
 * fail` — was swallowed by the slash-command dispatcher, answered with
 * "Unknown command", and then dropped. Only an exact match against the
 * command table is a command now; a path or a sentence is a normal message.
 * A bare single-word `/<foo>` that matches nothing is still reported as a
 * likely typo, but the caller keeps the text so nothing is lost.
 */
export function classifySlashInput(raw: string): SlashInputRoute {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return { kind: 'message' };

  const rest = trimmed.slice(1);
  const separator = rest.search(/\s/);
  const token = (separator === -1 ? rest : rest.slice(0, separator)).toLowerCase();
  const args = separator === -1 ? '' : rest.slice(separator + 1).trim();

  if (isSlashCommandName(token)) return { kind: 'command', name: token, args };

  // A second slash (a path) or any argument text (a sentence) means the user
  // is writing a message that happens to start with a slash, not a command.
  if (args.length > 0 || rest.includes('/')) return { kind: 'message' };

  return { kind: 'unknown-command', name: token };
}

/**
 * Renders the `/help` body from the command table so the help text can never
 * drift from the dispatcher or the autocomplete list.
 */
export function formatSlashCommandHelp(): string {
  const width = SLASH_COMMANDS.reduce((max, c) => Math.max(max, c.command.length), 0);
  return [
    'Available commands:',
    ...SLASH_COMMANDS.map((c) => `${c.command.padEnd(width)} - ${c.description}`),
  ].join('\n');
}
