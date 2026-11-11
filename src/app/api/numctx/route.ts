// GET /api/numctx?providerId=<id>&model=<name>
//
// The context window the server will use for a model: the user's setting
// (the provider's own numCtx, else the global one), capped by the model's
// maximum when that is known. The page shows this and never computes it.
//
// Both parameters are optional and default to the saved selection
// (`config.activeProviderId` and `config.model`). The page passes them to ask
// about a model it has picked but not yet saved.
//
// It makes no chat request. The model-maximum probe has a 10 s ceiling and its
// result is cached (see `src/services/capResolver.ts`), so a dead provider
// costs one slow answer and then fast ones for 60 s. A probe that fails is
// reported as `known: false` with a `probeError`, never as an HTTP error.
//
// Only a configured provider is ever contacted: the route takes an id and a
// model name, never a URL, and the response holds numbers and a short error
// string, never a key.
import { type NextRequest, NextResponse } from 'next/server';

import type { NumCtxResponse } from '@/types/numCtx';

import { readConfig } from '@/services/configManager';
import { resolveNumCtx } from '@/services/contextWindow/resolveNumCtx';
import { resolveProviderRequestContext } from '@/services/providerResolver';

export const dynamic = 'force-dynamic';

function textParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value || undefined;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const saved = await readConfig();
    if (!saved.ok) {
      return NextResponse.json({ error: saved.message }, { status: 503 });
    }
    const config = saved.config;

    const model = textParam(url, 'model') ?? config.model;
    if (!model) {
      return NextResponse.json({ error: 'No model is selected.' }, { status: 400 });
    }
    const providerId = textParam(url, 'providerId') ?? config.activeProviderId;
    const resolved = resolveProviderRequestContext(config, providerId, model);
    if (!resolved) {
      return NextResponse.json(
        { error: 'No configured provider matches this request.' },
        { status: 400 }
      );
    }

    const resolution = await resolveNumCtx({
      ctx: resolved.ctx,
      model,
      providerNumCtx: resolved.provider.numCtx,
      configNumCtx: config.numCtx,
    });
    const body: NumCtxResponse = { ...resolution, providerId: resolved.provider.id, model };
    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to resolve numCtx: ${message}` }, { status: 500 });
  }
}
