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
 * The rule now: the SERVER decides the window (the setting capped by the
 * model's maximum) and the page shows what it reports; until the server has
 * answered the UI shows "—". The page sends no numCtx and computes no minimum.
 * There is no placeholder.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatReducer, initialState } from '../src/app/lib/chatStore.ts';
import {
  describeContextWindow,
  interpretNumCtxInput,
  isStaleNumCtxAnswer,
  NUMCTX_FOCUS_REFETCH_MS,
  positiveInteger,
  shouldRefetchNumCtx,
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
  return describeContextWindow({
    effective: state.effectiveNumCtx,
    modelMax: state.modelMaxNumCtx,
  });
}

/** The server's answer to GET /api/numctx, as the page stores it. */
function serverAnswer(state, { effective, modelMax }) {
  return chatReducer(state, {
    type: 'SET_TOKEN_STATS',
    stats: {
      ...(effective === null ? {} : { tokenLimit: effective }),
      modelContextLimit: modelMax,
    },
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

// ── describeContextWindow ──────────────────────────────────────────────────
check('until the server answers there is no window, and nothing is invented', () => {
  const none = { limit: null, cappedAt: null, maxUnknown: false };
  assert.deepEqual(describeContextWindow({}), none);
  assert.deepEqual(describeContextWindow({ effective: null, modelMax: null }), none);
  assert.deepEqual(describeContextWindow({ effective: null, modelMax: 262_144 }), none);
  assert.deepEqual(describeContextWindow({ effective: 0 }), none);
});

check('the window shown is the server window, whatever the page setting is', () => {
  // The page has no setting input at all: a provider's own window can differ
  // from the global one, and only the server knows which applies.
  assert.equal(describeContextWindow({ effective: 300_000, modelMax: 1_048_576 }).limit, 300_000);
  assert.equal(describeContextWindow({ effective: 40_960, modelMax: 40_960 }).limit, 40_960);
});

check('a maximum below the setting labels the window; a higher one does not', () => {
  assert.deepEqual(describeContextWindow({ effective: 262_144, modelMax: 262_144 }), {
    limit: 262_144,
    cappedAt: 262_144,
    maxUnknown: false,
  });
  assert.deepEqual(describeContextWindow({ effective: 300_000, modelMax: 1_000_000 }), {
    limit: 300_000,
    cappedAt: null,
    maxUnknown: false,
  });
});

check('a server that answered without a maximum is "model max unknown"', () => {
  assert.deepEqual(describeContextWindow({ effective: 300_000, modelMax: null }), {
    limit: 300_000,
    cappedAt: null,
    maxUnknown: true,
  });
  assert.equal(describeContextWindow({ effective: 300_000 }).maxUnknown, true);
});

check('zeros, negatives and NaN count as no answer', () => {
  assert.equal(describeContextWindow({ effective: 0, modelMax: 0 }).limit, null);
  assert.equal(describeContextWindow({ effective: -3 }).limit, null);
  assert.equal(describeContextWindow({ effective: Number.NaN }).limit, null);
  // A nonsense maximum is no maximum, not a cap.
  assert.deepEqual(describeContextWindow({ effective: 1000, modelMax: -5 }), {
    limit: 1000,
    cappedAt: null,
    maxUnknown: true,
  });
});

// ── the refetch rules ──────────────────────────────────────────────────────
check('a focus asks the server again at most every 30 seconds', () => {
  assert.equal(NUMCTX_FOCUS_REFETCH_MS, 30_000);
  assert.equal(shouldRefetchNumCtx(1_000, null), true, 'never fetched');
  assert.equal(shouldRefetchNumCtx(1_000 + 29_999, 1_000), false, 'inside the window');
  assert.equal(shouldRefetchNumCtx(1_000 + 30_000, 1_000), true, 'at the window');
  assert.equal(shouldRefetchNumCtx(1_000 + 600_000, 1_000), true, 'long after');
});

check('an answer for a model that is no longer selected is stale', () => {
  const asked = { model: 'a', providerId: 'p1' };
  assert.equal(isStaleNumCtxAnswer(asked, { model: 'a', providerId: 'p1' }), false);
  assert.equal(isStaleNumCtxAnswer(asked, { model: 'b', providerId: 'p1' }), true);
  assert.equal(isStaleNumCtxAnswer(asked, { model: 'a', providerId: 'p2' }), true);
  assert.equal(
    isStaleNumCtxAnswer({ model: 'a', providerId: null }, { model: 'a', providerId: 'p1' }),
    true
  );
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
  assert.deepEqual(windowOf(initialState), { limit: null, cappedAt: null, maxUnknown: false });
});

check('SET_CONFIG without a context size leaves the setting unknown', () => {
  const state = chatReducer(initialState, { type: 'SET_CONFIG', config: { yolo: true } });
  assert.equal(state.requestedNumCtx, null);
});

check(
  'replay: the saved count arrives BEFORE the config — never 131072, ends at the server window',
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

    // Then the config arrives. The page's setting is not a window: the bar
    // still waits for the server rather than showing the setting.
    state = chatReducer(state, { type: 'SET_CONFIG', config: { requestedNumCtx: 1_000_000 } });
    assert.equal(windowOf(state).limit, null, 'the setting was shown as the window');

    // Then the server answers.
    state = serverAnswer(state, { effective: 1_000_000, modelMax: 1_048_576 });
    assert.deepEqual(windowOf(state), { limit: 1_000_000, cappedAt: null, maxUnknown: false });
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
  assert.deepEqual(windowOf(state), { limit: 262_144, cappedAt: 262_144, maxUnknown: false });

  // Re-selecting the same model must not forget what the server reported.
  const same = chatReducer(state, { type: 'SET_MODEL', model: 'small' });
  assert.equal(same.tokenStats.modelContextLimit, 262_144);
  assert.equal(same.modelMaxNumCtx, 262_144);
  assert.equal(same.effectiveNumCtx, state.effectiveNumCtx);
  const sameProvider = chatReducer(state, { type: 'SET_ACTIVE_PROVIDER', providerId: 'p1' });
  assert.equal(sameProvider.tokenStats.modelContextLimit, 262_144);

  // A real change drops the previous model's maximum and window: the bar shows
  // "—" until the server answers for the new model.
  for (const next of [
    chatReducer(state, { type: 'SET_MODEL', model: 'big' }),
    chatReducer(state, { type: 'SET_ACTIVE_PROVIDER', providerId: 'p2' }),
    chatReducer(state, { type: 'SET_CONFIG', config: { model: 'big' } }),
    chatReducer(state, { type: 'SET_CONFIG', config: { activeProviderId: 'p2' } }),
  ]) {
    assert.equal(next.tokenStats.modelContextLimit, null);
    assert.equal(next.modelMaxNumCtx, null);
    assert.equal(next.effectiveNumCtx, null);
    assert.deepEqual(windowOf(next), { limit: null, cappedAt: null, maxUnknown: false });
    assert.equal(next.tokenStats.totalTokens, 11, 'the count is not the model maximum');
    // The server then answers for the new model.
    const answered = serverAnswer(next, { effective: 1_000_000, modelMax: 2_000_000 });
    assert.deepEqual(windowOf(answered), { limit: 1_000_000, cappedAt: null, maxUnknown: false });
  }

  // A SET_CONFIG that does not change the selection leaves the maximum alone.
  const unrelated = chatReducer(state, {
    type: 'SET_CONFIG',
    config: { model: 'small', yolo: true },
  });
  assert.equal(unrelated.tokenStats.modelContextLimit, 262_144);
  assert.equal(unrelated.modelMaxNumCtx, 262_144);
});

check('the window and the maximum survive a cleared token count and a conversation switch', () => {
  // The maximum belongs to the selected MODEL, not to a conversation's token
  // stats. If it lived only in the stats, a conversation with no saved stats
  // would show a window and no maximum, and the bar would claim "model max
  // unknown" for a model whose maximum the server had reported.
  let state = chatReducer(initialState, {
    type: 'SET_CONFIG',
    config: { model: 'm', activeProviderId: 'p1' },
  });
  state = serverAnswer(state, { effective: 262_144, modelMax: 262_144 });
  const expected = { limit: 262_144, cappedAt: 262_144, maxUnknown: false };
  assert.deepEqual(windowOf(state), expected);

  state = chatReducer(state, { type: 'CLEAR_TOKEN_STATS' });
  assert.deepEqual(windowOf(state), expected, 'a cleared count dropped the maximum');

  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 5 });
  assert.deepEqual(windowOf(state), expected, 'switching conversation dropped the maximum');
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 6 });
  state = chatReducer(state, { type: 'CLEAR_TOKEN_STATS' });
  assert.deepEqual(windowOf(state), expected, 'a conversation with no saved stats lost it');
});

