#!/usr/bin/env node
/**
 * Tests for the client's context window (src/app/lib/contextWindow.ts and the
 * places that use it).
 *
 * Run with: npx tsx scripts/test-context-window.mjs
 *
 * No network, no server, no React: the rules are pure, and the store's
 * reducer is a pure function.
 *
 * Regression focus: the client kept a stand-in value (`DEFAULT_NUM_CTX`,
 * 131 072) for "the config has not loaded yet". It leaked three ways:
 *
 *   - the status bar: a reloaded session showed "276922/131072 tokens (211%)"
 *     for a model that supports 1 000 000, because the saved count arrived
 *     BEFORE the config and was stamped with the stand-in, which the reducer
 *     then promoted into `effectiveNumCtx` as if the server had reported it;
 *   - Settings: a blank field became the stand-in and was saved into
 *     config.json;
 *   - request bodies: the stand-in was sent as `numCtx`, and the server trusts
 *     a body value over the persisted config.
 *
 * The rule now: the window shown (and sent) is the user's setting, unless the
 * model's reported maximum is lower; while either is unknown the UI shows
 * "—" and the body omits the field. There is no placeholder.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatReducer, initialState } from '../src/app/lib/chatStore.ts';
import {
  interpretNumCtxInput,
  numCtxField,
  positiveInteger,
  resolveContextWindow,
  withCurrentNumCtx,
} from '../src/app/lib/contextWindow.ts';
import { routeSseEvent } from '../src/app/lib/sseRouting.ts';

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message.split('\n').join('\n        ')}`);
    fail += 1;
  }
}

const PLACEHOLDER = 131072;

/** What the status bar derives from a store state. */
function windowOf(state) {
  return resolveContextWindow({
    requested: state.requestedNumCtx,
    modelMax: state.tokenStats?.modelContextLimit,
    reportedLimit: state.tokenStats?.tokenLimit,
    effective: state.effectiveNumCtx,
  });
}

// ── positiveInteger ────────────────────────────────────────────────────────
check('positiveInteger accepts only positive safe integers', () => {
  assert.equal(positiveInteger(1), 1);
  assert.equal(positiveInteger(1_000_000), 1_000_000);
  for (const bad of [0, -1, 1.5, Number.NaN, Infinity, '1000', null, undefined, {}, 2 ** 60]) {
    assert.equal(positiveInteger(bad), null, `${String(bad)} was accepted`);
  }
});

// ── resolveContextWindow ───────────────────────────────────────────────────
check('the setting wins when the model maximum is unknown or higher', () => {
  assert.deepEqual(resolveContextWindow({ requested: 1_000_000 }), {
    limit: 1_000_000,
    cappedAt: null,
  });
  assert.deepEqual(resolveContextWindow({ requested: 200_000, modelMax: 1_000_000 }), {
    limit: 200_000,
    cappedAt: null,
  });
  assert.deepEqual(resolveContextWindow({ requested: 200_000, modelMax: 200_000 }), {
    limit: 200_000,
    cappedAt: null,
  });
});

check('a lower model maximum is shown and used instead', () => {
  assert.deepEqual(resolveContextWindow({ requested: 1_000_000, modelMax: 262_144 }), {
    limit: 262_144,
    cappedAt: 262_144,
  });
});

check('a per-turn snapshot never beats a setting the user has since changed', () => {
  // The server reported 1 000 000 for the last turn; the user then lowered the
  // setting to 500 000. The display follows the setting, not the snapshot.
  assert.deepEqual(
    resolveContextWindow({ requested: 500_000, reportedLimit: 1_000_000, effective: 1_000_000 }),
    { limit: 500_000, cappedAt: null }
  );
});

check('while the setting is unknown the server-reported window is used, never a default', () => {
  assert.deepEqual(resolveContextWindow({ requested: null }), { limit: null, cappedAt: null });
  assert.deepEqual(resolveContextWindow({ requested: null, reportedLimit: 0 }), {
    limit: null,
    cappedAt: null,
  });
  assert.equal(resolveContextWindow({ requested: null, reportedLimit: 300_000 }).limit, 300_000);
  assert.equal(resolveContextWindow({ requested: null, effective: 262_144 }).limit, 262_144);
  assert.equal(
    resolveContextWindow({ requested: null, reportedLimit: 300_000, effective: 262_144 }).limit,
    300_000
  );
});

