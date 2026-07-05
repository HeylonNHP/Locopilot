// GET /api/diagnostics/numctx?model=<name>&requested=<number>
//
// Returns the resolved effective numCtx for a given (baseUrl, model)
// pair, using the same resolver the chat route uses. This is a
// read-only diagnostic endpoint intended for:
//   - the multi-tab smoke-test script (verifies the cap-resolver
//     contract end-to-end against a real Ollama);
//   - manual debugging from the browser dev-tools console;
//   - future client-side bootstrap if a tab needs to know the cap
//     before the first chat turn.
//
// The response shape mirrors the resolver's return value:
//
//   {
//     "model": "qwen3:6.35b",
//     "requested": 200000,
//     "effective": 32768,
//     "modelCap": 32768,
//     "source": "runtime-ps" | "static-show" | "cache" | "unknown"
//   }
//
// The endpoint is intentionally unauthenticated: it returns no
// sensitive data (no API keys, no message contents, no session data).
// It does require a configured baseUrl (loads the same config.json the
// chat route uses) so it implicitly shares the project's
// authentication posture with the rest of the API.
import { type NextRequest, NextResponse } from 'next/server';

import { DEFAULT_NUM_CTX } from '../../../../constants';
import { resolveEffectiveNumCtx } from '../../../../services/capResolver';
import { loadConfig } from '../../../../services/configManager';
import { configureLlmAdapterAndAuth } from '../../../../services/llm';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const modelName = url.searchParams.get('model');
    const requestedParam = url.searchParams.get('requested');

    if (!modelName) {
      return NextResponse.json(
        { error: 'Query parameter "model" is required.' },
        { status: 400 }
      );
    }

    let requested = DEFAULT_NUM_CTX;
    if (requestedParam !== null) {
      const parsed = Number.parseInt(requestedParam, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        requested = parsed;
      }
    }

    const config = await loadConfig();
    if (!config?.baseUrl) {
      return NextResponse.json(
        { error: 'LLM base URL not configured. Set up config first.' },
        { status: 400 }
      );
    }

    configureLlmAdapterAndAuth(config.provider, config.apiKey);

    const resolved = await resolveEffectiveNumCtx(config.baseUrl, modelName, requested);

    return NextResponse.json({
      model: modelName,
      requested: resolved.requested,
      effective: resolved.effective,
      modelCap: resolved.modelCap,
      source: resolved.source,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to resolve numCtx: ${message}` },
      { status: 500 }
    );
  }
}
