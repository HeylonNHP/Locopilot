/**
 * Tells the model when a tool call carried an argument the tool does not have.
 *
 * Tools read the arguments they know and ignore the rest, so a misnamed
 * argument (`timeout_ms` for `timeout_seconds`) used to change nothing and say
 * nothing: the call ran with the default and the model never learned why.
 * The note is appended to the tool's own result; it never fails the call.
 */

import type { ToolSchema } from './toolSchema';

/** Names in `args` that the schema does not declare and the tool does not accept. */
export function findUnknownArguments(
  args: object,
  schema: ToolSchema,
  accepted: readonly string[] = []
): string[] {
  const known = new Set([...Object.keys(schema.parameters.properties), ...accepted]);
  return Object.keys(args).filter((key) => !known.has(key));
}

/** The note to append, or an empty string when every argument was known. */
export function formatUnknownArgumentNote(unknown: readonly string[], schema: ToolSchema): string {
  if (unknown.length === 0) {
    return '';
  }
  const valid = Object.keys(schema.parameters.properties).join(', ');
  return `[Note: ignored unknown argument${unknown.length === 1 ? '' : 's'} for ${schema.name}: ${unknown.join(', ')}. Valid arguments: ${valid}.]`;
}

/** Appends the note (if any) on its own line after the tool's result. */
export function withUnknownArgumentNote(
  content: string,
  args: object,
  schema: ToolSchema,
  accepted: readonly string[] = []
): string {
  const note = formatUnknownArgumentNote(findUnknownArguments(args, schema, accepted), schema);
  return note ? `${content}\n${note}` : content;
}
