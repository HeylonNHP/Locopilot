# Provider pair integrity — plan

Status: **in progress** (2026-11-16). Branch: `feature/provider-pair-integrity`,
based on `feature/global-compaction-provider` at `6de53ed`.

## The goal

A selection is a **(model, provider) pair**, and the pair must be coherent.
A model is never handed to a provider that does not serve it.

This is the second half of the work started by the global-compaction-provider
branch. That branch closed the *global* hole — a global compaction model could
name a model but not the provider that serves it, so `beam` (an Ollama Cloud
model) was sent to NVIDIA and 404'd 221 times in 14 minutes. It also collapsed
the four divergent compaction resolvers onto one rule
(`src/services/compactionRule.ts` + `src/services/compactionSelection.ts`).

What is left is the pair itself.

## The three states, and why the "model without provider" state must die

A conversation's compaction selection is today TWO independent nullable
columns: `sessions.compaction_model` and `sessions.compaction_provider_id`.
That encoding admits FOUR states:

| `compaction_model` | `compaction_provider_id` | meaning |
|---|---|---|
| `NULL` | `NULL` | inherit the global default |
| `''` | `NULL` | same as the conversation's own main model |
| `'x'` | `'p'` | explicit: model `x` on provider `p` |
| `'x'` | `NULL` | **model without provider — the bug class** |

The fourth row is the production failure. It is reachable because nothing
couples the two columns:

- `PATCH /api/sessions/[id]` accepts them independently
  (`validateSessionSelectionPatch`).
- The mid-turn switch accepts them independently
  (`src/app/api/chat/switch-model/route.ts`).
- The SSE push frame accepts them independently
  (`src/app/hooks/useSessionEvents.ts`).
- **The chat route's lazy `createSession` CREATES it**
  (`src/app/api/chat/route.ts:839-840`): `compactionProviderId ?? null` with
  `compactionModel ?? null` — a turn that carries a compaction model but no
  provider writes a row with a model and no provider.

Phase 1 made the *rule* handle the half-pair safely (a session-pinned model
with no provider runs on the global provider only when the global provider
serves that very same model). That is a mitigation, not a fix: the state is
still representable, and the client can still write it.

The fix is to make the state UNREPRESENTABLE: the selection becomes ONE value
with THREE states, and the fourth row cannot be written or read.

### The storage encoding does not change

The two existing columns already encode exactly the three legal states:

- `NULL` / `NULL` → inherit-default
- `''` / `NULL` → same-as-main
- `'x'` / `'p'` → explicit

Only the fourth combination is illegal. So the schema stays as it is (the
repo's rule is additive migrations only, no destructive change) and the
*vocabulary* is what changes: one `CompactionSelection` value, with the pair
never separable.

A one-time bootstrap migration normalises any legacy half-pair row to
`inherit-default`. **There are none in the owner's production database** (478
sessions: 477 inherit-default, 1 same-as-main, 0 explicit, 0 half-pairs) and
none in the dev database (117 sessions, all inherit-default), so the migration
is a no-op in practice — but it makes the guarantee hold on any database.

## The three phases

### Phase 2.1 — the main path resolves a provider the way the compaction path does

**Status: DONE (2026-11-16).** Implemented as described below; see
`CONFIRMATIONS.md` C-027.

`resolveProvider` resolves in this order:

1. the explicit `providerId`, if it matches;
2. **a provider whose default `model` equals `modelName`** — this step is the
   cross-wire;
3. `null` when an explicit id was given but did not resolve;
4. otherwise `providers[0]`.

Step 2 fires BETWEEN the id lookup and the `null` guard, so a stale id
silently becomes "whichever provider lists that model as its default", **with
that provider's apiKey**. The compaction path avoids it by never passing a
model name. The main path always passes one:

| site | today, with a stale id |
|---|---|
| `src/app/api/chat/route.ts:347` (preflight) | cross-wires → the 409 gate PASSES |
| `src/app/api/chat/route.ts:1253` (runtime) | cross-wires → the turn runs on the wrong provider |
| `src/app/api/chat/route.ts:1462` (mid-turn switch) | cross-wires |
| `src/app/api/compact/route.ts:185` | cross-wires |
| `src/app/api/title/route.ts:108` | cross-wires |
| `src/app/api/numctx/route.ts:48` | already refuses (the one loud site) |

**The change:** when an explicit `providerId` is given and does not resolve,
return `null` — do not try the model name. The model-name step stays for the
case where NO id was given (there it is the only way to find a provider).

