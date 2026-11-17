# Provider pair integrity - bug hunt scratchpad

Status: **open - 10 bugs triaged, none fixed yet** (2026-11-17).

Branch: `feature/provider-pair-integrity` @ `1efe87e`
Base: `origin/dev` @ `5dd33ac` (merge-base == `origin/dev` tip)
Change set: **52 files, +3690 / -526**, 5 commits.

This file is the durable record of the review that was done on 2026-11-17. It
exists so the work can be chipped away one bug at a time across sessions
without re-deriving the evidence. Every finding carries the exact location,
the reproduction, and the suggested fix.

Companion documents:

- `docs/PROVIDER_PAIR_PLAN.md` - the branch's own design document (the
  authoritative statement of intent).
- `CONFIRMATIONS.md` - the repo's record of confirmed gaps. The findings below
  map onto C-025, C-026, C-027 and C-029.

---

## 1. SCOPE - read this first, it is a trap

**The real base is `origin/dev`, not `origin/master`.**

```powershell
git merge-base origin/master HEAD   # 3d92b3f  <- WRONG base
git merge-base origin/dev HEAD      # 5dd33ac  <- RIGHT base
```

`origin/master` is **177 commits behind** `origin/dev`. So:

| Diff                                        | Files | Lines           | Meaning                                     |
| ------------------------------------------- | ----- | --------------- | ------------------------------------------- |
| `git diff origin/master...HEAD --shortstat` | 366   | +76177 / -11906 | **Misleading.** Includes all of dev's work. |
| `git diff origin/dev...HEAD --shortstat`    | 52    | +3690 / -526    | **The real change set.**                    |

Always scope this branch against `origin/dev`.

The 5 commits on the branch, oldest first:

```
6de53ed feat(compaction): one rule decides the compaction model AND its provider
29c5a12 fix(provider): resolve a stale provider id by id ONLY, and refuse it by name
2b7f18e feat(provider): validate the (model, provider) pair against a cached model index
b65f097 feat(compaction): the compaction model and its provider are ONE value
1efe87e feat(compaction): the store and the wire carry the selection as ONE value
```

## 2. WHAT THE BRANCH IS SUPPOSED TO DO

A selection is a **(model, provider) pair** and the pair must be coherent. A
model is never handed to a provider that does not serve it. The pair must be
**unrepresentable** as two loose fields, so the illegal "a model, but no
provider" state cannot be written or read.

The union that replaced the two loose fields
(`src/services/sessionSelection.ts`):

```ts
export type CompactionSelection =
  | { kind: 'inherit-default' }
  | { kind: 'same-as-main' }
  | { kind: 'explicit'; model: string; providerId: string };
```

The ground rules from `docs/PROVIDER_PAIR_PLAN.md`:

1. One owner per concept - the pair is one type, the rule is one function, the
   index is one module.
2. The server decides - the client sends what the conversation has.
3. **Loud beats silent** - a pair that cannot be honoured is refused with a
   message that names the cause. A silent fallback to a different endpoint is
   the failure this whole effort exists to end.
4. Additive migrations only.
5. The client keeps working - a stale tab that sends the old wire shape gets a
   clear message, not a crash.

## 3. HOW TO RE-VERIFY (and what is already broken on this machine)

```powershell
cd C:\git\Locopilot-dev

# lint + types - both clean on this branch
npx eslint src tests --max-warnings 0
npx tsc --noEmit

# the branch's own suites - 8 suites / 208 tests, all green
npx cross-env NODE_OPTIONS="--experimental-vm-modules --no-warnings" jest `
  tests/compaction-rule tests/session-model-selection tests/session-compaction-pair `
  tests/model-index tests/provider-resolution tests/provider-persistence `
  tests/config-load tests/numctx-resolver

# the whole suite - see the baseline below
npm test
```

**Baseline failures - NOT caused by this branch.** Measured on 2026-11-17 by
running the full suite on the branch and on a throwaway `origin/dev` worktree
on the same machine:

|             | branch `1efe87e`                              | base `5dd33ac`                                |
| ----------- | --------------------------------------------- | --------------------------------------------- |
| Test suites | 84 total, 21 failed, 63 passed                | 80 total, 21 failed, 59 passed                |
| Tests       | 1950 total, 97 failed, 1851 passed, 2 skipped | 1871 total, 96 failed, 1773 passed, 2 skipped |

The same **21 suites fail on both**. Causes:

- **19 suites fail to even LOAD**: `Must use import to load ES Module:
node_modules/@exodus/bytes/encoding-lite.js` / `html-encoding-sniffer` /
  `jsdom`. Node v22.22.3 has no `require(esm)`. Environmental, not code.
- **`tests/compact-recent-files.test.mjs`**: one Windows path assertion
  (`expect(found.has('/work/project/src/app.ts'))`) fails on the base too.
- The branch's one extra failure is the **flaky** timing assertion
  `expect(elapsed).toBeLessThan(150)` in the same file (measured 156.9 ms).
  It passes on base in the same run - pure flake, pre-existing test.

**Do not report these as branch regressions.** If the count of failing suites
changes from 21, that IS the branch.

### Environment gotchas on this machine

- Default shell is **PowerShell**. No `&&` - use `;`.
- `Get-Content "src/app/api/sessions/[id]/route.ts"` fails - PowerShell treats
  `[id]` as a wildcard. Use `-LiteralPath`.
- Node v22.22.3. `npm test` needs the `NODE_OPTIONS="--experimental-vm-modules
--no-warnings"` flag (the npm script supplies it; bare `npx jest` does not).
- The repo's `locopilot.db` is held open by Windows - a test that opens SQLite
  in the checkout can fail. Tests that touch the DB must `process.chdir()` into
  a `mkdtemp` **before** importing `src/services/history.ts` (see
  `tests/session-model-selection.test.mjs` for the pattern).
