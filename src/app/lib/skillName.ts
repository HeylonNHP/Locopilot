/**
 * Skill-name rules, shared by the client and the server.
 *
 * This module is deliberately import-free so it can be pulled into both the
 * browser bundle (SkillsTab) and the Node-side tool registry without dragging
 * `node:fs` across the boundary. Before it existed, the tool silently
 * normalised "My Skill" to "my-skill" while the UI tracked the name as typed,
 * so its "Creating skill…" progress indicator could never match the refreshed
 * list and stayed on screen forever.
 */

export const SKILL_NAME_MAX_LENGTH = 64;

/**
 * Canonical skill name: trimmed, lower-cased, whitespace collapsed to dashes.
 * Keep this as the single implementation — the tool writes folders and
 * frontmatter from this value, and the UI must predict the result exactly.
 */
export function normalizeSkillName(raw: string): string {
  return raw.trim().toLowerCase().replaceAll(/\s+/g, '-');
}

/** Returns a human-readable error, or `null` when the name is usable. */
export function validateSkillName(raw: string): string | null {
  const name = normalizeSkillName(raw);
  if (name.length === 0) return 'Name is required';
  if (name.length > SKILL_NAME_MAX_LENGTH) {
    return `Name must be ${SKILL_NAME_MAX_LENGTH} characters or fewer`;
  }
  if (/^[.-]/.test(name)) return 'Name cannot start with . or -';
  if (/[/\\]/.test(name) || name.includes('..')) {
    return 'Name cannot contain path separators or ..';
  }
  if (name.includes(String.fromCodePoint(0x0000))) return 'Name contains invalid characters';
  return null;
}
