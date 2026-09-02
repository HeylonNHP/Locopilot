/**
 * POST /api/chat/switch-model – Hot-swap the model of an in-flight turn.
 *
 * Body: { sessionId: number, model?, providerId?, compactionModel?, compactionProviderId? }
 *
 * The chat SSE stream for that session picks the switch up at the top of its
 * next tool-call loop iteration and confirms it with a `status` event whose
 * phase is `model_switched`. A 404 means no turn is streaming for that
 * session, in which case the client's normal config update already covers
 * the next turn.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { type ModelSwitchRequest, requestModelSwitch } from '@/app/lib/modelSwitchRegistry';

export const dynamic = 'force-dynamic';

interface SwitchModelBody {
  sessionId?: unknown;
  model?: unknown;
  providerId?: unknown;
  compactionModel?: unknown;
  compactionProviderId?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: SwitchModelBody;
  try {
    body = (await req.json()) as SwitchModelBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const sessionId = body.sessionId;
  if (typeof sessionId !== 'number' || !Number.isInteger(sessionId)) {
    return NextResponse.json({ error: 'sessionId (integer) is required' }, { status: 400 });
  }

  const request: ModelSwitchRequest = {};
  const model = nonEmptyString(body.model);
  if (model) request.model = model;
  const providerId = nonEmptyString(body.providerId);
  if (providerId) request.providerId = providerId;
  // An empty compactionModel is meaningful ("same as main"), so only a
  // non-string is treated as "not switching the compaction model".
  if (typeof body.compactionModel === 'string') {
    request.compactionModel = body.compactionModel.trim();
  }
  const compactionProviderId = nonEmptyString(body.compactionProviderId);
  if (compactionProviderId) request.compactionProviderId = compactionProviderId;

  if (request.model === undefined && request.compactionModel === undefined) {
    return NextResponse.json(
      { error: 'At least one of "model" or "compactionModel" is required' },
      { status: 400 }
    );
  }

  if (!requestModelSwitch(sessionId, request)) {
    return NextResponse.json({ error: 'No streaming turn for that session' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