check('an update without the maximum leaves it alone; only an explicit null clears it', () => {
  let state = serverAnswer(initialState, { effective: 262_144, modelMax: 262_144 });
  // A turn's status event that carries a window but no maximum field.
  state = chatReducer(state, {
    type: 'SET_TOKEN_STATS',
    stats: { promptEvalCount: 5, evalCount: 5, totalTokens: 10, tokenLimit: 262_144 },
  });
  assert.equal(state.modelMaxNumCtx, 262_144, 'an absent field was read as "unknown"');
  // The server explicitly says it knows none.
  state = chatReducer(state, {
    type: 'SET_TOKEN_STATS',
    stats: { promptEvalCount: 5, evalCount: 5, totalTokens: 10, modelContextLimit: null },
  });
  assert.equal(state.modelMaxNumCtx, null);
  assert.equal(windowOf(state).maxUnknown, true);
});

check('the server answer seeds the window and the maximum without touching the count', () => {
  let state = chatReducer(initialState, {
    type: 'SET_TOKEN_STATS',
    stats: { promptEvalCount: 100, evalCount: 5, totalTokens: 105, isEstimated: false },
  });
  state = serverAnswer(state, { effective: 300_000, modelMax: null });
  assert.equal(state.effectiveNumCtx, 300_000);
  assert.equal(state.tokenStats.modelContextLimit, null);
  assert.equal(state.modelMaxNumCtx, null);
  assert.deepEqual(windowOf(state), { limit: 300_000, cappedAt: null, maxUnknown: true });
  assert.equal(state.tokenStats.totalTokens, 105, 'the count was clobbered');
  assert.equal(state.tokenStats.promptEvalCount, 100);
  // A server with no setting at all sends no window: the bar keeps showing "—".
  const none = serverAnswer(initialState, { effective: null, modelMax: 262_144 });
  assert.equal(none.effectiveNumCtx, null);
  assert.equal(windowOf(none).limit, null);
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

check('no request the page makes carries a context window', () => {
  for (const file of clientFiles) {
    const code = read(file)
      .replaceAll(/\/\*[\S\s]*?\*\//g, '')
      .replaceAll(/^\s*\/\/.*$/gm, '');
    assert.ok(!/requestedNumCtxRef/.test(code), `${file} reads the requested-size ref`);
    if (file === 'src/app/lib/contextWindow.ts') continue;
    assert.ok(!/numCtxField\(/.test(code), `${file} still adds numCtx to a body`);
    // `/ctx` saves the SETTING to the config; that is the one body allowed.
    const withoutSettingSave = code.replace('JSON.stringify({ numCtx: size })', '');
    assert.ok(!/\bnumCtx:\s/.test(withoutSettingSave), `${file} builds a body with numCtx`);
  }
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

check('the status bar shows what the server reported and infers nothing', () => {
  const bar = read('src/components/StatusBar/StatusBar.tsx');
  assert.ok(bar.includes('describeContextWindow('));
  assert.ok(bar.includes('modelMaxNumCtx'), 'the bar reads a per-conversation maximum');
  assert.ok(!bar.includes('modelContextLimit'), 'the bar reads the per-conversation stats');
  assert.ok(!bar.includes('requestedNumCtx'), 'the bar reads the page setting');
  assert.ok(bar.includes('(model max unknown)'), 'no label for an unknown maximum');
  assert.ok(!/effectiveNumCtx\s*<\s*requestedNumCtx/.test(bar), 'a stale value is read as a cap');
  assert.ok(!/tokenStats\?\.tokenLimit\s*\|\|/.test(bar), 'the snapshot beats the server again');
});

check('/ctx saves the setting BEFORE the page changes, so the refetch it causes reads it', () => {
  const slash = read('src/app/hooks/useSlashCommands.ts');
  const block = slash.slice(slash.indexOf("case 'ctx': {"), slash.indexOf("case 'ctx': {") + 1500);
  const save = block.indexOf("fetch('/api/config'");
  const show = block.indexOf("type: 'SET_CONFIG'");
  assert.ok(save !== -1 && show !== -1, 'the /ctx handler changed shape');
  assert.ok(save < show, 'the page is updated before the setting is saved');
});

check('the page asks the server for the window and keeps it current', () => {
  const loaders = read('src/app/hooks/useDataLoaders.ts');
  assert.ok(
    loaders.includes('`/api/numctx?${params.toString()}`'),
    'loadNumCtx does not call the endpoint'
  );
  assert.ok(loaders.includes('isStaleNumCtxAnswer('), 'a late answer for another model is used');
  assert.ok(loaders.includes('loadNumCtx,'), 'loadNumCtx is not returned');
  assert.ok(!loaders.includes('data.modelContextLimit'), 'config still seeds the maximum');
  const sync = read('src/app/hooks/useNumCtxSync.ts');
  assert.ok(
    /\[loadNumCtx, model, providerId, requestedNumCtx]/.test(sync),
    'not re-asked on change'
  );
  assert.ok(sync.includes("addEventListener('focus'"), 'not re-asked on focus');
  assert.ok(sync.includes('shouldRefetchNumCtx('), 'focus is not throttled');
  assert.ok(
    read('src/app/page.tsx').includes('useNumCtxSync(loadNumCtx'),
    'the page does not use it'
  );
});

check('GET /api/config does not probe a provider, so reading it never waits on one', () => {
  const route = read('src/app/api/config/route.ts');
  assert.ok(!route.includes('resolveNumCtx'), 'the config route resolves a window');
  assert.ok(!route.includes('modelContextLimit'), 'the config route still reports a maximum');
});

check('the page never computes a minimum', () => {
  for (const file of [
    'src/app/lib/contextWindow.ts',
    'src/components/StatusBar/StatusBar.tsx',
    'src/components/SettingsModal/SettingsModal.tsx',
    'src/app/hooks/useDataLoaders.ts',
  ]) {
    const code = read(file)
      .replaceAll(/\/\*[\S\s]*?\*\//g, '')
      .replaceAll(/^\s*\/\/.*$/gm, '');
    assert.ok(!/Math\.min\(/.test(code), `${file} computes a minimum`);
  }
});

// ── Retry and the mid-turn switch use the setting as it is now ─────────────
check('the route resolves a mid-turn switch from the saved setting, not the body', () => {
  const route = read('src/app/api/chat/route.ts');
  assert.ok(route.includes('resolveNumCtxForModel(true)'), 'the switch does not pass the flag');
  assert.ok(
    /fromSavedSetting \? await loadConfig\(\)/.test(route),
    'the switch does not re-read the saved config'
  );
  assert.ok(!route.includes('bodyRequested'), 'the body value is still an input');
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

check('Retry replays the stored body, which carries no window', () => {
  const hook = read('src/app/hooks/useChatStream.ts');
  assert.ok(hook.includes('const body = stored;'), 'retry does not replay the stored body');
  assert.ok(!hook.includes('withCurrentNumCtx'), 'retry still rewrites the window');
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
