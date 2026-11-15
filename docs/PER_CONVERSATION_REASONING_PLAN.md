# Per-conversation reasoning levels — plan

Status: **done** (2026-11-14). Branch: `dev`. The browser loop was not exercised by hand — see `CONFIRMATIONS.md` C-023.

## The goal

A conversation should reason at the level it was given. Two conversations may
use different main and compaction reasoning efforts, and switching between them
must move the active levels with them. Today both levels are global: the chat
body carries one store-wide value, and the chat route reads the compaction level
straight from `config.json`, so two concurrent turns share it.

## Ground rules

1. **One vocabulary.** The levels join `src/services/sessionSelection.ts`, the
   one place the selection is spelled out for the database, the HTTP payloads and
   the store. No second session-event family and no second resolution rule.
2. **Additive migrations only.** Two nullable columns through
   `addColumnIfMissing`. No backfill, no schema version.
3. **Pins, not the projection, are persisted.** The store keeps the
   conversation's raw pin (`null` = inherit) and the global default separately;
   the effective value is resolved where it is displayed or sent.
4. **Field-preserving writes.** A session `PATCH` carries only the fields the
   control edited; an absent field means "leave unchanged", an explicit `null`
   means "inherit", a value means "pin". The same shape applies to the config
   defaults. This is what keeps one control from erasing another and two tabs
   from clobbering each other.
5. **A failed write is reported.** A selection the server does not know about is
   lost on the next reload.

## Decisions

| Question                                                             | Decision                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do existing conversations (NULL columns) inherit the global default? | **Yes, until the user picks a level.** NULL means inherit; the display resolves it live, and it is never written by a projection.                                                                                                                                                                    |
| Does a reasoning pick change the global default?                     | **Yes**, matching the model pickers: the default is what a new conversation starts with.                                                                                                                                                                                                             |
| Does a NEW conversation inherit or pin at creation?                  | **Pin at creation.** The server resolves `body → config → 'off'` and stores the result, so a later default change does not move a conversation that already exists.                                                                                                                                  |
| What does the Settings modal's Reasoning Effort dropdown edit?       | **The global default for new conversations only.** It is labelled accordingly; the StatusBar popover is the per-conversation control.                                                                                                                                                                |
| Does a mid-turn model switch re-resolve the levels?                  | **No.** A turn resolves both levels once, at turn start. A reasoning edit applies to the next turn; switching the model mid-turn keeps the turn's levels. Live reasoning changes would need the full side-channel machinery (`modelSwitchRegistry`, its route, pending/ack UI) and are out of scope. |

## Storage and vocabulary

`sessions` gains `reasoning_effort TEXT NULL` and
`compaction_reasoning_effort TEXT NULL`. `SessionSelection` and
`SessionSelectionColumns` gain the two fields (`ReasoningEffort | null`).
`SessionDefaults` gains them as non-null values.

Two write shapes:

- `SessionSelection` — the complete row, used by `POST /api/sessions` (creation)
  and by `updateSessionSelection` after a merge.
- `SessionSelectionPatch` — every field optional; absent means unchanged.

Validation is shared: `validateSessionSelection` for creation,
`validateSessionSelectionPatch` for the `PATCH`, which also rejects a payload
with no recognised field.

## The store

`ChatState` keeps:

- `reasoningEffort` / `compactionReasoningEffort` — the conversation on screen's
  **pin** (`ReasoningEffort | null`).
- `defaultReasoningEffort` / `defaultCompactionReasoningEffort` — the global
  defaults a new conversation starts with.

The display and the request body resolve `pin ?? default`. Nothing resolves the
pin into the mirror, so a legacy NULL row keeps inheriting until it is picked.
`selectionForSession` returns the raw row; the new-chat view returns `null` pins
(inherit until the server pins them at creation). `SET_SESSIONS` may keep copying
`mirrorSelection` into the active row, because the mirror now holds raw pins.

The request body sends the pin (omitted when NULL), so the server's own
`body → config` resolution decides for an inheriting conversation. The client
does not repeat that rule.

## The server

- **Creation** (`POST /api/sessions`, the chat route's lazy `createSession`):
  resolve each level `body → config → 'off'` and store it. The
  `session_created` frame carries the stored values.
- **Existing session / turn**: resolve `body → config → 'off'` once at turn
  start. The resolved values feed the main `params`, auto-compaction, and both
  fields of `requestContext.subAgent` (its own level and its compaction level).
- **`/compact` and `/title`**: same `body → config` fallback. `/title` runs the
  compaction model, so it uses the compaction level; it validates with
  `isReasoningEffort` instead of a hand-written list that silently dropped
  `none`, `minimal`, `xhigh` and `max`.
- `forwardableReasoningEffort` still normalises `'off'` away at the adapter
  boundary; creation stores the literal `'off'`.

## The write path

`src/app/lib/sessionSelectionClient.ts` exposes two writers:

- `saveSessionPatch(sessionId, patch)` — `PATCH /api/sessions/[id]`.
- `saveDefaultsPatch(defaults)` — `PUT /api/config` with only the changed keys
  (the route already merges).
- `saveSelectionChanges(sessionId, patch, defaults)` — the two writes in the
  order they must happen (the row first), as one result.

All three check `response.ok` and return a boolean; the callers report a
failure instead of dispatching a selection the server does not have. When the
row write succeeds and the defaults write does not, the callers mirror the
saved row (`APPLY_SESSION_SELECTION`) and report only the default as unsaved.

The `PATCH` route validates the patch, merges it onto the current row inside the
existing per-session queue, writes the complete row, announces the complete
selection, and returns it.

## Consumers and the drive-by fixes

- `useStableRefs` updates the reasoning refs **synchronously during render**,
  like the model refs, so a send immediately after switching conversations
  cannot carry the previous conversation's level.
- The chat body finally carries `compactionReasoningEffort`; the server no
  longer reads it only from disk.
- `/title` uses the compaction level (it runs the compaction model) and the
  shared validator; so does the background title the chat route generates.
- `saveSessionDefaults`'s swallowed failure is gone (it is replaced by the
  writers above).
- No change is needed in `subAgentTool.ts`: the route now hands it the resolved
  values.
- A stale session list does not unpin a conversation: the list's own level wins
  over the mirror's null, because a null pin can also mean "this
  conversation's row has not been loaded yet".

## Tests

1. A legacy NULL row follows the default, and a `SET_SESSIONS` projection or a
   model-only patch does not pin it; a list that carries a level does not
   unpin it either.
2. A patch touches only its own field in both orders, and the announced event
   carries the complete merged row.
3. Switching A → B and sending before effects run uses B's levels in the main
   call, auto-compaction and sub-agent compaction; the created row and the
   `session_created` frame carry B's values.
4. A Settings save touches the global default only, never an open conversation's
   pin.

## Out of scope

- Live reasoning changes to a turn that is already streaming.
- A separate sub-agent reasoning selection (it still follows the conversation).

## What is not verified

The browser loop (the popover, the conversation switch, the status bar) is not
exercised by hand. See `CONFIRMATIONS.md` C-023.
