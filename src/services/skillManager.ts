/**
 * skillManager.ts - Skills system for Locopilot
 *
 * Discovers, loads, and manages self-contained skill directories.
 * Skills are SKILL.md files with YAML frontmatter that can be injected
 * into the LLM system prompt as always-apply instructions or listed as
 * available auto-invoke skills.
 *
 * Directory convention:
 *   .locopilot/skills/<name>/SKILL.md   (project-scoped)
 *   ~/.locopilot/skills/<name>/SKILL.md  (personal/global)
 *
 * Project skills override personal skills with the same name.
 */

import { promises as fsp } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────────

/** A loaded skill from disk */
export interface Skill {
  name: string;
  description: string;
  path: string; // Absolute path to the skill directory
  body: string; // SKILL.md body (after frontmatter)
  alwaysApply: boolean;
  autoInvoke: boolean;
  /** Glob patterns — skill is only active when matching files are in context */
  globPatterns?: string[] | undefined;
  /** Tool names this skill is allowed to use; undefined = no restriction */
  allowedTools?: string[] | undefined;
}

// ── Frontmatter parsing ─────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n([\S\s]*?)\n---\s*\n?/;

interface ParsedFrontmatter {
  body: string;
  name: string;
  description: string;
  alwaysApply: boolean;
  autoInvoke: boolean;
  globPatterns?: string[] | undefined;
  allowedTools?: string[] | undefined;
}

function parseStringArray(raw: string): string[] | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed as string[];
    }
  } catch {
    // Not valid JSON; ignore
  }
  return undefined;
}

function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;

  const fmBlock = match[1]!;
  const body = raw.slice(match[0].length).trim();

  const meta: Record<string, string> = {};
  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value !== undefined) {
      meta[key] = value;
    }
  }

  const name = meta['name'];
  const description = meta['description'];
  if (!name || !description) {
    // Frontmatter must have at least name and description
    return null;
  }

  const alwaysApply = meta['alwaysApply'] === 'true';
  const autoInvoke = meta['autoInvoke'] !== 'false'; // default true

  const globPatterns = meta['globPatterns'] ? parseStringArray(meta['globPatterns']) : undefined;
  const allowedTools = meta['allowedTools'] ? parseStringArray(meta['allowedTools']) : undefined;

  return { body, name, description, alwaysApply, autoInvoke, globPatterns, allowedTools };
}

// ── Discovery ────────────────────────────────────────────────────────────────

function readSkillsFromDir(baseDir: string): Skill[] {
  const skills: Skill[] = [];

  if (!fs.existsSync(baseDir)) return skills;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(baseDir, entry.name);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) continue;

    let raw: string;
    try {
      raw = fs.readFileSync(skillMdPath, 'utf8');
    } catch {
      continue;
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;

    skills.push({
      name: parsed.name,
      description: parsed.description,
      path: skillDir,
      body: parsed.body,
      alwaysApply: parsed.alwaysApply,
      autoInvoke: parsed.autoInvoke,
      globPatterns: parsed.globPatterns,
      allowedTools: parsed.allowedTools,
    });
  }

  return skills;
}

/**
 * Discover all skills from ~/.locopilot/skills/ and .locopilot/skills/.
 * Project skills override personal skills with the same name.
 */
export function discoverSkills(): Skill[] {
  const personalDir = path.join(os.homedir(), '.locopilot', 'skills');
  const projectDir = path.join(process.cwd(), '.locopilot', 'skills');

  const personalSkills = readSkillsFromDir(personalDir);
  const projectSkills = readSkillsFromDir(projectDir);

  // Merge: project skills override personal skills by name
  const merged = new Map<string, Skill>();
  for (const skill of personalSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of projectSkills) {
    merged.set(skill.name, skill);
  }

  return [...merged.values()];
}

// ── State management ─────────────────────────────────────────────────────────

interface SkillStateFile {
  enabled: string[];
  disabled: string[];
}

function getStateFilePath(projectDir?: string): string {
  const base = projectDir ?? process.cwd();
  return path.join(base, '.locopilot', 'skills.json');
}

// ── Write queue to serialise concurrent skill-state mutations ─────────────

let skillStateWriteQueue: Promise<void> = Promise.resolve();

async function saveSkillStateUnqueued(
  state: { enabled: string[]; disabled: string[] },
  projectDir?: string
): Promise<void> {
  const statePath = getStateFilePath(projectDir);
  const dir = path.dirname(statePath);

  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    statePath,
    JSON.stringify({ enabled: state.enabled, disabled: state.disabled }, null, 2),
    'utf8'
  );
}

