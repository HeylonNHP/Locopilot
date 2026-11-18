# Provider pair integrity - bug hunt scratchpad

Status: **10 bugs triaged, 10 fixed** (2026-11-17), plus A4, A12 and A13. Of the A-table backlog, A5, A6, A7, A8, A9 and A10 are done and committed, and A1 (`8d48a58`), A2 (`c7e7b60`), A3 (`71580cc`, `f27a156`), A11 (`f27a156`) and A14 (`d8203fe`) are done (2026-11-18). The A-table backlog is closed. See section 5.1.

Branch: `feature/provider-pair-integrity`, based on `origin/dev` @ `5dd33ac`
(merge-base == `origin/dev` tip). The branch is several commits ahead of the
base as of 2026-11-17; run `git diff origin/dev...HEAD --shortstat` for the
current scope rather than trusting a number written here.

This file is the durable record of the review that was done on 2026-11-17. It
exists so the work can be chipped away one bug at a time across sessions
without re-deriving the evidence. Every finding carries the exact location,
the reproduction, and the suggested fix.

Companion documents:

- `docs/PROVIDER_PAIR_PLAN.md` - the branch's own design document (the
  authoritative statement of intent).
- `CONFIRMATIONS.md` - the repo's record of confirmed gaps. The findings below
  map onto C-025, C-026, C-027, C-028, C-029 and C-030.

---

## 0. RESUME HERE

**Read this section first. It is the whole handoff.**

### Where the work stands

All ten bugs are fixed and committed. The full test suite is green on the Linux
development machine (86 suites, 2200 passed, 2 skipped as of 2026-11-17); the
"21 environmental suites" recorded earlier were measured on a Windows machine.

| Bug | Severity         | Status   | Commit    | One line                                                                                                                      |
| --- | ---------------- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | High             | **done** | `5db11d1` | The inherited global compaction pair is checked against the provider the chat runs on.                                        |
| 2   | High             | **done** | `6a1e98b` | A refused mid-turn switch is refused WHOLE and announced.                                                                     |
| 3   | High             | **done** | `6a1e98b` | The mid-turn switch is checked as a pair.                                                                                     |
| 6   | Medium           | **done** | `7ca24ad` | The WRITE path normalises the pair; the frame carries what was written.                                                       |
| 8   | Medium           | **done** | `6a1e98b` | "Use the default" is carried mid-turn; a refusal is reported.                                                                 |
| 10  | Medium           | **done** | `7ca24ad` | The guarantee test reads the RAW row, so it can see a half-pair.                                                              |
| 4   | Medium-High      | **done** | `d893ddf` | `/api/dump` refuses a (model, provider) pair the chat accepts.                                                                |
| 5   | Medium           | **done** | `11011df` | A selection is checked as a pair before it is written (POST and PATCH); A12 folded in.                                        |
| 7   | Medium           | **done** | `1faba56` | The save helpers return the server's refusal message and every call site shows it.                                            |
| 9   | Low (was Medium) | **done** | `d893ddf` | The global compaction-provider pin is wiped. Re-rated: every dispatcher supplies the key, so it is unreachable in production. |

### The next action

All ten bugs are done. What is left is the A-table backlog (section 5.1 has
the per-item status):

- **A7** is done (`tests/chat-route-pair-gates.test.mjs`). Two gaps remain
  that no test covers: a refused mid-turn switch that still applies its
  compaction selection, and one that nulls `activeProvider`. Neither is
  observable from the SSE frames or the provider requests of a one-iteration
  turn; a test needs a second tool-call iteration or a spy on the compaction
  runtime.
- **A11** (two tests in `tests/context-window.test.mjs` still dispatch the
  pre-2.3 flat shape) is a test-only fix.
- **The remaining behaviour changes, each needing its own review:** (A1 is
  done: one fallback model, `legacyCompactionFallbackModel`; A2 is done:
  an unusable `model-changed` frame is ignored and reported; A3 is done
  (2026-11-18): a dangling COMPACTION provider pin is reset to "use the
  default", saved and reported, by `APPLY_SESSION_SELECTION` - no new
  store action was needed; A14 is done: `acknowledgeModelSwitch` drops
  only the fields the caller peeked).

Before closing the branch, check that the model index matches what Ollama
Cloud and NVIDIA actually list: no live provider has exercised any refusal.

### The cycle that was used for each fix

1. **Plan** with a sub-agent (one focused brief; a long brief got the agent
   cancelled once - split it).
2. **Implement** the plan by hand.
3. **Verify and bug-hunt** with a SECOND sub-agent, told explicitly not to
   touch the repo. This step earned its keep every time: it found a
   destroyed CHANGELOG bullet, a vacuous new test, two wrong doc claims, a
   blank-provider-id cross-wire and a stale scratchpad header - none of
   which I had spotted.
4. **Prove the new tests are not vacuous** with a revert simulation (see
   section 11).
5. **Update the docs**: `docs/CHANGELOG.md` (a new entry at the TOP),
   `CONFIRMATIONS.md` (the entries the fix touches), `docs/PROVIDER_PAIR_PLAN.md`
   (a phase section when the design changes), and THIS file (tick the bug,
   add a "THE FIX" section, update the tracker).

### Where the design decisions are written down

- `docs/PROVIDER_PAIR_PLAN.md` - Phase 2.2b (the turn-start check) and
  Phase 2.5 (the mid-turn switch).
