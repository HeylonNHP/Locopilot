// GET /api/config - read current config
// PUT /api/config - update config
import { NextRequest, NextResponse } from 'next/server';
import { access, readFile, writeFile } from 'fs/promises';
import path from 'path';
import type { Config } from '../../../slashCommands';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

async function loadConfig(): Promise<Config | null> {
    try {
        await access(CONFIG_PATH);
        const data = await readFile(CONFIG_PATH, 'utf8');
        return JSON.parse(data) as Config;
    } catch {
        return null;
    }
}

async function saveConfig(config: Config): Promise<void> {
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export async function GET(): Promise<NextResponse> {
    try {
        const config = await loadConfig();
        if (!config) {
            return NextResponse.json({ config: {} });
        }
        return NextResponse.json({ config });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
            { error: `Failed to load config: ${message}` },
            { status: 500 },
        );
    }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
    try {
        const body = (await request.json()) as Partial<Config>;
        const currentConfig = await loadConfig();
        const base: Config = {
            baseUrl: '',
            lastModel: '',
            compactionModel: '',
            numCtx: 131072,
            chatTimeoutMs: 720_000,
            yolo: false,
            thinkingEnabled: true,
            webSearch: {
                maxQueries: 3,
                resultsPerQuery: 3,
                perPageCharLimit: 5000,
            },
            ...(currentConfig ?? {}),
        };

        // Merge webSearch if provided
        const updatedWebSearch = {
            maxQueries: 3,
            resultsPerQuery: 3,
            perPageCharLimit: 5000,
            ...base.webSearch,
            ...body.webSearch,
        };

        const updatedConfig: Config = {
            ...base,
            ...body,
            webSearch: updatedWebSearch,
        };

        await saveConfig(updatedConfig);
        return NextResponse.json({ config: updatedConfig });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
            { error: `Failed to save config: ${message}` },
            { status: 500 },
        );
    }
}
