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

C-026 (open): the server resolves a compaction provider BY ID and **trusts the
pair**. It never asks the provider whether it serves the model, so
`provider_id='nvidia-openai'` + `model='beam'` is a legal row and produces the
identical 404 — on the **main** path this time.

**The index.** `GET /api/models` already fetches every provider's live model
list (`fetchLlmModels`) and returns each model with its real `providerId`. The
server therefore has the answer already — it just throws it away. The index
is a process-wide cache of those lists, populated as a side effect of the
models route, and read SYNCHRONOUSLY (a cache peek, no network on the chat
path). A background refresh is kicked off when the cache is cold, so the
first turn never waits.

**The check.** `providerServesModel(index, providerId, model)`:

- the provider has a list and the list contains the model → **true**;
- the provider has a list and the model is absent → **false** (refuse);
- the provider has NO list (never fetched, or the fetch failed) → **unknown**,
  and an unknown never refuses.

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
  tests/provider-persistence tests/config-load tests/numctx-resolver` — green.
- `npm run type-check` — only the pre-existing errors (the mermaid renderer's
  `minNodeWidth` and the seven MCP OAuth `issuer` errors).
- The full `npm test` — the same 22 pre-existing failing suites as before
  this branch.