/**
 * Load enabled skill names from .locopilot/skills.json.
 * If skills.json doesn't exist, returns empty arrays.
 */
export function loadSkillState(projectDir?: string): { enabled: string[]; disabled: string[] } {
  const statePath = getStateFilePath(projectDir);

  if (!fs.existsSync(statePath)) {
    return { enabled: [], disabled: [] };
  }

  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as SkillStateFile;
    return {
      enabled: Array.isArray(parsed.enabled) ? parsed.enabled : [],
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
    };
  } catch {
    return { enabled: [], disabled: [] };
  }
}

/**
 * Save enabled/disabled state to .locopilot/skills.json.
 * Delegates to the write queue so concurrent mutations are serialised.
 */
export async function saveSkillState(
  state: { enabled: string[]; disabled: string[] },
  projectDir?: string
): Promise<void> {
  skillStateWriteQueue = skillStateWriteQueue.then(
    () => saveSkillStateUnqueued(state, projectDir),
    () => saveSkillStateUnqueued(state, projectDir)
  );
  return skillStateWriteQueue;
}

/**
 * Enable a skill (add to enabled, remove from disabled).
 * The read-modify-write runs inside the write queue to prevent TOCTOU races.
 */
export async function enableSkill(name: string, projectDir?: string): Promise<void> {
  skillStateWriteQueue = skillStateWriteQueue.then(
    async () => {
      const state = loadSkillState(projectDir);
      const enabled = new Set(state.enabled);
      const disabled = new Set(state.disabled);

      enabled.add(name);
      disabled.delete(name);

      await saveSkillStateUnqueued(
        { enabled: [...enabled], disabled: [...disabled] },
        projectDir
      );
    },
    async () => {
      const state = loadSkillState(projectDir);
      const enabled = new Set(state.enabled);
      const disabled = new Set(state.disabled);

      enabled.add(name);
      disabled.delete(name);

      await saveSkillStateUnqueued(
        { enabled: [...enabled], disabled: [...disabled] },
        projectDir
      );
    }
  );
  return skillStateWriteQueue;
}

/**
 * Disable a skill (add to disabled, remove from enabled).
 * The read-modify-write runs inside the write queue to prevent TOCTOU races.
 */
export async function disableSkill(name: string, projectDir?: string): Promise<void> {
  skillStateWriteQueue = skillStateWriteQueue.then(
    async () => {
      const state = loadSkillState(projectDir);
      const enabled = new Set(state.enabled);
      const disabled = new Set(state.disabled);

      disabled.add(name);
      enabled.delete(name);

      await saveSkillStateUnqueued(
        { enabled: [...enabled], disabled: [...disabled] },
        projectDir
      );
    },
    async () => {
      const state = loadSkillState(projectDir);
      const enabled = new Set(state.enabled);
      const disabled = new Set(state.disabled);

      disabled.add(name);
      enabled.delete(name);

      await saveSkillStateUnqueued(
        { enabled: [...enabled], disabled: [...disabled] },
        projectDir
      );
    }
  );
  return skillStateWriteQueue;
}

// ── Filtering ────────────────────────────────────────────────────────────────

/**
 * Get the list of enabled skills (filtered by state).
 * A skill is enabled if it appears in the enabled list, or if it's NOT in
 * the disabled list (default-enabled for new skills). Skills explicitly in
 * the disabled list are excluded.
 */
export function getEnabledSkills(
  allSkills: Skill[],
  state: { enabled: string[]; disabled: string[] }
): Skill[] {
  const enabledSet = new Set(state.enabled);
  const disabledSet = new Set(state.disabled);

  return allSkills.filter((skill) => {
    // If explicitly enabled, it's in
    if (enabledSet.has(skill.name)) return true;
    // If explicitly disabled, it's out
    if (disabledSet.has(skill.name)) return false;
    // Default: new skills are enabled unless disabled
    return true;
  });
}

// ── Glob matching ──────────────────────────────────────────────────────────

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports:
 *   - `**` — matches across path segments (including /)
 *   - `*`  — matches within a single path segment (not including /)
 *   - `?`  — matches any single character within a segment
 */
function globToRegex(pattern: string): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** — match across segments
        out += '.*';
        i += 2;
      } else {
        // * — match within a segment
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '.';
      i += 1;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      out += `\\${  ch}`;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return new RegExp(`^${  out  }$`);
}