check('zeros, negatives and NaN count as unknown', () => {
  assert.deepEqual(resolveContextWindow({ requested: 0, modelMax: 0 }), {
    limit: null,
    cappedAt: null,
  });
  assert.deepEqual(resolveContextWindow({ requested: 1000, modelMax: -5 }), {
    limit: 1000,
    cappedAt: null,
  });
  assert.deepEqual(resolveContextWindow({ requested: 1000, modelMax: Number.NaN }), {
    limit: 1000,
    cappedAt: null,
  });
});

// ── numCtxField ────────────────────────────────────────────────────────────
check('the request body carries numCtx only when the setting is known', () => {
  assert.deepEqual(numCtxField(1_000_000), { numCtx: 1_000_000 });
  assert.deepEqual(numCtxField(null), {});
  assert.deepEqual(numCtxField(0), {});
  assert.ok(!JSON.stringify({ a: 1, ...numCtxField(null) }).includes('numCtx'));
});

// ── interpretNumCtxInput (the Settings field) ──────────────────────────────
check('the Settings field is never turned into a default', () => {
  // The old `parseInt(text) || DEFAULT_NUM_CTX` saved 131072 for all of these.
  for (const text of ['', '  ', 'abc', '0', '-5', '12.5', '1e6', '0x10', '10 000', '٣']) {
    const result = interpretNumCtxInput(text, 1_000_000);
    assert.equal(result.kind, 'invalid', `${JSON.stringify(text)} was not rejected`);
  }
  for (const text of ['abc', '0', '-5', '12.5', '1e6']) {
    assert.equal(interpretNumCtxInput(text, null).kind, 'invalid');
  }
});

check('a blank field while the setting is still unknown means "unchanged"', () => {
  assert.deepEqual(interpretNumCtxInput('', null), { kind: 'unchanged' });
  assert.deepEqual(interpretNumCtxInput('   ', null), { kind: 'unchanged' });
});

check('an unchanged value is not written; a changed one is', () => {
  assert.deepEqual(interpretNumCtxInput('1000000', 1_000_000), { kind: 'unchanged' });
  assert.deepEqual(interpretNumCtxInput(' 500000 ', 1_000_000), { kind: 'set', value: 500_000 });
  assert.deepEqual(interpretNumCtxInput('0200000', null), { kind: 'set', value: 200_000 });
  assert.equal(interpretNumCtxInput('9007199254740993', null).kind, 'invalid');
});

// ── the store: no placeholder, and the sequence that failed ────────────────
check('the store starts with no setting and no window', () => {
  assert.equal(initialState.requestedNumCtx, null);
  assert.equal(initialState.effectiveNumCtx, null);
  assert.deepEqual(windowOf(initialState), { limit: null, cappedAt: null });
});

check('SET_CONFIG without a context size leaves the setting unknown', () => {
  const state = chatReducer(initialState, { type: 'SET_CONFIG', config: { yolo: true } });
  assert.equal(state.requestedNumCtx, null);
});

check(
  'replay: the saved count arrives BEFORE the config — never 131072, ends at the setting',
  () => {
    let state = initialState;
    // Reload of ?session=522: the database count arrives first. The loader no
    // longer writes a `tokenLimit` it does not know, so the key is absent.
    state = chatReducer(state, {
      type: 'SET_TOKEN_STATS',
      stats: {
        promptEvalCount: 274_721,
        evalCount: 2201,
        totalTokens: 276_922,
        isEstimated: false,
      },
    });
    assert.equal(windowOf(state).limit, null, 'a window was invented before the config loaded');
    assert.notEqual(windowOf(state).limit, PLACEHOLDER);
    assert.equal(state.effectiveNumCtx, null, 'nothing may be promoted into effectiveNumCtx');

    // Then the config arrives.
    state = chatReducer(state, { type: 'SET_CONFIG', config: { requestedNumCtx: 1_000_000 } });
    assert.deepEqual(windowOf(state), { limit: 1_000_000, cappedAt: null });
    assert.equal(state.tokenStats.totalTokens, 276_922, 'the saved count must survive');
  }
);