- Commit convention in THIS repo is conventional-commit style, not `DT-nnn:`:
  `feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `test(scope): ...`.

### Probe pattern used by this review

Probes were written to `tests/zz-review-probe*.test.mjs`, run, then deleted.
`git status --short` was restored to its pre-review state. To re-run one, copy
the snippet from the finding below.

---

## 4. THE 10 BUGS, RANKED

Status key: `[ ]` open, `[~]` in progress, `[x]` fixed and verified.

### [x] BUG 1 - HIGH - a global compaction model with no global provider still goes to the main provider, unchecked

**FIXED 2026-11-17.** The check now happens against the provider the CHAT runs
on, and the check is made against the RESOLVED provider (the request's own
provider id), never `providers[0]`. See "THE FIX" at the end of this entry.

**The production incident this branch exists to kill is still reachable.**

- `src/services/compactionRule.ts:182` - the global provider is only picked
  when one is configured; otherwise `providerId` stays `null`, which means
  _"the main provider"_.
- `src/services/contextWindow/configProblem.ts:144` -
  `if (selection.providerId === null) { return null; }` with the comment
  _"The MAIN provider - the main check already covered its window."_ The main
  check covered the **main model's** window, never whether the main provider
  serves the **compaction** model.

**Why it is wrong.** `config.compactionModel = 'beam'` (an Ollama Cloud model)
with no `config.compactionProviderId` sends `beam` to the main chat provider
(NVIDIA). NVIDIA answers HTTP 404. That is CONFIRMATIONS C-025 verbatim: _"221
such failures in 14 minutes under one request id"_.

**This is also C-025's own acceptance criterion, not met.**
`CONFIRMATIONS.md` C-025 says: _"(b) without one, check that the server answers
with a clear 'the compaction model needs a provider' refusal instead of silently
calling the main provider."_

**Proof (probe output, warm index; NVIDIA serves `llama3`, Ollama Cloud serves
`beam`):**

```
main pair (nvidia, beam)                     = "The provider \"NVIDIA\" does not serve the model \"beam\".
                                                The model \"beam\" is served by Ollama Cloud instead. ..."