**The message:** `MODEL_NOT_CHOSEN_MESSAGE` ("No model is set up yet…") is
wrong for a dangling id — the cause is "the provider this conversation used is
no longer in config.json". A separate message names the missing id.

### Phase 2.2 — a cached server-side model → provider index, and the pair is validated

**Status: DONE (2026-11-16).** Implemented as described below; see
`CONFIRMATIONS.md` C-026.

C-026 (was open): the server resolved a compaction provider BY ID and **trusted
the pair**. It never asked the provider whether it serves the model, so
`provider_id='nvidia-openai'` + `model='beam'` was a legal row and produced the
identical 404 — on the **main** path this time.

**The index.** `GET /api/models` already fetches every provider's live model
list (`fetchLlmModels`) and returns each model with its real `providerId`. The
server therefore has the answer already — it just throws it away. The index
is a process-wide cache of those lists, populated as a side effect of the
models route, and read SYNCHRONOUSLY (a cache peek, no network on the chat
path). A background refresh is kicked off when the cache is cold, so the
first turn never waits.

**The check.** `providerServesModel(providerId, baseUrl, model)`:

- the provider has a list and the list contains the model → **served**;
- the provider has a list and the model is absent → **not-served** (refuse);
- the provider has NO list (never fetched, or the fetch failed, or the list is
  empty) → **unknown**, and an unknown never refuses.

Fail-open on unknown is deliberate: a dead or slow provider must not block a
turn, and a provider that serves a model it does not list must not be locked
out. Ollama tag tolerance follows the existing adapter precedent
(`llama3` matches `llama3:latest`).

**The refusal** names the provider that DOES serve the model, so the fix is
one click in Settings rather than a hunt.

### Phase 2.3 — the selection is one value with three states

`CompactionSelection` in `src/services/sessionSelection.ts`:

```ts
export type CompactionSelection =
  | { kind: 'inherit-default' }
  | { kind: 'same-as-main' }
  | { kind: 'explicit'; model: string; providerId: string };
```

It replaces the two independent fields in the vocabulary, the browser's store
(ONE value, so it cannot drift), the wire, and the SSE frames. Every write
goes through one function, so the half-pair cannot be created. The
`resolveCompactionRule` branch "a conversation pinned a model but no provider"
dies with it.

#### What Phase 2.3 actually shipped (2026-11-16)

The union is the RULE's input and the server-boundary vocabulary. The store
and the wire keep their two-field shape — that reshape is the next slice
(Phase 2.4), not this one. The reason is recorded here so the gap is not
mistaken for an oversight:

- **The rule takes the union.** `resolveCompactionRule` reads
  `sessionCompaction: CompactionSelection`. The old
  `sessionCompactionModel` / `sessionCompactionProviderId` pair is gone from
  it, and with it the branch "a conversation pinned a model but no provider" —
  which is DEAD now, because the state it described cannot be represented.
- **The server composer takes the union** (`CompactionSelectionInput.sessionCompaction`),
  and still READS the legacy pair for a tab that was open before the change.
  A legacy pair that names a model WITHOUT its provider is REFUSED loudly
  (`compactionSelectionFromPair`); a legacy pair that names a provider
  WITHOUT a model has its model resolved here (the global default's model,
  or the main model) and becomes explicit.
- **The write path normalises.** `selectionToColumns` runs the pair through
  `coherentCompactionPair` on the way to the row, so the illegal combination
  cannot be stored even if a caller builds one by hand.
- **The read path normalises.** `selectionFromColumns` does the same on the
  way out of the row, and `listSessions` / `searchSessions` normalise the
  rows they hand to the browser — a browser that received a half-pair would
  send it back in its next chat request.
- **The boundaries refuse.** `PATCH /api/sessions/[id]` refuses a patch that
  edits ONE half of the pair (`compactionPairPatchProblem`) and refuses a
  merged result that is incoherent (`compactionPairProblem`);
  `POST /api/sessions` refuses an incoherent pair at creation.
- **The rows themselves are migrated.** A bootstrap step in `history.ts`
  rewrites the two illegal shapes in place (`''` with a provider → the
  provider is dropped; a named model with no provider → the pair becomes
  "inherit the global default"). It is a no-op in practice: the production
  database has 478 sessions and 0 half-pairs, the development one 117 and 0.

**Phase 2.4 (shipped 2026-11-16):** the store, the wire and the SSE frames
carry the union. See "What Phase 2.4 actually shipped" below.

### Phase 2.4 — the store and the wire carry the union