check('replay: a model maximum below the setting is shown, and clears on a model change', () => {
  let state = chatReducer(initialState, {
    type: 'SET_CONFIG',
    config: { requestedNumCtx: 1_000_000, model: 'small', activeProviderId: 'p1' },
  });
  state = chatReducer(state, {
    type: 'SET_TOKEN_STATS',
    stats: {
      promptEvalCount: 10,
      evalCount: 1,
      totalTokens: 11,
      tokenLimit: 262_144,
      modelContextLimit: 262_144,
    },
  });
  assert.deepEqual(windowOf(state), { limit: 262_144, cappedAt: 262_144 });

  // Re-selecting the same model must not forget what the server reported.
  const same = chatReducer(state, { type: 'SET_MODEL', model: 'small' });
  assert.equal(same.tokenStats.modelContextLimit, 262_144);
  assert.equal(same.effectiveNumCtx, state.effectiveNumCtx);
  const sameProvider = chatReducer(state, { type: 'SET_ACTIVE_PROVIDER', providerId: 'p1' });
  assert.equal(sameProvider.tokenStats.modelContextLimit, 262_144);

  // A real change drops the previous model's maximum and window.
  for (const next of [
    chatReducer(state, { type: 'SET_MODEL', model: 'big' }),
    chatReducer(state, { type: 'SET_ACTIVE_PROVIDER', providerId: 'p2' }),
    chatReducer(state, { type: 'SET_CONFIG', config: { model: 'big' } }),
    chatReducer(state, { type: 'SET_CONFIG', config: { activeProviderId: 'p2' } }),
  ]) {
    assert.equal(next.tokenStats.modelContextLimit, null);
    assert.equal(next.effectiveNumCtx, null);
    assert.deepEqual(windowOf(next), { limit: 1_000_000, cappedAt: null });
    assert.equal(next.tokenStats.totalTokens, 11, 'the count is not the model maximum');
  }

  // A SET_CONFIG that does not change the selection leaves the maximum alone.
  const unrelated = chatReducer(state, {
    type: 'SET_CONFIG',
    config: { model: 'small', yolo: true },
  });
  assert.equal(unrelated.tokenStats.modelContextLimit, 262_144);
});

check('a status merge without a limit keeps a limit the server already reported', () => {
  let state = chatReducer(initialState, {
    type: 'SET_TOKEN_STATS',
    stats: { promptEvalCount: 1, evalCount: 1, totalTokens: 2, tokenLimit: 500_000 },
  });
  assert.equal(state.effectiveNumCtx, 500_000);
  state = chatReducer(state, {
    type: 'SET_TOKEN_STATS',
    stats: { promptEvalCount: 5, evalCount: 5, totalTokens: 10 },
  });
  assert.equal(state.tokenStats.tokenLimit, 500_000, 'an absent key must not overwrite');
  assert.equal(state.effectiveNumCtx, 500_000);
});

// ── the compact frame ──────────────────────────────────────────────────────
check('a compact frame without a window leaves the limit unknown (no stand-in)', () => {
  const { actions } = routeSseEvent(
    'compact',
    { stats: { oldTokenCount: 1000, newTokenCount: 300 }, messages: [] },
    { targetSessionId: 7, compactOwner: 7 }
  );
  const stats = actions.find((a) => a.type === 'SET_TOKEN_STATS');
  assert.ok(stats, 'no SET_TOKEN_STATS action');
  assert.ok(!('tokenLimit' in stats.stats), 'a tokenLimit was invented');
  assert.equal(stats.stats.totalTokens, 300);
});

check('a compact frame with a window carries exactly that window', () => {
  const { actions } = routeSseEvent(
    'compact',
    { stats: { oldTokenCount: 1000, newTokenCount: 300 }, messages: [], tokenLimit: 262_144 },
    { targetSessionId: 7, compactOwner: 7 }
  );
  assert.equal(actions.find((a) => a.type === 'SET_TOKEN_STATS').stats.tokenLimit, 262_144);
});

// ── the wiring that must stay ──────────────────────────────────────────────
// The hooks and components cannot run without React, so the source is read.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) =>
  fs.readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n');

const clientFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(relative);
    else if (/\.(ts|tsx)$/.test(entry.name)) clientFiles.push(relative);
  }
})('src/app/hooks');
for (const dir of ['src/components']) {
  (function walk(d) {
    for (const entry of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const relative = `${d}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (/\.(ts|tsx)$/.test(entry.name)) clientFiles.push(relative);
    }
  })(dir);
}
clientFiles.push(
  'src/app/lib/chatStore.ts',
  'src/app/lib/sseRouting.ts',
  'src/app/lib/contextWindow.ts'
);

check('no client file imports or uses DEFAULT_NUM_CTX', () => {
  const offenders = clientFiles.filter((file) => {
    // Comments may explain the history; code may not use the constant.
    const code = read(file)
      .replaceAll(/\/\*[\S\s]*?\*\//g, '')
      .replaceAll(/^\s*\/\/.*$/gm, '');
    return /DEFAULT_NUM_CTX/.test(code);
  });
  assert.deepEqual(offenders, []);
});

check('no request body sends the raw requested value', () => {
  const offenders = clientFiles.filter((file) =>
    /numCtx:\s*refs\.requestedNumCtxRef\.current/.test(read(file))
  );
  assert.deepEqual(offenders, [], 'use numCtxField(...) so an unknown setting is omitted');
  assert.ok(read('src/app/hooks/useChatStream.ts').includes('...numCtxField('));
  const slash = read('src/app/hooks/useSlashCommands.ts');
  assert.equal((slash.match(/\.{3}numCtxField\(/g) ?? []).length, 3, '/compact, /title, /dump');
});

check('the loaders never write the setting or a default as a token limit', () => {
  const loaders = read('src/app/hooks/useDataLoaders.ts');
  assert.ok(!loaders.includes('requestedNumCtxRef.current'), 'a loader reads the requested ref');
  assert.ok(!/\?\?\s*state\.requestedNumCtx/.test(loaders), 'loadConfig re-asserts the closure');
  // Every SET_TOKEN_STATS from a loader leaves the key out when unknown.
  assert.equal(
    (loaders.match(/\.{3}\(knownLimit ={3} undefined \? {} : { tokenLimit: knownLimit }\)/g) ?? [])
      .length,
    3,
    'the three loadSessionMessages branches'
  );
});

check('Settings validates the context size instead of defaulting it', () => {
  const settings = read('src/components/SettingsModal/SettingsModal.tsx');
  assert.ok(settings.includes('interpretNumCtxInput('));
  assert.ok(!/parseInt\(numCtx\)/.test(settings), 'the lenient parse is back');
  assert.ok(!settings.includes('numCtxChanged'), 'the old compare-with-state check is back');
});

check('the status bar derives its window from the setting and the model maximum only', () => {
  const bar = read('src/components/StatusBar/StatusBar.tsx');
  assert.ok(bar.includes('resolveContextWindow('));
  assert.ok(!/effectiveNumCtx\s*<\s*requestedNumCtx/.test(bar), 'a stale value is read as a cap');
  assert.ok(!/tokenStats\?\.tokenLimit\s*\|\|/.test(bar), 'the snapshot beats the setting again');
});

// ── Retry and the mid-turn switch use the setting as it is now ─────────────
check('Retry replaces the stored window with the current setting', () => {
  const stored = JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'm',
    numCtx: 1_000_000,
  });
  const replayed = JSON.parse(withCurrentNumCtx(stored, 300_000));
  assert.equal(replayed.numCtx, 300_000, 'the old window was replayed');
  assert.equal(replayed.model, 'm', 'other fields must survive');
  assert.deepEqual(replayed.messages, [{ role: 'user', content: 'hi' }]);
});

check('Retry drops the stored window when the setting is unknown', () => {
  const stored = JSON.stringify({ model: 'm', numCtx: 1_000_000 });
  assert.equal('numCtx' in JSON.parse(withCurrentNumCtx(stored, null)), false);
});

check('Retry adds the setting when the stored body had none, and leaves non-objects alone', () => {
  const plain = JSON.stringify({ model: 'm' });
  assert.equal(JSON.parse(withCurrentNumCtx(plain, 500_000)).numCtx, 500_000);
  assert.equal(withCurrentNumCtx('not json', 500_000), 'not json');
  assert.equal(withCurrentNumCtx('[1,2]', 500_000), '[1,2]');
  assert.equal(withCurrentNumCtx('null', 500_000), 'null');
});

check('the route resolves a mid-turn switch from the saved setting, not the body', () => {
  const route = read('src/app/api/chat/route.ts');
  assert.ok(
    route.includes('await resolveNumCtxForModel(true);'),
    'the switch does not pass the flag'
  );
  assert.ok(
    /const bodyRequested =\s*!fromSavedSetting/.test(route),
    'the body value is not ignored at the switch'
  );
  assert.ok(route.includes("phase: 'config_unavailable'"), 'a config fallback is not logged');
});

check('the page warns when the config cannot be loaded', () => {
  const loaders = read('src/app/hooks/useDataLoaders.ts');
  assert.ok(
    loaders.includes('Config could not be loaded (HTTP'),
    'no warning for a failed response'
  );
  assert.ok(
    loaders.includes("console.warn('Config could not be loaded:'"),
    'no warning for a thrown error'
  );
});

check('Retry rebuilds the body from the current setting', () => {
  const hook = read('src/app/hooks/useChatStream.ts');
  assert.ok(hook.includes('withCurrentNumCtx(stored, refs.requestedNumCtxRef.current)'));
});

check('the route logs a missing or unreadable config, not only a thrown one', () => {
  const route = read('src/app/api/chat/route.ts');
  // loadConfig() returns null instead of throwing, so the catch alone never sees it.
  assert.ok(
    /if \(config === null\) {[\S\s]*?phase: 'config_unavailable'/.test(route),
    'a null config is not logged'
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
