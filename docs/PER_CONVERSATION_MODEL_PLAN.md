# Per-conversation model selection — plan

Status: **done** (2026-11-13). Branch: `feat/per-conversation-model`, based on `dev` at `e68f9ef`.

## The goal

A conversation should run on the model it was given. Two conversations may use
different models, and switching between them must move the active selection with
them: the model picker, the status bar and the next turn all follow the
conversation that is on screen.

## Ground rules

1. **One owner per concept.** The selection has one vocabulary
   (`src/services/sessionSelection.ts`), shared by the database columns, the HTTP
   payloads and the browser's store. A second column holding the same concept,
   or a second copy of the compaction-resolution rule, is the thing this rule
   exists to prevent.
2. **Additive migrations only.** The `sessions` table gains nullable columns
   through the module's existing `addColumnIfMissing` idiom. No backfill, no
   destructive change, no schema-version marker.
3. **The server stays authoritative for the rules it already owns.** The request
   body is the model for a turn, and the server resolves the compaction model
   from the body, the global setting, and the main model. The client sends
   values; it does not re-implement that order.
4. **A failed write is reported.** A selection the server does not know about is
   a selection that is lost on the next reload, so the pickers do not swallow a
   failed save.

## Decisions the owner made

| Question                                                               | Decision                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do existing conversations keep following the global default?           | **No.** `sessions.model` is repurposed as the conversation's model, so an existing conversation resumes with the model it was created with. The alternative — a nullable override column where NULL means "follow the global default" — was considered and rejected: it costs a second column holding the same concept and a second level of resolution. |
| Does picking a model change the global default?                        | **Yes.** The global is the model a new conversation starts with, and the last pick is what the user expects there.                                                                                                                                                                                                                                       |
| Can a conversation pin its own compaction model?                       | **Yes.** `sessions.compaction_model` and `sessions.compaction_provider_id` carry it.                                                                                                                                                                                                                                                                     |
| What happens when a conversation inherits the global compaction model? | The provider cannot be inherited (the global never stored one — it was transient). The provider is resolved from the model name, which is what already happens after a page reload.                                                                                                                                                                      |

## The shape it ended up with

**Storage.** `sessions.model` (existing, NOT NULL) is the conversation's main
model. Three nullable columns are added: `provider_id`, `compaction_model`,
`compaction_provider_id`.

**Vocabulary** (`src/services/sessionSelection.ts`). `SessionSelection` is
`{ model, providerId, compactionModel, compactionProviderId }`. Two values are
easy to get wrong, so they are defined once:

- `providerId: null` means _not pinned_ — the provider is resolved from the
  model name. It does not mean _no provider_.
- `compactionModel: null` means _inherit the global default_;
  `compactionModel: ''` means _compact with the conversation's own main model_.
  The two empties are different and stay apart all the way to the column.

**Store** (`src/app/lib/chatStore.ts`). The conversation on screen is
`model` / `activeProviderId` / `compactionModel` / `compactionProviderId`; the
global settings are `defaultModel` / `defaultProviderId` /
`defaultCompactionModel`. The row in `state.sessions` is the conversation's own
record, and `SET_CURRENT_SESSION` restores the selection of the conversation
being switched to.

Three actions own the selection, and nothing else writes it:

| Action                    | Who dispatches it                                            | What it does                                                               |
| ------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `SET_SESSION_SELECTION`   | the pickers, `/model`                                        | pins the conversation's row and updates the global default                 |
| `APPLY_SESSION_SELECTION` | the server (a row that was just loaded) and the session push | patches the row; the mirror follows only if that conversation is on screen |
| `SET_DEFAULT_SELECTION`   | the boot reconciliation, the config load                     | changes the global default                                                 |

`SET_CONFIG` no longer carries a model selection, and its type says so.

**Writes.** `PATCH /api/sessions/[id]` writes the selection, queued with the
session's message writes. `saveSessionSelection`
(`src/app/lib/sessionSelectionClient.ts`) is the one place a pick is saved: the
conversation's row first, then the global default.

**The push.** The SSE event is `session-updated` and the payload discriminates on
`kind` (`renamed` / `model-changed`).

## Commit sequence

| Step | Commit                                                       | What it did                                                                                 |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 1    | `feat(sessions): persist a per-conversation model selection` | the columns, the vocabulary, `updateSessionSelection`, the `PATCH` route, the session event |
| 2    | `feat(chat): run each conversation on its own model`         | the store, the request body, the switch, the pickers, the push consumer                     |
| 3    | `test(sessions): pin the per-conversation model selection`   | the feature's own checks; the tests whose contract moved                                    |
| 4    | `docs: record the per-conversation model selection`          | this plan, the changelog, `CLAUDE.md`, `CONFIRMATIONS.md`                                   |

## Out of scope

- The reasoning effort, the completion mode and the context window stay global.
  They are not part of a conversation's model selection, and the context window
  is the server's to resolve anyway.
- The sub-agent model still follows the conversation's main model; it is not a
  separate selection.
- A conversation's model is not editable from the sidebar. The picker and
  Settings edit the conversation on screen.

## What was not verified

The browser loop itself: the picker, the conversation switch and the status bar
were not exercised by hand. See `CONFIRMATIONS.md` C-018.
