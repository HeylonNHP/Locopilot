// POST /api/providers - add ONE provider to config.json
//
// Body: { name, provider: 'ollama' | 'openai-compatible', baseUrl, apiKey?, model? }
//
// This is what the Settings dialog's "Add provider" form calls. It appends one
// validated entry to `providers` on the server, instead of the page sending the
// whole list back through `PUT /api/config`: the page never has to hold or
// resend the other providers' keys, and two tabs cannot replace each other's
// list wholesale.
//
// - The id is made from the name and never reused.
// - The base URL is stored the way the adapters expect it (no trailing slash,
//   and no trailing `/v1` for an OpenAI-compatible server).
// - A provider with the same name as an existing one is refused.
// - The response never contains the API key (`hasApiKey` says whether one is
//   stored).
// - A config.json that exists but cannot be read is refused and left alone,
//   as everywhere else (`readConfig`).
import { type NextRequest, NextResponse } from 'next/server';

import { readConfig, saveConfig } from '@/services/configManager';
import { getNormalizedProviders } from '@/services/providerResolver';
import {
  isPlainObject,
  normaliseProviderBaseUrl,
  toPublicProvider,
  uniqueProviderId,
  validateProvider,
} from '@/services/providerValidation';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!isPlainObject(body)) {
    return NextResponse.json({ error: 'The body must be a JSON object.' }, { status: 400 });
  }

  try {
    const saved = await readConfig();
    if (!saved.ok) {
      return NextResponse.json({ error: saved.message }, { status: 503 });
    }
    const config = saved.config;
    const existing = getNormalizedProviders(config);

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    // Only these fields are taken from the body: an id, a window or anything
    // else the caller sends is ignored.
    const validated = validateProvider(
      {
        id: uniqueProviderId(
          name,
          existing.map((p) => p.id)
        ),
        name,
        provider: body.provider,
        baseUrl: normaliseProviderBaseUrl(body.provider, body.baseUrl),
        ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
        ...(body.model === undefined ? {} : { model: body.model }),
      },
      ''
    );
    if (typeof validated === 'string') {
      return NextResponse.json({ error: validated }, { status: 400 });
    }
    if (existing.some((p) => p.name.trim().toLowerCase() === validated.name.toLowerCase())) {
      return NextResponse.json(
        { error: `A provider named "${validated.name}" already exists. Choose another name.` },
        { status: 409 }
      );
    }

    await saveConfig({ ...config, providers: [...existing, validated] });
    return NextResponse.json({ provider: toPublicProvider(validated) }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to add the provider: ${message}` }, { status: 500 });
  }
}