compaction (global beam, no global provider)  = null      <-- NO REFUSAL
```

**The branch's defence, and why it does not cover this.** `CONFIRMATIONS.md`
C-029 argues the global pair legitimately keeps two fields because _"a global
model with no provider of its own"_ is a meaningful state. That argument is
about the **shape** of the config. It is not an argument against **validating**
the pair - and the branch added `providerServesModel` for exactly that.

**Suggested fix (IMPLEMENTED - see "THE FIX" below).** In `compactionProblemFor`,
when `selection.providerId === null` **and** `selection.model !== mainModel`,
run the same `providerServesModel` check against the main provider. Note
`same-as-main` must keep returning `null` early - there the model IS the main
model, so the main check genuinely did cover it.

**Probe to re-run:**

```js
const CONFIG = {
  numCtx: 8192,
  compactionModel: 'beam',
  compactionProviderId: null,
  providers: [
    {
      id: 'nvidia',
      name: 'NVIDIA',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'llama3',
      numCtx: 8192,
    },
    { id: 'ollama-cloud', name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', numCtx: 8192 },
  ],
};
recordProviderModels('nvidia', 'https://integrate.api.nvidia.com/v1', ['llama3']);
recordProviderModels('ollama-cloud', 'https://ollama.com/v1', ['beam']);
compactionProblemFor(CONFIG, { mainModel: 'llama3', compaction: { kind: 'inherit-default' } });
// -> null  (BUG: should be a refusal)
```

#### THE FIX (2026-11-17)

The trigger is `selection.providerId === null && selection.model !== mainModel`

- inside the `providerId === null` branch the only sources are `session-main`
  (model === mainModel), `main` (model === mainModel) and `global` (model = the
  global model), so "the model is not the main model" IS "the global model, with
  no global provider".

**Files changed:**

- `src/services/contextWindow/configProblem.ts`
  - `servingProviderNames(config, provider, model)` - the serving-provider
    lookup extracted out of `providerDoesNotServeMessage` (whose TEXT is
    unchanged, and is still pinned by `tests/model-index.test.mjs`).
  - `compactionProviderDoesNotServeMessage(config, provider, model)` - the new
    message. It names the provider that does not serve the model, the one that
    does, and the two remedies (set `compactionProviderId`, or pick a
    compaction model and provider that belong together). It is deliberately
    NOT `providerDoesNotServeMessage`'s message: the MAIN pair is perfectly
    coherent in this case, so "pick a model and a provider that belong
    together" would send the owner to fix the wrong thing.
  - `compactionModelServiceProblem(config, provider, model)` - the three-valued
    check. `not-served` refuses; `unknown` does NOT (and kicks the background
    refresh so the next turn can ask).
  - `compactionProblemFor(config, {mainModel, mainProvider, compaction})` -
    `mainProvider` is a REQUIRED parameter, so a future caller cannot FORGET
    to pass it. It may still pass `null`, which skips the check - `null`
    means "no provider could be resolved, so there is nothing to check the
    pair against", and the main check has already refused a turn with no
    provider. The fix's own test "no main provider - nothing to check the
    pair against, and nothing is refused" pins that escape hatch.
  - `requestProblemFor` passes `resolveProvider(config, providerId, body.model)`
    - the same resolution the routes use for the main provider.
- `src/app/api/chat/route.ts`
  - the 409 preflight passes
    `mainProvider: resolveProvider(savedConfig.config, providerId, model)` -
    the SAME resolution FUNCTION the runtime makes, so the gate and the call
    agree on how a provider id is turned into a provider. They do NOT read
    the same config object: the chat route reads `config.json` twice (the
    gate with `readConfig()`, the runtime with `loadConfig()`), so a save
    between the two reads can leave them disagreeing. The compact and title
    routes use one config for both.
  - `resolveCompactionRuntime` records a `compaction_model_not_served`
    diagnostic when the compaction inherits the main provider and that
    provider does not serve the compaction model. It fires at TURN START as
    well as after a mid-turn switch - the gate and the runtime read
    `config.json` separately, so they can already disagree. Log, not refuse:
    a running turn must not die.
- `src/app/lib/debugLogger.ts` - the new `compaction_model_not_served`
  diagnostic phase.

**What was deliberately NOT changed:** the rule
(`src/services/compactionRule.ts`) stays dependency-free and never refuses;
the schema; `config.json`'s two-field shape; the client; `/dump`; the
mid-turn switch's "log, do not die" policy.

**What this does NOT close.** The mid-turn model switch still applies a
provider with no pair check, so the identical wrong-endpoint 404 is still
reachable one switch away. That is BUG 3 below, and it is still open.

**Also fixed on the way through:** the serving-provider hint now excludes the
offending provider by ID rather than by name. Two providers may share a name,
and excluding by name dropped the serving one too, so the message said that
NOBODY serves the model when one of them did. That was A4 below.

**Tests:** 11 new in `tests/model-index.test.mjs`, 3 new in
`tests/provider-resolution.test.mjs`. A revert simulation (running the new
test bodies against the pre-fix `configProblem.ts`) shows that ONE test in
each file fails on the pre-fix code - "a global compaction model the MAIN
provider does not serve is REFUSED" and "an inherited global compaction model
the provider does not serve is REFUSED". The rest are FORWARD guards against
an over-broad fix: they fail if the check ever refuses a working turn (the
cold index, `same-as-main`, an explicit pair, and the case where the main
provider DOES serve the compaction model). That is worth having, but they do
not pin this change.

The forward guard that matters most is "the check is made against the
provider the CHAT runs on, not against providers[0]": `resolveProvider(CONFIG,
undefined, 'llama3')` is `p1` (the trap), and the check against `p2` is
`null` (the turn runs).

**Docs:** `docs/PROVIDER_PAIR_PLAN.md` gained "Phase 2.2b";
`CONFIRMATIONS.md` C-025 gained the criterion-(b) note, C-029 gained the
"serving question is answered in both shapes" note, and C-030 is the new
entry for this bug.

**NOT verified live:** no browser and no live provider were exercised.

---

### [ ] BUG 2 - HIGH - a REFUSED mid-turn switch is reported as a successful switch

- `src/app/api/chat/route.ts:1509-1515` - the switch resolves the provider; on
  failure it logs `switch_provider_unresolved` and leaves the turn alone.
  Correct so far.
- `src/app/api/chat/route.ts:1594` - `sendEvent('status', { phase:
'model_switched', ... })` is sent **unconditionally**, including after the
  refusal.
- `src/app/api/chat/route.ts:1553-1554` - `const nextCompaction =
pending.compaction ?? sessionCompaction;` and
  `resolveCompactionRuntime(nextCompaction, true)` run **even when the switch
  was refused**.

**Why it is wrong.** `model_switched` is the client's only "the swap landed"
signal - `src/app/lib/sseRouting.ts:363` clears the pending-switch flag on it.
So a refused switch is announced to the user as a successful one. Meanwhile the
browser's store was already updated by the picker, so the browser and the
running turn now disagree about which provider is in use. And the compaction
half of the bogus switch is applied to the main provider anyway.

**Suggested fix.** Track whether the switch was applied (`let switchApplied =
false`) and only emit `model_switched` when it was. Gate the compaction
re-resolution on the same flag, or at least on `pending.compaction` being
explicitly meaningful.

---

### [ ] BUG 3 - HIGH - the mid-turn switch applies a (model, provider) pair with no coherence check

- `src/app/api/chat/route.ts:1507-1511` - `resolveProviderRequestContext(config,
resolvedProviderId, undefined, requestId)` resolves **by ID only** and there
  is **no `providerServesModel` check anywhere on this path**.
- `src/app/api/chat/switch-model/route.ts` - the route accepts **any**
  provider id and **any** compaction selection; it never loads the config, so
  it cannot check that the provider exists or serves the model.

**Why it is wrong.** C-027 deliberately refuses a switch onto a _non-existent_
provider. A switch onto a provider that exists but does **not serve the model**
still lands: `model = targetModel; activeProvider = resolved.provider;` and the
turn then sends that model to that endpoint -> 404. The mid-turn switch is the
one place a **new** pair is introduced, and it is the one place the branch's
new pair check was not applied.

**Suggested fix.** In `applyPendingModelSwitch`, run the target pair through
`configProblemFor(config, resolvedProviderId, targetModel)` before applying it.
If it returns a problem, refuse the switch (like the unresolvable case) and
log it.

---

### [ ] BUG 4 - MEDIUM-HIGH - `/api/dump` refuses a (model, provider) pair the chat accepts

- `src/app/api/dump/route.ts:62` -
  `requestProblemFor(savedConfig.config, { model }, { checkCompaction: false })`
  - **no `providerId` in the body**.
- `src/app/api/dump/route.ts:85` -
  `resolveProviderRequestContext(config, undefined, model)` - resolves by model
  name only, so it falls back to `providers[0]`.
- `src/app/hooks/useSlashCommands.ts:735-740` - the client posts
  `{messages, model, baseUrl, sessionId}` and **never a provider id**.

**Why it is wrong.** The owner's `ollama-cloud` provider has **no `model`
field**, so `providers[0]` (NVIDIA) is always picked. The new
`providerServesModel` check then judges `beam` against NVIDIA and refuses.

**Proof:**

```
dump body (no providerId)     = "The provider \"NVIDIA\" does not serve the model \"beam\".
                                 The model \"beam\" is served by Ollama Cloud instead. ..."
chat (providerId=ollama-cloud) = null        <-- the chat runs fine
```

The route's own comment says _"the dump is the tool you reach for when
something is broken"_ - and it exempts the dump from the **compaction** check
(`checkCompaction: false`) but not from the new **pair** check. The diagnostic
tool now fails exactly when the configuration is broken.

**Suggested fix.** Either read `body.providerId` in the dump route and resolve
by id (and have the client send it), or exempt the dump from the pair check the
way it is already exempt from the compaction check.

---

### [ ] BUG 5 - MEDIUM - a conversation can be created with a compaction provider that does not exist

- `src/app/api/sessions/route.ts:56` - `validateSessionSelection({...})`.
- `src/app/api/sessions/[id]/route.ts:78` - `validateSessionSelectionPatch(...)`.

Both validate the pair's **shape** only. Neither checks that the named
provider is configured, nor that it serves the model. Compare the chat route's
preflight, which does check (`compactionProblemFor`).

**Proof:**

```
validateSessionSelection({
  model: 'm', providerId: 'p',
  compaction: { kind: 'explicit', model: 'c', providerId: 'ghost-provider' },
})
// -> { model:'m', providerId:'p',
//      compaction:{kind:'explicit', model:'c', providerId:'ghost-provider'}, ... }
```

**Why it is wrong.** `POST /api/sessions` accepts that body, writes
`sessions.compaction_provider_id = 'ghost-provider'`, and answers **201 OK**.
The row is _coherent_ (both halves present), so `listSessions`'
`normaliseSessionRow` keeps it as-is and hands it to the browser. The next turn
for that conversation sends it back and the chat preflight answers **409 "The
compaction provider \"ghost\" is not configured, so this conversation cannot
compact."** - a conversation the server created and the server now refuses to
run. No way for the user to recover except re-picking the compaction model.

**Suggested fix.** Apply `compactionProblemFor` (or at least the
provider-exists half) in the write paths of `POST /api/sessions` and
`PATCH /api/sessions/[id]`, so the pair is refused at write time rather than at
run time.

---

### [ ] BUG 6 - MEDIUM - the write path does not normalise, and the SSE frame announces the raw pair

Two false comments and one latent hole.

- `src/services/sessionSelection.ts:496` - `selectionToColumns`. Its comment
  says _"The pair is normalised on the way out too, so the illegal combination
  cannot reach the row even if a caller builds one by hand. The write paths
  REFUSE an incoherent pair before they get here; this is the belt to that pair
  of braces."_ **The body is only** `compactionSelectionToPair(selection.compaction)` -
  a pure projection that does **not** repair. The "belt to that pair of braces"
  does not exist.
- `src/services/history.ts:491-495` - the `model-changed` frame's comment says
  _"the NORMALISED one, the pair that was actually written: the row can never
  hold a compaction model without the provider that serves it, so neither may
  the frame that announces the change."_ **It announces `selection.compaction`,
  the raw value.**

**Proof (three outputs from one probe):**

```
selectionToColumns = {"model":"m","provider_id":"p","compaction_model":"beam",
                       "reasoning_effort":null,"compaction_reasoning_effort":null}
                       ^ no compaction_provider_id key at all

listSessions row   = {"compaction_model":null,"compaction_provider_id":null}
                       ^ repaired on the way OUT by normaliseSessionRow

model-changed frame= {"kind":"explicit","model":"beam"}
                       ^ a HALF-PAIR on the SSE bus
```

**Reachability.** Not reachable through the HTTP API **today** - the PATCH
route merges `mergeSessionSelection(current, patch)` where `current` comes
from `selectionFromColumns` (normalised) and `patch.compaction` comes from
`parseCompactionSelection` (validated), so the merge is always coherent. It is
reachable from any internal caller that builds a `SessionSelection` by hand -
which is exactly what the branch's own test does.

**Why it still matters.** (a) The safety lives in the callers, not the writer,
and both comments actively tell the next developer it is handled. (b) The
branch's central test claims to cover this and does not (see BUG 10). (c) The
client's reaction to a half-pair frame is to **silently reset the pin** (see
"Also found" item 2 below).

**Suggested fix.** In `selectionToColumns`, run the pair through the existing
`coherentCompactionPair` (it already does the right thing). In
`updateSessionSelection`, announce the normalised selection - e.g.
`selectionFromColumns(columns).compaction` - instead of `selection.compaction`.

---

### [ ] BUG 7 - MEDIUM - the client throws away every server refusal message

- `src/app/lib/sessionSelectionClient.ts:50` - `saveDefaultsPatch` returns
  `res.ok`.
- `src/app/lib/sessionSelectionClient.ts:77` - `saveSessionPatch` returns
  `res.ok`.

The response body is never read. Every refusal the server now produces -
`legacyCompactionPairPatchProblem` (_"The compaction model \"beam\" was changed
without the provider that serves it..."_), `parseCompactionSelection` (_"The
compaction selection names no model..."_), `validateSessionSelectionPatch`
(_"The model selection patch must contain at least one field"_), the 500 path
(_"Failed to update session"_) - is replaced by the generic _"The model could
not be saved for this conversation."_ / _"The model was saved for this
conversation, but not for new chats."_

**Why it is wrong.** Ground rule 3 of the branch is _"Loud beats silent - a
pair that cannot be honoured is refused with a message that names the cause."_
The message the server carefully wrote never arrives. The user is told
"something went wrong" and is given no way to work out what to fix.

Note the inconsistency: the SettingsModal's own config PUT
(`src/components/SettingsModal/SettingsModal.tsx:355-380`) **does** read the
body (`await response.text()`), so the two write paths in the same feature
behave differently.

**Suggested fix.** Return the parsed `{error}` from the response body instead of
a bare boolean, and surface it in the `SET_ERROR` dispatch.

---

### [ ] BUG 8 - MEDIUM - "Use the default" mid-turn sends an empty request that the server refuses

- `src/components/ModelSelector/ModelSelector.tsx:588-593` -
  `...(nextCompactionModel === null ? {} : { compaction: picked })`. For "Use
  the default" the mid-turn payload is **`{}`**.
- `src/components/SettingsModal/SettingsModal.tsx:490-491` -
  `const compactionSwitch = pickedCompaction.kind === 'inherit-default' ?
undefined : pickedCompaction;` and line 513 -
  `...(compactionChanged && compactionSwitch ? { compaction: compactionSwitch }
: {})`. Same result: **`{}`**.
- `src/app/api/chat/switch-model/route.ts` - the route answers **HTTP 400**
  `"At least one of \"model\", \"compaction\", or \"providerId\" is required"`.
- `src/app/lib/switchModelClient.ts` - returns `response.ok`; the body is
  discarded.
- `src/components/ModelSelector/ModelSelector.tsx:308-337` -
  `switchMidTurn` only clears the "switching..." flag on failure. **No message
  reaches the user.**

**Why it is wrong.** You pick "Use the default" in the compaction picker while
an answer is streaming. The picker updates, the status bar updates, the
"(switching...)" badge appears and vanishes - and the **running turn keeps
compacting with the old model**. Nothing says so.

The server _can_ express this state: `compaction: {kind:'inherit-default'}` is
accepted by `compactionSelectionFromPayload`, and `applyPendingModelSwitch`
does `pending.compaction ?? sessionCompaction`, so it would resolve the global
pair correctly.

**Suggested fix.** Send `compaction: { kind: 'inherit-default' }` instead of
omitting the key (the server already understands it), or skip the switch
request entirely when there is nothing else to switch. Separately, surface the
switch error instead of only clearing the flag.

---

### [ ] BUG 9 - MEDIUM - picking a model wipes the global compaction-provider pin

- `src/app/lib/chatStore.ts:1508` - `defaultCompactionProviderId:
defaults.compactionProviderId` assigned **unconditionally**.
- The sibling reducer does it correctly: `src/app/lib/chatStore.ts:1530-1532`
  uses `...(action.compactionProviderId === undefined ? {} : {...})`.

**Proof:**

```
P5 before = "ollama-cloud"
P5 after (defaults omitted compactionProviderId) = undefined
P5 after (defaults WITH the key)               = "ollama-cloud"
```

**Why it is wrong.** `defaults` is typed `SessionDefaults`, whose
`compactionProviderId` is `string | null` (not optional), so TypeScript does
not catch a caller that omits it - and the branch's own tests dispatch
`defaults` objects without the key in **four** places
(`tests/session-model-selection.test.mjs:554`, `:614`, `:681`, and
`tests/context-window.test.mjs:242`, `:261`). `defaultCompactionProviderId` is
asserted by **no test in the repo** (grep for it in `tests/` returns 0 hits).

**Suggested fix.** Use the same `=== undefined` guard as the sibling reducer.

---

### [ ] BUG 10 - MEDIUM - the branch's central guarantee test passes while the row violates it

- `tests/session-model-selection.test.mjs:842-853` - the test _"a row can never
  hold a compaction model without its provider"_:

```js
const id = createSession('New chat', {
  ...SELECTION,
  compaction: { kind: 'explicit', model: 'cheap-compactor' },
});
const stored = listSessions().find((s) => s.id === id);
expect(stored.compaction_model).toBeNull();
expect(stored.compaction_provider_id).toBeNull();
```

**What actually happens (raw SQLite row after that `createSession`):**

```
RAW ROW: compaction_model: 'cheap-compactor', compaction_provider_id: null
```

The test passes only because `listSessions()` -> `normaliseSessionRow()`
(`src/services/history.ts:548`) **rewrites the pair on the way out**. The write
path does not normalise (see BUG 6).

**Why it is wrong.** The test cannot detect a write-path regression at all:
replacing `compactionSelectionToPair` with a raw two-field projection would
leave it green. The branch's single most important guarantee is untested.

**Suggested fix.** Read the raw row with `better-sqlite3` - the sibling test at
`tests/session-model-selection.test.mjs:866` already does exactly that - and
assert on `compaction_model` rather than on the `listSessions()` projection.
Fix this together with BUG 6, or the new test will fail until the write path
is fixed.

---

## 5. ALSO FOUND (lower severity - not in the top 10)

| #   | Sev    | Where                                                                                                                            | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Medium | `src/app/api/sessions/route.ts:56` vs `src/app/api/chat/route.ts:369-371` vs `src/app/api/chat/switch-model/route.ts:69`         | The **same** request body resolves to a **different** compaction selection per endpoint. `POST /api/sessions` falls back to the conversation's **main** model; `POST /api/chat` falls back to the **global** compaction model; `switch-model` falls back to the **switched** model. Probe: the same legacy body gives `{model:'llama3', providerId:'ollama-cloud'}` on `/api/sessions` and `{model:'beam', providerId:'ollama-cloud'}` on `/api/chat`.                                                           |
| A2  | Medium | `src/app/hooks/useSessionEvents.ts:74-83`                                                                                        | A `model-changed` frame whose `compaction` is missing or unparseable is **silently repaired** to `inheritDefaultCompactionSelection()` - the exact silent repair the branch removes server-side. It also **ignores** the legacy `compactionModel`/`compactionProviderId` fields entirely: they are declared at `:57-59` and never read, so a legacy frame loses the pinned compaction model. Reachability is limited to a malformed/legacy frame, but this is the one place the client performs a silent repair. |
| A3  | Medium | `src/app/hooks/useDataLoaders.ts:362-370`                                                                                        | The dangling-provider repair only inspects `state.model` / `state.activeProviderId`. The **compaction** half of the pair is not repaired, so a dead compaction provider blocks every turn with a 409 while the main half self-heals. The two halves of one pair now behave differently.                                                                                                                                                                                                                          |
| A4  | Low    | `src/services/contextWindow/configProblem.ts:62-64`                                                                              | **FIXED 2026-11-17** with BUG 1: the "which provider _does_ serve it" hint now excludes the offending provider by ID rather than by name, so two providers sharing a name no longer hide the one that serves the model. Proven before the fix: `"The provider \"Same Name\" does not serve the model \"y\". No configured provider is known to serve it."` while provider `b` did serve `y`.                                                                                                                     |
| A5  | Low    | `tests/session-model-selection.test.mjs:158-171`                                                                                 | `toStrictEqual` -> `toMatchObject` (a recursive **subset** match) on exactly the legacy-path assertions the branch's "the client keeps working" guarantee rests on. A `compaction` carrying extra fields still matches.                                                                                                                                                                                                                                                                                          |
| A6  | Low    | `tests/session-model-selection.test.mjs:818`, `tests/session-compaction-pair.test.mjs:162`, `tests/compaction-rule.test.mjs:361` | `expect(x).not.toBeNull()` - passes on `undefined` and `''`. Zero weight. The **content** of every "loud" refusal is unchecked, even though the message is the whole point.                                                                                                                                                                                                                                                                                                                                      |
| A7  | Low    | `tests/provider-resolution.test.mjs:130-142`                                                                                     | Source-text greps standing in for behaviour. `expect(chatRoute).toContain('providerNotConfiguredMessage')` passes even if the 409 gate is deleted; `not.toMatch(/activeProvider = null/)` is a spelling proxy that a reformatted `activeProvider = (null as ProviderConfig \| null)` would slip past.                                                                                                                                                                                                            |
| A8  | Low    | `tests/provider-persistence.test.mjs:100-116`                                                                                    | The new test asserts the **echo of its own input** (`saveSessionPatch` is literally `JSON.stringify(patch)`), so it cannot prove the client never emits the flat pair.                                                                                                                                                                                                                                                                                                                                           |
| A9  | Low    | `tests/session-model-selection.test.mjs:215`                                                                                     | A **deleted** assertion: the legacy-patch branch (`{compactionModel: null}`) used to be pinned and now has no unit-level test of the new refusal it produces.                                                                                                                                                                                                                                                                                                                                                    |
| A10 | Info   | `docs/PROVIDER_PAIR_PLAN.md` "Verification"                                                                                      | The listed `npm test --` invocation omits the two new suites `tests/model-index` and `tests/provider-resolution`. The plan also still claims `npm run type-check` has pre-existing errors - it is now **clean** (exit 0).                                                                                                                                                                                                                                                                                        |
| A11 | Info   | `tests/context-window.test.mjs:236-243`, `:256-262`                                                                              | Not touched by the branch, but still dispatch the **pre-2.3 flat shape** (`compactionModel`, `compactionProviderId`). After the dispatch `state.compaction === undefined` and `state.defaultCompactionProviderId === undefined` - the store silently accepts a state its own types forbid, and the test would keep passing after any regression in the compaction wiring.                                                                                                                                        |
| A12 | Low    | `src/services/modelIndex.ts` (the TTL), `src/services/contextWindow/configProblem.ts`                                            | Found while VERIFYING the BUG 1 fix: a stale model index (a list up to 5 minutes old) can answer "not served" wrongly, and the background refresh is only kicked on "unknown", so such a refusal does NOT self-heal until the TTL expires. The MAIN-pair check already had this exposure; the BUG 1 fix adds a second pair that can refuse a whole turn on a stale answer.                                                                                                                                       |

---

## 6. VERIFIED CORRECT - do not re-check these

- **The half-pair really is dead on every reachable path.** `createSession`,
  `PATCH /api/sessions/[id]`, `POST /api/sessions`, the `session_created` and
  `model-changed` SSE frames, `listSessions` / `searchSessions`,
  `getSessionSelection`, and the `history.ts` bootstrap migration all
  normalise. A live path that writes or reads one was searched for hard and
  not found. (The write path _not_ normalising is BUG 6, but it is not
  reachable from HTTP today.)
- **`resolveProvider` now returns `null` for a stale explicit id BEFORE the
  model-name step** (`src/services/providerResolver.ts:53-66`). The cross-wire
  that ran a stale id's request against another provider's API key is closed,
  and every call site that passes an id now passes `undefined` as the model.
- **The model-name step still exists for the no-id case**, which is correct -
  it is the only way to find a provider when the request carries no id.
- **The model index is well built.** Three-valued (`served` / `not-served` /
  `unknown`), fail-open on unknown, key is `(providerId, baseUrl)` so an
  address change cannot answer with a stale list, 5-minute TTL for success /
  60-second for failure, background refresh that never blocks the chat path, an
  empty list treated as unknown rather than as "serves nothing".
- **The legacy wire shape is still read in exactly one place**
  (`compactionSelectionFromPayload`). The old client's payload was traced
  against the new validator: the old `handleSelectCompaction` sent
  `{compactionModel, compactionProviderId}` **together**, so a stale tab still
  works, including `compactionModel: ''` (same-as-main) with
  `compactionProviderId: null`.
- **`resolveCompactionRule` is pure and dependency-free**, shared byte-for-byte
  between server and browser. That is why the client's picker and the server
  agree, and it is a genuinely good design.
- **The compaction picker's highlight is correct.** `activeModel` in compaction
  mode is `compactionSelectionToPair(compaction).model` - `null` for
  inherit-default, `''` for same-as-main, the name for explicit. The dedicated
  "Use the default" row (`:654`) and "Same as main model" row (`:629`) are the
  ones marked active, and no model row is highlighted for those two states.
  That is deliberate and matches the comment. (An earlier reading of this code
  as a bug was wrong.)
- **`compactionSelectionEquals` is used, not `===`**, in
  `useDataLoaders.ts:222` - identity comparison would have been permanently
  false for the "did the user change the selection" guard.
- **A `model-changed` frame for a different conversation cannot overwrite the
  current one** - `APPLY_SESSION_SELECTION` only touches the top level when
  `sessionId === state.currentSessionId`.
- **The `CompactionSelection` -> pair -> `CompactionSelection` round trip is
  lossless** for all three states.
- **No weakened assertions of the "a check was deleted" kind** were found. The
  only weakenings are `toStrictEqual` -> `toMatchObject` (A5).
- `npm run type-check` is **clean** - the plan doc's claim of pre-existing
  mermaid / MCP OAuth errors is stale.

---

## 7. SUGGESTED ORDER OF WORK

1. **BUG 1** - DONE (2026-11-17). The branch's own C-025(b) criterion; the
   original production incident.
2. **BUG 2 + BUG 3** - both live in `applyPendingModelSwitch`
   (`src/app/api/chat/route.ts:1475-1614`). Fix them together; they share the
   same "was the switch applied?" flag.
3. **BUG 6 + BUG 10** - fix the write path _and_ its test together, otherwise
   the new test fails until the writer is fixed.
4. **BUG 5** - refuse an unconfigured compaction provider at write time.
5. **BUG 7** - surface the server's refusal messages.
6. **BUG 4** - make `/api/dump` work again.
7. **BUG 8** - send the inherit-default compaction switch.
8. **BUG 9** - guard `defaultCompactionProviderId`.
9. The "Also found" list.

## 8. PROGRESS TRACKER

| Bug                                       | Severity    | Status | Commit                                                                              | Notes                                                                                                                                  |
| ----------------------------------------- | ----------- | ------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1 - global compaction pair unchecked      | High        | [x]    | `fix(compaction): the inherited global pair is checked against the chat's provider` | `compactionProblemFor` now takes the resolved main provider and checks the inherited global pair against it. `CONFIRMATIONS.md` C-030. |
| 2 - refused switch reported as applied    | High        | [ ]    |                                                                                     |                                                                                                                                        |
| 3 - mid-turn switch has no pair check     | High        | [ ]    |                                                                                     |                                                                                                                                        |
| 4 - /api/dump refuses a valid pair        | Medium-High | [ ]    |                                                                                     |                                                                                                                                        |
| 5 - session created with a ghost provider | Medium      | [ ]    |                                                                                     |                                                                                                                                        |
| 6 - write path does not normalise         | Medium      | [ ]    |                                                                                     |                                                                                                                                        |
| 7 - refusal messages discarded            | Medium      | [ ]    |                                                                                     |                                                                                                                                        |
| 8 - empty mid-turn switch body            | Medium      | [ ]    |                                                                                     |                                                                                                                                        |
| 9 - global compaction pin wiped           | Medium      | [ ]    |                                                                                     |                                                                                                                                        |
| 10 - guarantee test is vacuous            | Medium      | [ ]    |                                                                                     |                                                                                                                                        |
| A1-A11                                    | Low/Info    | [ ]    |                                                                                     |                                                                                                                                        |

## 9. REVIEW HYGIENE

- All 7 probe files used by this review were deleted.
- The throwaway `origin/dev` worktree (`%TEMP%\locopilot-base-check`) was
  removed and `git worktree prune` was run.
- `git status --short` at the end of the review showed only the four entries
  that pre-dated it: `next-env.d.ts` (modified, gitignored anyway), and
  `.claude/launch.json`, `.tmp-base/`, `config.json.tmp` (untracked).
- The only file this scratchpad adds to the tree is this one.