#### What Phase 2.4 actually shipped (2026-11-16)

Phase 2.3 made the union the RULE's input and the server boundary's
vocabulary. Phase 2.4 finishes the job: the browser's store, the request
bodies, the SSE frames and the client's own write paths carry the union too,
so the COMPILER catches every caller that can build a half-pair instead of the
boundary checks catching it at runtime.

- **The vocabulary.** `SessionSelection.compaction` is the union, and
  `SessionSelectionPatch.compaction` is the union. The two flat fields are
  gone from both. `compactionPairProblem` and `compactionPairPatchProblem`
  are gone with them: a half-pair has no spelling, so a check for one was
  vacuous. What is left is `legacyCompactionPairPatchProblem`, which guards
  the OLD wire shape only (a stale tab still sends it).
- **The store.** `ChatState.compaction` is the union;
  `ChatState.compactionModel` / `compactionProviderId` are gone. The
  conversation's own ROW keeps the two columns (`sessions.compaction_model`,
  `sessions.compaction_provider_id`) — the schema is not changed — but the pair
  only ever reaches the row through `compactionSelectionToPair`, and only ever
  leaves it through `compactionSelectionFromLoosePair`.
- **The wire.** The chat body, the `/compact` body, the `/title` body, the
  `POST /api/sessions` body, the `PATCH /api/sessions/[id]` body and the
  `POST /api/chat/switch-model` body all carry `compaction` — the union. The
  LEGACY flat pair is still READ, in exactly one place
  (`compactionSelectionFromPayload`), so a tab that was open before the
  change keeps working.
- **The SSE frames.** `session_created` carries `compaction`; the
  `model-changed` push carries `compaction`. The `status` event's
  `compactionModel` is unchanged: it is the RESOLVED model the turn runs on,
  not a selection.
- **The client's write paths.** The model picker, the Settings modal and the
  reasoning picker all write the union. The picker refuses a named model that
  names no provider (`compactionSelectionForModel` returns nothing), instead
  of storing a selection the server would refuse.
- **One dead module removed.** `src/services/modelManager.ts`
  (`resolveCompactionModel`) existed only to resolve the loose pair; the rule
  does that now, and nothing referenced it.

**The GLOBAL pair keeps its two fields** — deliberately. `config.json` is
hand-edited, its shape is `compactionModel` + `compactionProviderId`, and "a
global model with no provider of its own" has a legitimate meaning (the
model, on the provider the chat runs on). The union would buy the compiler
nothing there, and the client always writes the global pair together. The
residual is recorded as C-029 in `CONFIRMATIONS.md`.

## What is deliberately NOT changed

- **The schema.** The two columns already encode the three states; the
  migration is additive only, per the repo's rule.
- **The global config's shape.** `Config.compactionModel` +
  `Config.compactionProviderId` stay two fields in `config.json` (the file is
  hand-edited); the SERVER is what resolves them, through the same rule.
- **Provider ids.** They stay name slugs. Opaque ids (a Phase 3 idea) need a
  migration of every row that references one, and a rename is rare.
- **The client's repair.** `useDataLoaders` already re-points a dangling
  active provider id using the live model list; that stays.

## Ground rules

1. **One owner per concept.** The pair lives in one type
   (`CompactionSelection`), the rule lives in one function
   (`resolveCompactionRule`), and the index lives in one module
   (`src/services/modelIndex.ts`).
2. **The server decides.** The client sends what the conversation has; the
   server resolves what it means. A second copy of the rule is a bug.
3. **Loud beats silent.** A pair that cannot be honoured is refused with a
   message that names the cause. A silent fallback to a different endpoint is
   the failure this whole effort exists to end.
4. **Additive migrations only.** No destructive schema change, no
   schema-version marker.
5. **The client keeps working.** A stale tab that sends the old wire shape is
   answered with a clear message, not a crash.

## Verification

- `npx eslint src tests --max-warnings 0` — clean.
- `npm test -- tests/compaction-rule tests/session-model-selection
  tests/session-compaction-pair tests/provider-persistence tests/config-load
  tests/numctx-resolver` — green.
- `npm run type-check` — only the pre-existing errors (the mermaid renderer's
  `minNodeWidth` and the seven MCP OAuth `issuer` errors).
- The full `npm test` — the same 22 pre-existing failing suites as before
  this branch. They fail on a clean tree too (Node v22 has no `require(esm)`,
  and Windows holds the SQLite file open), and none of them touches the
  compaction selection.