- `CONFIRMATIONS.md` - C-030 is the entry for the switch work; C-028 was
  corrected when the write path was fixed.
- The "THE FIX" sections in this file, under each bug.

### Things a new session MUST NOT re-derive

- The base is `origin/dev`, not `origin/master` (section 1).
- The 21 failing suites are the baseline, not a regression (section 3).
- The review's own false positives are listed in section 6 - do not re-audit
  them.
- The tooling traps that cost two rounds of corrupted edits are in
  section 10. Read them before editing a file.

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

# the branch's own suites - 11 suites / 337 tests, all green
npx cross-env NODE_OPTIONS="--experimental-vm-modules --no-warnings" jest `
  tests/mid-turn-switch tests/model-index tests/sse-routing `
  tests/provider-resolution tests/numctx-resolver tests/context-window `
  tests/compaction-rule tests/session-model-selection tests/session-compaction-pair `
  tests/provider-persistence tests/config-load

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

### [x] BUG 2 - HIGH - a REFUSED mid-turn switch is reported as a successful switch

**FIXED 2026-11-17.** A refused switch is now refused WHOLE and ANNOUNCED:
the turn keeps the model and the provider it already runs on, the compaction
keeps the selection it already has, and a new SSE phase
`model_switch_refused` carries the reason to the client. See "THE FIX" at
the end of this entry.

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

#### THE FIX (2026-11-17)

The decision the owner took: **refuse the whole switch.** A half-applied
switch - the main model moved but the compaction left behind, or the other
way round - is exactly the ambiguity this bug is about.

- `src/app/api/chat/route.ts` - `applyPendingModelSwitch` now PLANS the
  switch first (`planModelSwitch`). When the plan is not ok it applies
  NOTHING: the model, the provider, the compaction selection, the request
  context and the window are all left as they were, the compaction runtime
  is not even called, and the refusal is announced on a new SSE phase
  `model_switch_refused` with the reason. The pending entry is
  acknowledged, so a refused switch is not refused again on every tool-call
  iteration.
- `src/types/sse.ts`, `src/services/sseNames.ts` - the new phase, and a
  `reason` field on the `status` payload.
- `src/app/lib/sseRouting.ts` - the new phase clears the "(switching...)"
  flag for the owning session and raises `SET_ERROR` with the reason. It is
  deliberately NOT the `error` SSE event: that one means the turn failed
  (`markFailed`), and the turn is still running.