/**
 * Filters skills whose globPatterns match any of the given file paths.
 * Skills with no globPatterns always match.
 * Simple glob matching: supports * and ** patterns.
 */
export function filterSkillsByGlobs(skills: Skill[], filePaths: string[]): Skill[] {
  if (filePaths.length === 0) {
    // No file paths provided — return skills that don't require glob matching
    return skills.filter((s) => !s.globPatterns || s.globPatterns.length === 0);
  }

  return skills.filter((skill) => {
    if (!skill.globPatterns || skill.globPatterns.length === 0) {
      // No glob patterns — always matches
      return true;
    }

    const regexes = skill.globPatterns.map(globToRegex);
    return filePaths.some((filePath) => {
      // Test just the basename first (most globs like *.tsx target basenames)
      const basename = filePath.split('/').pop() ?? filePath;
      return regexes.some((re) => re.test(filePath) || re.test(basename));
    });
  });
}

// ── Allowed-tools enforcement ────────────────────────────────────────────────

/**
 * Returns the set of tool names that are allowed by all currently loaded
 * always-apply skills. If multiple always-apply skills have allowedTools,
 * the union is used. If no always-apply skills specify allowedTools,
 * returns undefined (no restriction).
 */
export function getAllowedToolsFromSkills(skills: Skill[]): string[] | undefined {
  const alwaysApply = skills.filter(
    (s) => s.alwaysApply && s.allowedTools && s.allowedTools.length > 0
  );
  if (alwaysApply.length === 0) return undefined;

  const union = new Set<string>();
  for (const skill of alwaysApply) {
    for (const tool of skill.allowedTools!) {
      union.add(tool);
    }
  }
  return [...union];
}

// ── Prompt builders ──────────────────────────────────────────────────────────

/**
 * Build the "always-apply" section of the system prompt.
 * Returns empty string if no always-apply skills are enabled.
 * When filePaths is provided, skills are filtered by globPatterns.
 */
export function buildAlwaysApplyPrompt(skills: Skill[], filePaths?: string[]): string {
  let filtered = skills.filter((s) => s.alwaysApply);
  if (filePaths !== undefined) {
    filtered = filterSkillsByGlobs(filtered, filePaths);
  }
  if (filtered.length === 0) return '';

  const bodies = filtered.map((s) => s.body.trim()).filter(Boolean);
  if (bodies.length === 0) return '';

  return `\n## Active Skills\n\n${  bodies.join('\n\n')  }\n`;
}

/**
 * Build the "Available Skills" summary (auto-invoke skills).
 * Model sees: "## Available Skills\n\n- **name**: description\n..."
 * Returns empty string if no auto-invoke skills are enabled.
 * When filePaths is provided, skills are filtered by globPatterns.
 */
export function buildAvailableSkillsSummary(skills: Skill[], filePaths?: string[]): string {
  let filtered = skills.filter((s) => s.autoInvoke);
  if (filePaths !== undefined) {
    filtered = filterSkillsByGlobs(filtered, filePaths);
  }
  if (filtered.length === 0) return '';

  const lines = filtered.map((s) => `- **${s.name}**: ${s.description}`);
  return `\n## Available Skills\n\n${  lines.join('\n')  }\n`;
}

// ── Lookup ───────────────────────────────────────────────────────────────────

// In-memory cache populated at discovery time for fast lookups
let skillCache: Map<string, Skill> | null = null;

function ensureCache(): Map<string, Skill> {
  if (!skillCache) {
    const skills = discoverSkills();
    skillCache = new Map<string, Skill>();
    for (const skill of skills) {
      skillCache.set(skill.name, skill);
    }
  }
  return skillCache;
}

/**
 * Get a specific skill by name (for the load_skill tool).
 * Also respects enable/disable state — only returns enabled skills.
 */
export function getSkillByName(name: string): Skill | undefined {
  const cache = ensureCache();
  const skill = cache.get(name);
  if (!skill) return undefined;

  // Check if the skill is disabled
  const state = loadSkillState();
  const enabled = getEnabledSkills([skill], state);
  if (enabled.length === 0) return undefined;

  return skill;
}

/**
 * Get all currently cached skills (for system-prompt construction).
 * Calls ensureCache() so the cache is populated if not yet initialised.
 */
export function getCachedSkills(): Skill[] {
  return [...ensureCache().values()];
}

/**
 * Invalidate the in-memory skill cache so the next lookup re-discovers.
 * Useful when skills are added/removed at runtime.
 */
export function invalidateSkillCache(): void {
  skillCache = null;
}
