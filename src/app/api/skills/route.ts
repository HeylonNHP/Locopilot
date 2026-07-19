// GET /api/skills - list all discovered skills and their enable/disable state
// PUT /api/skills - enable or disable a skill

import { type NextRequest, NextResponse } from 'next/server';

import {
  disableSkill,
  discoverSkills,
  enableSkill,
  getEnabledSkills,
  loadSkillState,
  type SkillLocation,
} from '@/services/skillManager';

export interface SkillApiItem {
  name: string;
  description: string;
  alwaysApply: boolean;
  autoInvoke: boolean;
  enabled: boolean;
  globPatterns?: string[] | undefined;
  allowedTools?: string[] | undefined;
  location: SkillLocation;
}

function toApiItem(
  skill: ReturnType<typeof discoverSkills>[number],
  enabledSet: Set<string>
): SkillApiItem {
  return {
    name: skill.name,
    description: skill.description,
    alwaysApply: skill.alwaysApply,
    autoInvoke: skill.autoInvoke,
    enabled: enabledSet.has(skill.name),
    globPatterns: skill.globPatterns,
    allowedTools: skill.allowedTools,
    location: skill.location,
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const allSkills = discoverSkills();
    const state = loadSkillState();
    const enabledSet = new Set(getEnabledSkills(allSkills, state).map((s) => s.name));

    const items: SkillApiItem[] = allSkills.map((skill) => toApiItem(skill, enabledSet));

    return NextResponse.json({ skills: items });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to load skills: ${message}` }, { status: 500 });
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { action?: string; name?: string };
    const action = body.action;
    const name = body.name;

    if (!action || !name) {
      return NextResponse.json(
        { error: 'Missing "action" or "name" in request body' },
        { status: 400 }
      );
    }

    if (action !== 'enable' && action !== 'disable') {
      return NextResponse.json({ error: 'Action must be "enable" or "disable"' }, { status: 400 });
    }

    await (action === 'enable' ? enableSkill(name) : disableSkill(name));

    // Return updated skill list
    const allSkills = discoverSkills();
    const state = loadSkillState();
    const enabledSet = new Set(getEnabledSkills(allSkills, state).map((s) => s.name));

    const items: SkillApiItem[] = allSkills.map((skill) => toApiItem(skill, enabledSet));

    return NextResponse.json({ skills: items, action, name });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to update skill: ${message}` }, { status: 500 });
  }
}