- `src/app/lib/switchModelClient.ts` and the two components - a refusal is
  REPORTED, not swallowed (see BUG 8's fix).

The store is NOT rolled back: it mirrors the conversation's SAVED selection,
which the server already accepted. A refused switch means the running turn
did not adopt the new selection early, not that the selection was not saved.

---

### [x] BUG 3 - HIGH - the mid-turn switch applies a (model, provider) pair with no coherence check

**FIXED 2026-11-17.** The switch is now checked as a pair, through the same
checks a new turn is put through. This was the last route to the production 404. See "THE FIX" at the end of this entry.

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

#### THE FIX (2026-11-17)

- `src/services/contextWindow/configProblem.ts` - `planModelSwitch(config,
input)` forms the pair the switch WOULD form and puts it through the same
  checks a new turn is put through: the main pair through `configProblemFor`,
  the compaction pair through `compactionProblemFor`. It returns
  `{ok: true, target}` or `{ok: false, problem}`.
- **The check is the TURN's, not the route's.** The turn knows what it runs
  on RIGHT NOW - the model, the provider and the compaction selection it is
  actually using - and only the turn can say whether an `inherit-default`
  compaction would inherit the provider the switch moves it to. The route
  (`/api/chat/switch-model`) would have to guess the live pair, which is
  either a false refusal or a missed one. The route stays a thin registry
  writer: one owner for the pair rule.
- **The target provider.** The provider the switch names, resolved BY ID
  ONLY; otherwise the provider the turn ALREADY runs on, because a switch
  that names no provider moves the MODEL, not the endpoint; otherwise the
  model name, as the only hint there is. The middle case closes the
  cross-wire C-027 removed everywhere else: a model-only switch used to
  recover a provider by MODEL NAME, which lands on `providers[0]` whenever
  the switched-to model is that provider's default - so the turn moved to
  another endpoint, with that provider's apiKey.
- **`unknown` NEVER refuses.** A cold cache, a failed fetch and an empty
  list all let the switch through, because a dead or slow provider must not
  block a turn. The checks themselves kick the background refresh.
- `src/app/api/chat/route.ts` - the switch reads `config.json` ONCE and
  hands the same snapshot to the plan, to the window probe and to the
  compaction runtime, so the check and the apply cannot disagree.
- The refusal message names the provider that does not serve the model AND
  the one that does. For the compaction half it says "the provider the
  switch names", because the switch is refused and the conversation does not
  end up on that provider.

**Tests:** 9 new in `tests/model-index.test.mjs`, plus a structural test in
`tests/provider-resolution.test.mjs` that pins the ORDER - the refusal has to
come before every mutation it protects, which a bare `toContain` cannot
see. A revert simulation (the new test bodies run against the pre-fix
source) fails them, so they are not vacuous. Note that
`tests/model-index.test.mjs` cannot even LOAD on the pre-fix source, because
`planModelSwitch` does not exist there.

---

### [x] BUG 4 - MEDIUM-HIGH - `/api/dump` refuses a (model, provider) pair the chat accepts

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

### [x] BUG 5 - MEDIUM - a conversation can be created with a compaction provider that does not exist

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

### [x] BUG 6 - MEDIUM - the write path does not normalise, and the SSE frame announces the raw pair

**FIXED 2026-11-17.** The write path now goes through the SAME repair the
read path uses, and the frame carries the pair that was actually written.
See "THE FIX" at the end of this entry.

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

#### THE FIX (2026-11-17)

- `src/services/sessionSelection.ts` - `selectionToColumns` now goes through
  `coherentCompactionPair`, the SAME repair the READ path uses
  (`compactionSelectionFromLoosePair`). Before, it called
  `compactionSelectionToPair`, which is a pure projection and repairs
  nothing - so the comment "this is the belt to that pair of braces" was
  false. One function, and BOTH database writes are covered: `createSession`
  (`src/services/history.ts:455`) and `updateSessionSelection`
  (`src/services/history.ts:476`).
- `src/services/history.ts` - the `model-changed` frame announces
  `selectionFromColumns(columns).compaction`, the pair that was actually
  written, rather than the selection the caller handed over. A browser can
  therefore never be handed a compaction model with no provider - and a
  browser that received one would have silently reset the pin to "inherit
  the global default".

**Proof, after the fix:**

```
PROBE raw row = {"compaction_model":null,"compaction_provider_id":null}
PROBE announced compaction = {"kind":"inherit-default"}
```

**A NOTE ON THE FALSE COMMENTS.** Two comments in the branch claimed this
was handled when it was not: one in `selectionToColumns` ("this is the belt
to that pair of braces") and one in `history.ts` ("the NORMALISED one...
the row can never hold a compaction model without the provider that serves
it"). Both were false until 2026-11-17. `CONFIRMATIONS.md` C-028 listed the
write path as one of the branch's defences; that claim was false too, and is
now corrected there.

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

### [x] BUG 7 - MEDIUM - the client throws away every server refusal message

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

### [x] BUG 8 - MEDIUM - "Use the default" mid-turn sends an empty request that the server refuses

**FIXED 2026-11-17.** The switch now carries the selection in every state
("Use the default" included), and a refusal is reported instead of
swallowed. See "THE FIX" at the end of this entry.

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

#### THE FIX (2026-11-17)

- `src/app/lib/switchModelClient.ts` - `requestMidTurnModelSwitch` returns
  `{accepted, message}` instead of a bare boolean, and READS the response
  body (the JSON `error` field, or the raw text). `buildMidTurnSwitch`
  builds the body from the parts that changed and `isEmptyMidTurnSwitch`
  says whether it says anything - an empty payload sends NO request at all,
  so the route's HTTP 400 is unreachable from the client. The route's 400
  stays: it is a real boundary, and a stale tab can still send an empty body.
- `src/components/ModelSelector/ModelSelector.tsx` and
  `src/components/SettingsModal/SettingsModal.tsx` - the mid-turn payload
  carries the compaction selection WHOLE, in every state, and neither caller
  swallows a refusal any more: both dispatch `SET_ERROR` with the
  server's message, which the `ErrorBanner` renders.
- `src/app/lib/sseRouting.ts` - the server's own refusal (the new
  `model_switch_refused` phase) is handled too.

**WHY THE OLD OMISSION WAS WRONG.** The pick was not dropped for a reason
that still holds. It was dropped because the OLD flat two-field wire shape
had NO spelling for "inherit the global default" (`null` meant "not sent",
`''` meant "same as main"), and sending a provider without a model was the
half-pair that produced the 404s. The union has that spelling now, and the
OTHER two states were already carried and already changed the running turn's
compaction - so there was never a coherent rule that exempted the third.

**THE BEHAVIOUR CHANGE.** The running turn's compaction now follows "Use the
default" too: it resolves the GLOBAL pair at the next tool boundary, exactly
as the next turn would. Before, it kept the compaction it had resolved until
the next turn. This is recorded in `docs/CHANGELOG.md` (2026-11-17) and it
supersedes the 2026-11-16 entry's "Use the default is still NOT carried ...
unchanged behaviour".

**WHAT THE CLIENT DOES NOT DO.** It does not roll the store back when the
server refuses a switch: the store mirrors the conversation's SAVED
selection, and a refused switch means the running turn did not adopt it
early. Rolling back would make the browser disagree with the row the server
just accepted.

**SILENT IS ONLY WHERE THERE IS NOTHING TO SAY.** No streaming turn for that
session (HTTP 404) and a request the user aborted with Stop report nothing:
the selection is saved, and the next turn runs on it.

**Tests:** `tests/mid-turn-switch.test.mjs` (new, 18 tests). The strongest
is "an empty payload sends NO request at all": the pre-fix client ALWAYS
fetched, so the assertion fails on the pre-fix code. Four of the eighteen
pin the ROUTE, which this change does not touch - they are characterisation
tests, and they pass on both sides.

---

### [x] BUG 9 - LOW (re-rated from Medium on 2026-11-17) - picking a model wipes the global compaction-provider pin

**Re-rated on 2026-11-17: LOW.** All four `SET_SESSION_SELECTION` dispatchers
(`ModelSelector.applySelection`, `SettingsModal`, `ReasoningEffortSelector`
and `useSlashCommands`) build their `defaults` with `compactionProviderId`
ALWAYS present, so the wipe is **unreachable in production** - only the
branch's own tests dispatch a `defaults` object without the key. It is a
typing weakness worth a one-line `=== undefined` guard, not a live bug.

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

### [x] BUG 10 - MEDIUM - the branch's central guarantee test passes while the row violates it

**FIXED 2026-11-17.** The test reads the RAW row now, so it can actually
see a half-pair - and it fails if the write path stops normalising. See
"THE FIX" at the end of this entry.

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

#### THE FIX (2026-11-17)

- `tests/session-model-selection.test.mjs` - "a row can never hold a
  compaction model without its provider" now reads the RAW SQLite row, the
  way the sibling test at `:866` already did. It is async now, because it
  opens the database itself.
- A second test pins the frame: "the announced compaction selection is the
  NORMALISED one".

**They are not vacuous.** A revert simulation - the updated test file run
against the pre-fix source - fails BOTH:

```
â— the selection in the database â€º the announced compaction selection is the NORMALISED one
â— ... â€º a row can never hold a compaction model without its provider
    expect(received).toBeNull()
    Received: "cheap-compactor"
```

The second failure is the half-pair, in the row, exactly as it was before
the fix.

---

## 5. ALSO FOUND (lower severity - not in the top 10)

| #   | Sev                       | Where                                                                                                                            | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Medium (FIXED 2026-11-18) | `src/app/api/sessions/route.ts:56` vs `src/app/api/chat/route.ts:369-371` vs `src/app/api/chat/switch-model/route.ts:69`         | The **same** request body resolves to a **different** compaction selection per endpoint. `POST /api/sessions` falls back to the conversation's **main** model; `POST /api/chat` falls back to the **global** compaction model; `switch-model` falls back to the **switched** model. Probe: the same legacy body gives `{model:'llama3', providerId:'ollama-cloud'}` on `/api/sessions` and `{model:'beam', providerId:'ollama-cloud'}` on `/api/chat`.                                                                                               |
| A2  | Medium                    | `src/app/hooks/useSessionEvents.ts:74-83`                                                                                        | A `model-changed` frame whose `compaction` is missing or unparseable is **silently repaired** to `inheritDefaultCompactionSelection()` - the exact silent repair the branch removes server-side. It also **ignores** the legacy `compactionModel`/`compactionProviderId` fields entirely: they are declared at `:57-59` and never read, so a legacy frame loses the pinned compaction model. Reachability is limited to a malformed/legacy frame, but this is the one place the client performs a silent repair.                                     |
| A3  | Medium                    | `src/app/hooks/useDataLoaders.ts:362-370`                                                                                        | The dangling-provider repair only inspects `state.model` / `state.activeProviderId`. The **compaction** half of the pair is not repaired, so a dead compaction provider blocks every turn with a 409 while the main half self-heals. The two halves of one pair now behave differently.                                                                                                                                                                                                                                                              |
| A4  | Low                       | `src/services/contextWindow/configProblem.ts:62-64`                                                                              | **FIXED 2026-11-17** with BUG 1: the "which provider _does_ serve it" hint now excludes the offending provider by ID rather than by name, so two providers sharing a name no longer hide the one that serves the model. Proven before the fix: `"The provider \"Same Name\" does not serve the model \"y\". No configured provider is known to serve it."` while provider `b` did serve `y`.                                                                                                                                                         |
| A5  | Low                       | `tests/session-model-selection.test.mjs:158-171`                                                                                 | `toStrictEqual` -> `toMatchObject` (a recursive **subset** match) on exactly the legacy-path assertions the branch's "the client keeps working" guarantee rests on. A `compaction` carrying extra fields still matches.                                                                                                                                                                                                                                                                                                                              |
| A6  | Low                       | `tests/session-model-selection.test.mjs:818`, `tests/session-compaction-pair.test.mjs:162`, `tests/compaction-rule.test.mjs:361` | `expect(x).not.toBeNull()` - passes on `undefined` and `''`. Zero weight. The **content** of every "loud" refusal is unchecked, even though the message is the whole point.                                                                                                                                                                                                                                                                                                                                                                          |
| A7  | Low                       | `tests/provider-resolution.test.mjs:130-142`                                                                                     | Source-text greps standing in for behaviour. `expect(chatRoute).toContain('providerNotConfiguredMessage')` passes even if the 409 gate is deleted; `not.toMatch(/activeProvider = null/)` is a spelling proxy that a reformatted `activeProvider = (null as ProviderConfig \| null)` would slip past.                                                                                                                                                                                                                                                |
| A8  | Low                       | `tests/provider-persistence.test.mjs:100-116`                                                                                    | The new test asserts the **echo of its own input** (`saveSessionPatch` is literally `JSON.stringify(patch)`), so it cannot prove the client never emits the flat pair.                                                                                                                                                                                                                                                                                                                                                                               |
| A9  | Low                       | `tests/session-model-selection.test.mjs:215`                                                                                     | A **deleted** assertion: the legacy-patch branch (`{compactionModel: null}`) used to be pinned and now has no unit-level test of the new refusal it produces.                                                                                                                                                                                                                                                                                                                                                                                        |
| A10 | Info                      | `docs/PROVIDER_PAIR_PLAN.md` "Verification"                                                                                      | The listed `npm test --` invocation omits the two new suites `tests/model-index` and `tests/provider-resolution`. The plan also still claims `npm run type-check` has pre-existing errors - it is now **clean** (exit 0).                                                                                                                                                                                                                                                                                                                            |
| A11 | Info                      | `tests/context-window.test.mjs:236-243`, `:256-262`                                                                              | Not touched by the branch, but still dispatch the **pre-2.3 flat shape** (`compactionModel`, `compactionProviderId`). After the dispatch `state.compaction === undefined` and `state.defaultCompactionProviderId === undefined` - the store silently accepts a state its own types forbid, and the test would keep passing after any regression in the compaction wiring.                                                                                                                                                                            |
| A12 | Low                       | `src/services/modelIndex.ts` (the TTL), `src/services/contextWindow/configProblem.ts`                                            | Found while VERIFYING the BUG 1 fix: a stale model index (a list up to 5 minutes old) can answer "not served" wrongly, and the background refresh is only kicked on "unknown", so such a refusal does NOT self-heal until the TTL expires. The MAIN-pair check already had this exposure; the BUG 1 fix adds a second pair that can refuse a whole turn on a stale answer.                                                                                                                                                                           |
| A14 | Low                       | `src/app/lib/modelSwitchRegistry.ts` (`acknowledgeModelSwitch`), `src/app/api/chat/route.ts` (`applyPendingModelSwitch`)         | A NARROW RACE found while VERIFYING the BUG 2 / BUG 3 fix: `acknowledgeModelSwitch` refuses to drop the entry when a newer request merged in during the switch, and the merge sits between the peek and the acknowledge. The merged entry then carries the refused half forward and is refused again - so the banner is set again (with the same text, so it is not visible twice) and a compaction-only second switch is lost. The window is one file read. The behaviour is LOUD, which is the branch's rule, so it is recorded rather than fixed. |
| A13 | Low                       | `src/app/api/chat/route.ts` (`applyPendingModelSwitch`), `src/app/lib/sseRouting.ts``                                            | Found while fixing BUG 2: a switch that arrives while the FINAL answer is streaming is never applied - `applyPendingModelSwitch` runs at the top of each tool-loop iteration - so no `model_switched` and no `model_switch_refused` follows it, and the "(switching...)" badge stays until the turn stops. The fix is to clear the pending flag on `done`/`error` in `sseRouting.ts`. NOT fixed here: it is a separate bug from BUG 2 and deserves its own row.                                                                                      |

---

### 5.1 Progress on the A-table (2026-11-17)

| #   | Status   | Commit / note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **done** | Decided: the global compaction model, else the main model (what the old runtime resolved). `legacyCompactionFallbackModel` is called by chat, compact, title, `POST /api/sessions` and `switch-model`. See `docs/CHANGELOG.md` 2026-11-18.                                                                                                                                                                                                                                                                                                                                              |
| A2  | **done** | `src/app/hooks/useSessionEvents.ts`: a frame with no usable compaction selection is ignored and warned about; the dead legacy field declarations are gone. Reading the legacy flat fields was NOT done (needs a server older than the browser; does not happen).                                                                                                                                                                                                                                                                                                                        |
| A3  | **done** | `71580cc`, `f27a156` and the follow-up commit - a dangling compaction provider pin is reset to "use the default", saved and reported (`APPLY_SESSION_SELECTION`, no new action). The whole repair is `planCompactionRepair` + `applyCompactionRepair` (`src/app/lib/compactionRepair.ts`, `dispatch` and `save` injected), tested end to end through the real reducer; the `useEffect` in `useDataLoaders.ts` that calls them is thin wiring and is not run by any test.                                                                                                                |
| A4  | **done** | `5db11d1` (with BUG 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A5  | **done** | `50c39c2` - the legacy-path assertions are `toStrictEqual` on the whole selection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A6  | **done** | `484d4a6` - the three `not.toBeNull()` refusal assertions check the message text. One more candidate, outside this branch: `compact-receipt.test.mjs:156`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A7  | **done** | `test(chat): drive the real chat route for the provider and switch gates` - `tests/chat-route-pair-gates.test.mjs` replaces three source-grep tests with end-to-end ones. The two gaps the review listed are now covered (2026-11-18): a refused switch that still applies its COMPACTION selection (the compaction that fires at the top of the loop must still go to the old compaction model on its own provider) and one that clears the turn's provider (a model-only second switch must stay on the provider the turn is on). Each fails with the matching mutation in the route. |
| A8  | **done** | `039a084` - reframed to what it proves; a behavioural test of the client request bodies needs pure body builders first (bodies are built inline in React callbacks). The comment's type-check claim is limited to object literals.                                                                                                                                                                                                                                                                                                                                                      |
| A9  | **done** | `b43a7bf` - unit tests for every branch of `legacyCompactionPairPatchProblem`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A10 | **done** | `56eca27` - the plan's Verification section lists every suite and the measured baseline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A11 | **done** | The two `context-window.test.mjs` dispatches now use the whole selection and defaults, and assert the store holds a compaction selection afterwards.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A12 | **done** | `11011df` - a "not served" answer kicks the index refresh too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A13 | **done** | `d893ddf` - `done` and `error` clear the "(switching...)" flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A14 | **done** | `acknowledgeModelSwitch` drops only the fields the caller peeked (per-field stamps in `modelSwitchRegistry.ts`); a request that merged after the peek stays pending alone, so a refused half no longer drags it down. See `docs/CHANGELOG.md` 2026-11-18.                                                                                                                                                                                                                                                                                                                               |

Every fix in this round was checked by an independent sub-agent before it was
committed; the reviews found a test that could not see half of its own fix
(BUG 4), a wording claim that overstated a type check (A8) and nothing else.

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

## 7. ORDER OF WORK (ALL DONE)

Everything below is done and committed on this branch (2026-11-17 and
2026-11-18). The list is kept as the record of the order it was done in.

1. **BUG 1** - DONE (`5db11d1`). The branch's own C-025(b) criterion; the
   original production incident.
2. **BUG 2 + BUG 3 + BUG 8** - DONE (`6a1e98b`). The switch is checked as a
   pair, a refused switch is refused whole, and the refusal is reported.
3. **BUG 6 + BUG 10** - DONE (`7ca24ad`), together: the write path
   normalises and the test reads the raw row.
4. **BUG 7** - DONE (`1faba56`). The server's refusal message reaches the
   user on the two write paths in `sessionSelectionClient.ts`
   (`SaveResult`, `saveFailureMessage`). `f564fc2` fixed the banner that
   promised the next turn after a refused switch.
5. **BUG 5 + A12** - DONE (`11011df`). A selection is checked as a pair
   before it is written, and a stale "not served" answer heals. The client
   half for a dangling COMPACTION provider is A3 (`71580cc`).
6. **BUG 4 + A13 + BUG 9** - DONE (`d893ddf`). `/api/dump` resolves the
   conversation's own provider and never refuses for the configuration; the
   switching badge is released at the end of the turn; a defaults object
   that omits the global compaction provider no longer wipes it.
7. **The "Also found" list (A1-A14)** - ALL DONE. See section 5.1 for the
   commit of each.

## 8. PROGRESS TRACKER

| Bug                                       | Severity    | Status | Commit                                                                               | Notes                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ----------- | ------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- |
| 1 - global compaction pair unchecked      | High        | [x]    | `fix(compaction): the inherited global pair is checked against the chat's provider`  | `compactionProblemFor` now takes the resolved main provider and checks the inherited global pair against it. `CONFIRMATIONS.md` C-030.                                                                                                                                           |
| 2 - refused switch reported as applied    | High        | [x]    | `fix(compaction): a mid-turn switch is checked as a pair, and a refusal is reported` | A refused switch is refused WHOLE and announced on the new `model_switch_refused` SSE phase; the client clears the pending flag and shows the reason.                                                                                                                            |
| 3 - mid-turn switch has no pair check     | High        | [x]    | `fix(compaction): a mid-turn switch is checked as a pair, and a refusal is reported` | `planModelSwitch` forms the pair the switch would form and puts it through the same checks a new turn is put through. The last route to the production 404.                                                                                                                      |
| 4 - /api/dump refuses a valid pair        | Medium-High | [x]    | `fix(dump): the dump never refuses for the configuration`                            | The client sends `providerId`; the route resolves by id, and the dump never refuses for the configuration (it makes no model call): it reports a removed provider, a missing window or an unreadable config in the file. A13 (badge released on `done`/`error`) shipped with it. |
| 5 - session created with a ghost provider | Medium      | [x]    | `fix(sessions): check a selection as a pair before it is written`                    | `selectionWriteProblem` checks the pair on POST and PATCH (409, names the cause, writes nothing); only the halves the write changes; pair only, never the window. A12 folded in.                                                                                                 |
| 6 - write path does not normalise         | Medium      | [x]    | `fix(compaction): the WRITE path normalises the compaction pair`                     | `selectionToColumns` now goes through `coherentCompactionPair` - the same repair the read path uses - and the `model-changed` frame carries the pair that was actually written.                                                                                                  |     |     |
| 7 - refusal messages discarded            | Medium      | [x]    | `fix(client): report the server's refusal when a selection cannot be saved`          | `saveSessionPatch` / `saveDefaultsPatch` / `saveSelectionChanges` return `SaveResult`; `saveFailureMessage` puts the server's cause in the banner headline at all five call sites.                                                                                               |
| 8 - empty mid-turn switch body            | Medium      | [x]    | `fix(compaction): a mid-turn switch is checked as a pair, and a refusal is reported` | The switch carries `compaction: {kind:"inherit-default"}`; an empty payload sends no request; the route 400 and the server SSE refusal are both reported through `SET_ERROR`.                                                                                                    |
| 9 - global compaction pin wiped           | Low         | [x]    | `fix(dump): the dump never refuses for the configuration`                            | `SET_SESSION_SELECTION` leaves `defaultCompactionProviderId` alone when the defaults omit it; `null` still clears.                                                                                                                                                               |
| 10 - guarantee test is vacuous            | Medium      | [x]    | `fix(compaction): the WRITE path normalises the compaction pair`                     | The test reads the RAW SQLite row instead of the normalised `listSessions()` projection, so it fails if the write path stops normalising. A second test pins the frame.                                                                                                          |     |     |
| A1-A14 (see section 5.1)                  | Low/Info    | partly |                                                                                      |                                                                                                                                                                                                                                                                                  |

## 9. REVIEW HYGIENE

- Every probe file used along the way was deleted. The throwaway worktrees
  (`%TEMP%\locopilot-base-check`, `%TEMP%\revert-check`, `%TEMP%\revert6`)
  were removed and `git worktree prune` was run each time.
- `git status --short` shows ONLY the four entries that pre-dated the work:
  `M next-env.d.ts` (Next.js regenerates it; it is in `.gitignore` but was
  already tracked) and the untracked `.claude/launch.json`, `.tmp-base/`,
  `config.json.tmp`. Nothing else is ever staged.
- The verification sub-agents were instructed not to touch the repo, and each
  confirmed `git status --short` was byte-identical at the end.
- The only file this scratchpad adds to the tree is this one.

---

## 10. TOOLING NOTES - how to edit this repo safely

These are the traps that actually cost time. Read them before editing a
file, not after.

### 10.1 The `patch_file` tool mangles content whose lines begin with `- `

A markdown bullet in the NEW text came out as `-- `, and two bullets were
JOINED into one line. The same happened with a line starting with `**- `.

**For markdown, use a PowerShell script file that does a LITERAL string
replacement** instead. It has no line-marker ambiguity:

```powershell
$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)
$t = [System.IO.File]::ReadAllText($path, $enc)
$work = $t.Replace("`r`n", "`n")
$count = ([regex]::Matches($work, [regex]::Escape($old))).Count
if ($count -ne 1) { throw "anchor matches $count (expected 1) - ABORT" }
$work = $work.Replace($old, $new)
$work = $work.Replace("`n", "`r`n")
[System.IO.File]::WriteAllText($path, $work, $enc)
```

The anchor-count assertion matters: it stops a replacement from silently
hitting the wrong place, or from being applied twice.

`patch_file` is fine for TypeScript source, as long as no line in the new
text starts with `- `.

### 10.2 PowerShell 5.1 reads a `.ps1` file as ANSI, not UTF-8

A non-ASCII character written into a script file arrives mangled, and the
anchor then does not match. Build the characters in code instead:

```powershell
$em    = [char]0x2014   # em dash
$arrow = [char]0x2192   # right arrow
$rsq   = [char]0x2019   # right single quote
$apos  = [char]0x0027   # plain apostrophe
```

This repo's markdown uses `â†’` (U+2192) and `â€”` (U+2014), and plain ASCII
apostrophes. Check what a file actually holds with:

```powershell
$enc = New-Object System.Text.UTF8Encoding($false)
$t = [System.IO.File]::ReadAllText($f, $enc)
$i = $t.IndexOf('needle')
$t.Substring($i, 60).ToCharArray() | ForEach-Object { "U+{0:X4}" -f [int]$_ }
```

### 10.3 `git show` through PowerShell DESTROYS the encoding

`git show HEAD:file | Out-String` pipes through the console codepage, so
every em-dash becomes `?`. That silently flattened 72 em-dashes in
`CONFIRMATIONS.md` once, and the file had to be rebuilt from HEAD.

To read HEAD's bytes safely:

```powershell
cmd /c "git show HEAD:$f > `"$env:TEMP\h.txt`""     # raw bytes, no pipeline
$h = [System.IO.File]::ReadAllText("$env:TEMP\h.txt", $enc)
```

`Get-Content` mangles non-ASCII too - use `[System.IO.File]::ReadAllText`
or the `read_file` tool.

### 10.4 A here-string terminator must be ALONE on its line

`'@; $work = ...` breaks it - the here-string swallows the rest of the
command. And a here-string inside an inline `run_command` is worse: put the
script in a `.ps1` file and run it.

### 10.5 Prettier: do NOT run it over the repo's existing markdown

The repo's markdown is NOT prettier-formatted - several tracked `.md` files
fail `npx prettier --check`, so CI's `npx prettier --check .` was already
failing on them. Running prettier over `docs/CHANGELOG.md`,
`CONFIRMATIONS.md` or `docs/PROVIDER_PAIR_PLAN.md` therefore reformats
pre-existing lines: unrelated churn in a bug-fix commit, and it once broke
a bullet in `CONFIRMATIONS.md`.

- **Do** run prettier over the source and test files you touch.
- **Do** run prettier over `docs/PROVIDER_PAIR_BUG_HUNT.md` (this file) -
  it was clean at HEAD and is meant to stay that way. Run it AFTER any edit
  made with the PowerShell script above: that script writes CRLF, and this
  file's prettier config is `endOfLine: lf`, so `prettier --check` will
  fail on a CRLF file even when the content is fine.
- **Do not** run prettier over the other three.

A `git stash` round-trip also rewrites the working tree with CRLF, which
makes a prettier-clean file look unclean (the config is `endOfLine: lf`).
Re-run prettier after any stash.

### 10.6 Other small ones

- `Get-Content "src/app/api/sessions/[id]/route.ts"` FAILS - PowerShell
  treats `[id]` as a wildcard. Use `-LiteralPath`.
- `git commit -m` with a long message gets mangled by the shell. Write the
  message to `.git/COMMIT_EDITMSG_TMP.txt` and use `git commit -F`.
- The commit convention HERE is `type(scope): summary` (e.g.
  `fix(compaction): ...`), NOT the `DT-nnn:` style other repos use.
- Do NOT stage `next-env.d.ts`: Next.js modifies it in the working tree and
  it pre-dates this work. The other three untracked entries
  (`.claude/launch.json`, `.tmp-base/`, `config.json.tmp`) are local and
  must not be committed either.
- `npx prettier --check .` reports ~1055 unclean files, almost all inside
  `.claude/worktrees/` and `.tmp-base/` (local, untracked, not in CI).
  Ignore that number.

## 11. PROVING A TEST IS NOT VACUOUS - the revert simulation

A test that passes on the pre-fix code pins nothing. This branch has a known
history of vacuous tests (findings A5-A8), so every new test needs a
revert simulation.

```powershell
$w = "$env:TEMP\revert-check"
if (Test-Path $w) { Remove-Item -Recurse -Force $w }
git worktree add --detach $w HEAD
New-Item -ItemType Junction -Path "$w\node_modules" -Target "C:\git\Locopilot-dev\node_modules"
Copy-Item tests/your-new.test.mjs "$w\tests\" -Force
cd $w
npx cross-env NODE_OPTIONS="--experimental-vm-modules --no-warnings" jest tests/your-new.test.mjs
cd C:\git\Locopilot-dev
Remove-Item -Recurse -Force $w; git worktree prune
```

A test that FAILS there is a real regression test. One that PASSES is
vacuous: strengthen it or delete it.

**The caveat, and it matters.** If the new test imports a function that did
not exist before, the whole SUITE fails to LOAD - which counts as "fails",
but it does not prove the individual assertions bite. Say that in the commit
message rather than claiming more than the simulation shows. The BUG 1 and
BUG 3 fixes both had this shape.

## 12. THE SUB-AGENT BRIEFS THAT WORKED

**Plan with one sub-agent.** Give it a SELF-CONTAINED brief: the repo path,
the branch and base, the exact goal, the design decisions already made, the
files in scope, the environment gotchas, and what to return. A very long
brief got the agent cancelled once - split it into two focused briefs
instead (the server half and the client half worked well).

**Verify with a SECOND sub-agent**, told explicitly not to touch the repo.
Ask for five things:

1. Prove it works - with quoted probe output, marked PROVEN or INFERRED.
2. Hunt for bugs it introduced or left behind, ranked, each with file:line.
3. A false-refusal sweep - every legitimate scenario, and what happens.
4. Test quality - would each NEW test catch a revert? Name the vacuous ones.
5. Doc accuracy - every claim in the new docs that the code does not support.

It found real defects every time - a destroyed CHANGELOG bullet, a vacuous
new test, two wrong doc claims, a blank-provider-id cross-wire, a stale
header. Do not skip it.

Tell it: probes under `%TEMP%` only, no `git add/commit/stash/checkout/
restore/reset`, and that `git status --short` must be identical at the end.

## 13. WHAT THE BRANCH LOOKS LIKE NOW

Twenty-six commits on top of `origin/dev` (`git log --oneline origin/dev..HEAD`
is the authority; this list is a snapshot of 2026-11-18, newest first):

```
d8203fe fix(switch): a mid-turn switch that merges during an apply is answered on its own (A14)
f27a156 test(client): test the A3 repair decision, and stop two tests using the flat shape (A11)
71580cc fix(client): reset a compaction pin that names a removed provider (A3)
c7e7b60 fix(client): ignore a model-changed frame with no usable compaction selection (A2)
c8c3fa8 docs(provider-pair): record the A1 commit in the bug hunt status line
8d48a58 fix(compaction): one fallback model for a legacy provider-only pin, at every endpoint (A1)
8cdea95 test(chat): drive the real chat route for the provider and switch gates (A7)
039a084 test(selection): the flat-pair persistence test claims only what it proves (A8)
b43a7bf test(selection): unit-pin the refusal of a half-pair in a legacy patch (A9)
484d4a6 test(selection): the refusal tests check what the message says (A6)
50c39c2 test(selection): the legacy-path assertions compare the whole object (A5)
56eca27 docs(provider-pair): the plan's Verification section lists every suite and the current baseline
d893ddf fix(dump): the dump never refuses for the configuration
11011df fix(sessions): check a selection as a pair before it is written
1faba56 fix(client): report the server's refusal when a selection cannot be saved
f564fc2 fix(compaction): a refused mid-turn switch no longer promises the next turn
f92fc8f docs(provider-pair): the bug hunt scratchpad becomes the handoff for the next session
7ca24ad fix(compaction): the WRITE path normalises the compaction pair
6a1e98b fix(compaction): a mid-turn switch is checked as a pair, and a refusal is reported
5db11d1 fix(compaction): the inherited global pair is checked against the chat's provider
293577e docs(provider-pair): record the bug hunt findings as a scratchpad
1efe87e feat(compaction): the store and the wire carry the selection as ONE value
b65f097 feat(compaction): the compaction model and its provider are ONE value
2b7f18e feat(provider): validate the (model, provider) pair against a cached model index
29c5a12 fix(provider): resolve a stale provider id by id ONLY, and refuse it by name
6de53ed feat(compaction): one rule decides the compaction model AND its provider
```

The five `feat`/`fix(provider)` commits at the bottom (`6de53ed` to
`1efe87e`) are the branch itself; everything above `293577e` is the bug hunt.

Test numbers: the last FULL `npm test` run was 86 suites, 2196 passed, 2
skipped (the BUG 4 round, 2026-11-17; 2200 passed at the start of the A5-A10
round, see `docs/PROVIDER_PAIR_PLAN.md` "Verification" for the baseline). The
A1, A2, A3, A11 and A14 commits ran only the suites they touched, and the
earlier "21 failing suites" figure was a Windows measurement, not the Linux
baseline. `tests/chat-route-pair-gates.test.mjs` used to be one of the suites
that cannot load on the Windows development machine (Node 22); it now stubs
jsdom, runs there (7 passed, 2026-11-18) and also covers the two A7 gaps.
`tests/subagent-traces-route.test.mjs` still fails to load on Node 22, with
the identical error on the original helper; run it on Node 24.9+ before the
branch closes.
