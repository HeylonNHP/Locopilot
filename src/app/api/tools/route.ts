import { type NextRequest, NextResponse } from 'next/server';

import { loadConfig, saveConfig } from '../../../services/configManager';
import { TOOLS } from '../../../tools/tools';

export interface ToolApiItem {
  name: string;
  description: string;
  disabledMain: boolean;
  disabledSubAgent: boolean;
}

function buildToolList(disabledMain: string[], disabledSubAgent: string[]): ToolApiItem[] {
  return TOOLS.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    disabledMain: disabledMain.includes(tool.function.name),
    disabledSubAgent: disabledSubAgent.includes(tool.function.name),
  }));
}

export async function GET(): Promise<NextResponse> {
  const config = await loadConfig();
  const disabledMain = config?.tools?.disabledMain ?? [];
  const disabledSubAgent = config?.tools?.disabledSubAgent ?? [];
  return NextResponse.json({ tools: buildToolList(disabledMain, disabledSubAgent) });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as { name?: string; target?: string; action?: string };
  const { name, target, action } = body;

  if (
    typeof name !== 'string' ||
    !name ||
    (target !== 'main' && target !== 'subagent') ||
    (action !== 'enable' && action !== 'disable')
  ) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const config = (await loadConfig()) ?? { baseUrl: 'http://localhost:11434' };
  const toolsConfig = {
    disabledMain: [...(config.tools?.disabledMain ?? [])],
    disabledSubAgent: [...(config.tools?.disabledSubAgent ?? [])],
  };
  const key = target === 'main' ? 'disabledMain' : 'disabledSubAgent';

  if (action === 'disable') {
    if (!toolsConfig[key].includes(name)) toolsConfig[key].push(name);
  } else {
    toolsConfig[key] = toolsConfig[key].filter((n) => n !== name);
  }

  await saveConfig({ ...config, tools: toolsConfig });
  return NextResponse.json({
    tools: buildToolList(toolsConfig.disabledMain, toolsConfig.disabledSubAgent),
  });
}
