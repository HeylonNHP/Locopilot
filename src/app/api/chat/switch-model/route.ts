/**
 * POST /api/chat/switch-model – Hot-swap the model of an in-flight turn.
 *
 * Body: { sessionId: number, model?, providerId?, compaction? }
 *
 * The chat SSE stream for that session picks the switch up at the top of its
 * next tool-call loop iteration and confirms it with a `status` event whose
 * phase is `model_switched`. A 404 means no turn is streaming for that
 * session, in which case the client's normal config update already covers
 * the next turn.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { type ModelSwitchRequest, requestModelSwitch } from '@/app/lib/modelSwitchRegistry';
import { compactionSelectionFromPayload } from '@/services/sessionSelection';

export const dynamic = 'force-dynamic';

interface SwitchModelBody {
  sessionId?: unknown;
  model?: unknown;
  providerId?: unknown;
  /** The compaction selection — ONE value. */
  compaction?: unknown;
  /** @deprecated the legacy flat compaction model. */
  compactionModel?: unknown;
  /** @deprecated the legacy flat compaction provider. */
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

  // The compaction selection is ONE value: a compaction model and the
  // provider that serves it. A switch that named a model WITHOUT its
  // provider is REFUSED — that is the state that sent a compaction model to
  // an endpoint that did not have it, and a switch is exactly where such a
  // state would be introduced.
  //
  // The LEGACY flat pair is still read (a tab open before the change): an
  // empty model means "the main model, on the main provider", and a model
  // with a provider is an explicit selection.
  const hasCompaction =
    body.compaction !== undefined ||
    body.compactionModel !== undefined ||
    body.compactionProviderId !== undefined;
  if (hasCompaction) {
    const parsed = compactionSelectionFromPayload(
      {
        compaction: body.compaction,
        compactionModel: body.compactionModel,
        compactionProviderId: body.compactionProviderId,
      },
      model ?? ''
    );
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    request.compaction = parsed.selection;
  }

  // A provider-only switch (no model change, no compaction change) is
  // valid: moving the same model name to a different provider must
  // re-derive activeProvider / llmRequestContext / numCtx / vision /
  // sampling so the next LLM call hits the right endpoint with the
  // right credentials. Without this, the chat route's
  // applyPendingModelSwitch would silently drop the request because
  // `pending.model !== undefined` is false and the whole re-derivation
  // block is gated on that.
  if (
    request.model === undefined &&
    request.compaction === undefined &&
    request.providerId === undefined
  ) {
    return NextResponse.json(
      {
        error: 'At least one of "model", "compaction", or "providerId" is required',
      },
      { status: 400 }
    );
  }

  if (!requestModelSwitch(sessionId, request)) {
    return NextResponse.json({ error: 'No streaming turn for that session' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
