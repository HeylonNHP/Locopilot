// GET /api/diagnostics/numctx?model=<name>&requested=<number>
//
// Read-only diagnostic: the window the server resolves for a model, through the
// same resolver the chat route and `GET /api/numctx` use. Intended for the
// multi-tab smoke test (`scripts/verify-numctx.mjs`) and for manual debugging
// from the browser dev-tools console.
//
// `requested` stands in for the user's setting, so a smoke test can ask what a
// 1,000,000 setting would resolve to. When it is omitted the saved setting
// (the provider's own numCtx, else the global one) applies.
//
// The response is:
//
//   {
//     "model": "qwen3:6.35b",
//     "requested": 200000,       // the setting that was resolved
//     "effective": 32768,        // min(requested, modelMax), or requested when unknown
//     "modelMax": 32768,         // null when the model's maximum is not known
//     "modelCap": 32768,         // the same value; the name the smoke test reads
//     "known": true,
//     "source": "static" | "llamacpp-loaded" | "openai-models" | "learned" | "unknown",
//     "probeError": null
//   }
//
// The endpoint is intentionally unauthenticated: it returns no sensitive data
// (no API keys, no message contents, no session data). It does require a
// configured provider (it loads the same config.json the chat route uses), so
// it shares the project's authentication posture with the rest of the API.
import { type NextRequest, NextResponse } from 'next/server';

import { loadConfig } from '@/services/configManager';
import { resolveNumCtx } from '@/services/contextWindow/resolveNumCtx';
import { parsePositiveInteger } from '@/services/llmContextLimit';
import { resolveProviderRequestContext } from '@/services/providerResolver';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const modelName = url.searchParams.get('model');
    const requestedParam = parsePositiveInteger(url.searchParams.get('requested'));

    if (!modelName) {
      return NextResponse.json({ error: 'Query parameter "model" is required.' }, { status: 400 });
    }

    const config = await loadConfig();
    const resolvedProvider = resolveProviderRequestContext(config, undefined, modelName);
    if (!resolvedProvider) {
      return NextResponse.json(
        { error: 'LLM base URL not configured. Set up config first.' },
        { status: 400 }
      );
    }

    const resolution = await resolveNumCtx({
      ctx: resolvedProvider.ctx,
      model: modelName,
      providerNumCtx: requestedParam ?? resolvedProvider.provider.numCtx,
      configNumCtx: config?.numCtx,
    });

    return NextResponse.json({
      model: modelName,
      requested: resolution.requested,
      effective: resolution.effective,
      modelMax: resolution.modelMax,
      modelCap: resolution.modelMax,
      known: resolution.known,
      source: resolution.source,
      probeError: resolution.probeError,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to resolve numCtx: ${message}` }, { status: 500 });
  }
}
