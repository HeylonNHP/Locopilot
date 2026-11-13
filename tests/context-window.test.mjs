/**
 * Tests for the client's context window (src/app/lib/contextWindow.ts and the
 * places that use it).
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

import { describe, expect, test } from '@jest/globals';
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

describe('positiveInteger', () => {
  test('positiveInteger accepts only positive safe integers', () => {
    expect(positiveInteger(1)).toBe(1);
    expect(positiveInteger(1_000_000)).toBe(1_000_000);
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, '1000', null, undefined, {}, 2 ** 60]) {
      expect(positiveInteger(bad)).toBeNull();
    }
  });
});

describe('describeContextWindow', () => {
  test('until the server answers there is no window, and nothing is invented', () => {
    const none = { limit: null, cappedAt: null, maxUnknown: false };
    expect(describeContextWindow({})).toStrictEqual(none);
    expect(describeContextWindow({ effective: null, modelMax: null })).toStrictEqual(none);
    expect(describeContextWindow({ effective: null, modelMax: 262_144 })).toStrictEqual(none);
    expect(describeContextWindow({ effective: 0 })).toStrictEqual(none);
  });

  test('the window shown is the server window, whatever the page setting is', () => {
    // The page has no setting input at all: a provider's own window can differ
    // from the global one, and only the server knows which applies.
    expect(describeContextWindow({ effective: 300_000, modelMax: 1_048_576 }).limit).toBe(300_000);
    expect(describeContextWindow({ effective: 40_960, modelMax: 40_960 }).limit).toBe(40_960);
  });

  test('a maximum below the setting labels the window; a higher one does not', () => {
    expect(describeContextWindow({ effective: 262_144, modelMax: 262_144 })).toStrictEqual({
      limit: 262_144,
      cappedAt: 262_144,
      maxUnknown: false,
    });
    expect(describeContextWindow({ effective: 300_000, modelMax: 1_000_000 })).toStrictEqual({
      limit: 300_000,
      cappedAt: null,
      maxUnknown: false,
    });
  });

  test('a server that answered without a maximum is "model max unknown"', () => {
    expect(describeContextWindow({ effective: 300_000, modelMax: null })).toStrictEqual({
      limit: 300_000,
      cappedAt: null,
      maxUnknown: true,
    });
    expect(describeContextWindow({ effective: 300_000 }).maxUnknown).toBe(true);
  });

  test('zeros, negatives and NaN count as no answer', () => {
    expect(describeContextWindow({ effective: 0, modelMax: 0 }).limit).toBeNull();
    expect(describeContextWindow({ effective: -3 }).limit).toBeNull();
    expect(describeContextWindow({ effective: Number.NaN }).limit).toBeNull();
    // A nonsense maximum is no maximum, not a cap.
    expect(describeContextWindow({ effective: 1000, modelMax: -5 })).toStrictEqual({
      limit: 1000,
      cappedAt: null,
      maxUnknown: true,
    });
  });
});

describe('the refetch rules', () => {
  test('a focus asks the server again at most every 30 seconds', () => {
    expect(NUMCTX_FOCUS_REFETCH_MS).toBe(30_000);
    expect(shouldRefetchNumCtx(1_000, null)).toBe(true);
    expect(shouldRefetchNumCtx(1_000 + 29_999, 1_000)).toBe(false);
    expect(shouldRefetchNumCtx(1_000 + 30_000, 1_000)).toBe(true);
    expect(shouldRefetchNumCtx(1_000 + 600_000, 1_000)).toBe(true);
  });

  test('an answer for a model that is no longer selected is stale', () => {
    const asked = { model: 'a', providerId: 'p1' };
    expect(isStaleNumCtxAnswer(asked, { model: 'a', providerId: 'p1' })).toBe(false);
    expect(isStaleNumCtxAnswer(asked, { model: 'b', providerId: 'p1' })).toBe(true);
    expect(isStaleNumCtxAnswer(asked, { model: 'a', providerId: 'p2' })).toBe(true);
    expect(
      isStaleNumCtxAnswer({ model: 'a', providerId: null }, { model: 'a', providerId: 'p1' })
    ).toBe(true);
  });
});

describe('interpretNumCtxInput (the Settings field)', () => {
  test('the Settings field is never turned into a default', () => {
    // The old `parseInt(text) || DEFAULT_NUM_CTX` saved 131072 for all of these.
    for (const text of ['', '  ', 'abc', '0', '-5', '12.5', '1e6', '0x10', '10 000', '٣']) {
      const result = interpretNumCtxInput(text, 1_000_000);
      expect(result.kind).toBe('invalid');
    }
    for (const text of ['abc', '0', '-5', '12.5', '1e6']) {
      expect(interpretNumCtxInput(text, null).kind).toBe('invalid');
    }
  });

  test('a blank field while the setting is still unknown means "unchanged"', () => {
    expect(interpretNumCtxInput('', null)).toStrictEqual({ kind: 'unchanged' });
    expect(interpretNumCtxInput('   ', null)).toStrictEqual({ kind: 'unchanged' });
  });

  test('an unchanged value is not written; a changed one is', () => {
    expect(interpretNumCtxInput('1000000', 1_000_000)).toStrictEqual({ kind: 'unchanged' });
    expect(interpretNumCtxInput(' 500000 ', 1_000_000)).toStrictEqual({
      kind: 'set',
      value: 500_000,
    });
    expect(interpretNumCtxInput('0200000', null)).toStrictEqual({ kind: 'set', value: 200_000 });
    expect(interpretNumCtxInput('9007199254740993', null).kind).toBe('invalid');
  });
});

describe('the store: no placeholder, and the sequence that failed', () => {
  test('the store starts with no setting and no window', () => {
    expect(initialState.requestedNumCtx).toBeNull();
    expect(initialState.effectiveNumCtx).toBeNull();
    expect(windowOf(initialState)).toStrictEqual({
      limit: null,
      cappedAt: null,
      maxUnknown: false,
    });
  });

  test('SET_CONFIG without a context size leaves the setting unknown', () => {
    const state = chatReducer(initialState, { type: 'SET_CONFIG', config: { yolo: true } });
    expect(state.requestedNumCtx).toBeNull();
  });

  test('replay: the saved count arrives BEFORE the config — never 131072, ends at the server window', () => {
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
    expect(windowOf(state).limit).toBeNull();
    expect(windowOf(state).limit).not.toBe(PLACEHOLDER);
    expect(state.effectiveNumCtx).toBeNull();

    // Then the config arrives. The page's setting is not a window: the bar
    // still waits for the server rather than showing the setting.
    state = chatReducer(state, { type: 'SET_CONFIG', config: { requestedNumCtx: 1_000_000 } });
    expect(windowOf(state).limit).toBeNull();

    // Then the server answers.
    state = serverAnswer(state, { effective: 1_000_000, modelMax: 1_048_576 });
    expect(windowOf(state)).toStrictEqual({ limit: 1_000_000, cappedAt: null, maxUnknown: false });
    expect(state.tokenStats.totalTokens).toBe(276_922);
  });

  test('replay: a model maximum below the setting is shown, and clears on a model change', () => {
    let state = chatReducer(initialState, {
      type: 'SET_CONFIG',
      config: { requestedNumCtx: 1_000_000, defaultModel: 'small', defaultProviderId: 'p1' },
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
    expect(windowOf(state)).toStrictEqual({ limit: 262_144, cappedAt: 262_144, maxUnknown: false });

    // Re-selecting the same model must not forget what the server reported.
    const same = chatReducer(state, {
      type: 'SET_SESSION_SELECTION',
      selection: {
        model: 'small',
        providerId: 'p1',
        compactionModel: null,
        compactionProviderId: null,
      },
    });
    expect(same.tokenStats.modelContextLimit).toBe(262_144);
    expect(same.modelMaxNumCtx).toBe(262_144);
    expect(same.effectiveNumCtx).toBe(state.effectiveNumCtx);
    const sameProvider = chatReducer(state, { type: 'SET_ACTIVE_PROVIDER', providerId: 'p1' });
    expect(sameProvider.tokenStats.modelContextLimit).toBe(262_144);

    // A real change drops the previous model's maximum and window: the bar shows
    // "—" until the server answers for the new model.
    for (const next of [
      chatReducer(state, {
        type: 'SET_SESSION_SELECTION',
        selection: {
          model: 'big',
          providerId: 'p1',
          compactionModel: null,
          compactionProviderId: null,
        },
      }),
      chatReducer(state, { type: 'SET_ACTIVE_PROVIDER', providerId: 'p2' }),
      chatReducer(state, { type: 'SET_DEFAULT_SELECTION', model: 'big', providerId: 'p1' }),
    ]) {
      expect(next.tokenStats.modelContextLimit).toBeNull();
      expect(next.modelMaxNumCtx).toBeNull();
      expect(next.effectiveNumCtx).toBeNull();
      expect(windowOf(next)).toStrictEqual({ limit: null, cappedAt: null, maxUnknown: false });
      expect(next.tokenStats.totalTokens).toBe(11);
      // The server then answers for the new model.
      const answered = serverAnswer(next, { effective: 1_000_000, modelMax: 2_000_000 });
      expect(windowOf(answered)).toStrictEqual({
        limit: 1_000_000,
        cappedAt: null,
        maxUnknown: false,
      });
    }

    // A SET_CONFIG that does not change the selection leaves the maximum alone.
    const unrelated = chatReducer(state, {
      type: 'SET_CONFIG',
      config: { yolo: true },
    });
    expect(unrelated.tokenStats.modelContextLimit).toBe(262_144);
    expect(unrelated.modelMaxNumCtx).toBe(262_144);
  });

  test('the window and the maximum survive a cleared token count and a conversation switch', () => {
    // The maximum belongs to the selected MODEL, not to a conversation's token
    // stats. If it lived only in the stats, a conversation with no saved stats
    // would show a window and no maximum, and the bar would claim "model max
    // unknown" for a model whose maximum the server had reported.
    let state = chatReducer(initialState, {
      type: 'SET_CONFIG',
      config: { defaultModel: 'm', defaultProviderId: 'p1' },
    });
    state = serverAnswer(state, { effective: 262_144, modelMax: 262_144 });
    const expected = { limit: 262_144, cappedAt: 262_144, maxUnknown: false };
    expect(windowOf(state)).toStrictEqual(expected);

    state = chatReducer(state, { type: 'CLEAR_TOKEN_STATS' });
    expect(windowOf(state)).toStrictEqual(expected);

    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 5 });
    expect(windowOf(state)).toStrictEqual(expected);
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 6 });
    state = chatReducer(state, { type: 'CLEAR_TOKEN_STATS' });
    expect(windowOf(state)).toStrictEqual(expected);
  });

  test('an update without the maximum leaves it alone; only an explicit null clears it', () => {
    let state = serverAnswer(initialState, { effective: 262_144, modelMax: 262_144 });
    // A turn's status event that carries a window but no maximum field.
    state = chatReducer(state, {
      type: 'SET_TOKEN_STATS',
      stats: { promptEvalCount: 5, evalCount: 5, totalTokens: 10, tokenLimit: 262_144 },
    });
    expect(state.modelMaxNumCtx).toBe(262_144);
    // The server explicitly says it knows none.
    state = chatReducer(state, {
      type: 'SET_TOKEN_STATS',
      stats: { promptEvalCount: 5, evalCount: 5, totalTokens: 10, modelContextLimit: null },
    });
    expect(state.modelMaxNumCtx).toBeNull();
    expect(windowOf(state).maxUnknown).toBe(true);
  });

  test('the server answer seeds the window and the maximum without touching the count', () => {
    let state = chatReducer(initialState, {
      type: 'SET_TOKEN_STATS',
      stats: { promptEvalCount: 100, evalCount: 5, totalTokens: 105, isEstimated: false },
    });
    state = serverAnswer(state, { effective: 300_000, modelMax: null });
    expect(state.effectiveNumCtx).toBe(300_000);
    expect(state.tokenStats.modelContextLimit).toBeNull();
    expect(state.modelMaxNumCtx).toBeNull();
    expect(windowOf(state)).toStrictEqual({ limit: 300_000, cappedAt: null, maxUnknown: true });
    expect(state.tokenStats.totalTokens).toBe(105);
    expect(state.tokenStats.promptEvalCount).toBe(100);
    // A server with no setting at all sends no window: the bar keeps showing "—".
    const none = serverAnswer(initialState, { effective: null, modelMax: 262_144 });
    expect(none.effectiveNumCtx).toBeNull();
    expect(windowOf(none).limit).toBeNull();
  });

  test('a status merge without a limit keeps a limit the server already reported', () => {
    let state = chatReducer(initialState, {
      type: 'SET_TOKEN_STATS',
      stats: { promptEvalCount: 1, evalCount: 1, totalTokens: 2, tokenLimit: 500_000 },
    });
    expect(state.effectiveNumCtx).toBe(500_000);
    state = chatReducer(state, {
      type: 'SET_TOKEN_STATS',
      stats: { promptEvalCount: 5, evalCount: 5, totalTokens: 10 },
    });
    expect(state.tokenStats.tokenLimit).toBe(500_000);
    expect(state.effectiveNumCtx).toBe(500_000);
  });
});

describe('the compact frame', () => {
  test('a compact frame without a window leaves the limit unknown (no stand-in)', () => {
    const { actions } = routeSseEvent(
      'compact',
      { stats: { oldTokenCount: 1000, newTokenCount: 300 }, messages: [] },
      { targetSessionId: 7, compactOwner: 7 }
    );
    const stats = actions.find((a) => a.type === 'SET_TOKEN_STATS');
    expect(stats).toBeTruthy();
    expect('tokenLimit' in stats.stats).toBeFalsy();
    expect(stats.stats.totalTokens).toBe(300);
  });

  test('a compact frame with a window carries exactly that window', () => {
    const { actions } = routeSseEvent(
      'compact',
      { stats: { oldTokenCount: 1000, newTokenCount: 300 }, messages: [], tokenLimit: 262_144 },
      { targetSessionId: 7, compactOwner: 7 }
    );
    expect(actions.find((a) => a.type === 'SET_TOKEN_STATS').stats.tokenLimit).toBe(262_144);
  });
});

// The hooks and components cannot run without React, so the source is read.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative) =>
  fs.readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n');

describe('the wiring that must stay', () => {
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

  test('no client file imports or uses DEFAULT_NUM_CTX', () => {
    const offenders = clientFiles.filter((file) => {
      // Comments may explain the history; code may not use the constant.
      const code = read(file)
        .replaceAll(/\/\*[\S\s]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      return /DEFAULT_NUM_CTX/.test(code);
    });
    expect(offenders).toStrictEqual([]);
  });

  test('no request the page makes carries a context window', () => {
    for (const file of clientFiles) {
      const code = read(file)
        .replaceAll(/\/\*[\S\s]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/requestedNumCtxRef/);
      if (file === 'src/app/lib/contextWindow.ts') continue;
      expect(code).not.toMatch(/numCtxField\(/);
      // `/ctx` saves the SETTING to the config; that is the one body allowed.
      const withoutSettingSave = code.replace('JSON.stringify({ numCtx: size })', '');
      expect(withoutSettingSave).not.toMatch(/\bnumCtx:\s/);
    }
  });

  test('the loaders never write the setting or a default as a token limit', () => {
    const loaders = read('src/app/hooks/useDataLoaders.ts');
    expect(loaders).not.toContain('requestedNumCtxRef.current');
    expect(loaders).not.toMatch(/\?\?\s*state\.requestedNumCtx/);
    // Every SET_TOKEN_STATS from a loader leaves the key out when unknown.
    expect(
      loaders.match(/\.{3}\(knownLimit ={3} undefined \? {} : { tokenLimit: knownLimit }\)/g) ?? []
    ).toHaveLength(3);
  });

  test('Settings validates the context size instead of defaulting it', () => {
    const settings = read('src/components/SettingsModal/SettingsModal.tsx');
    expect(settings).toContain('interpretNumCtxInput(');
    expect(settings).not.toMatch(/parseInt\(numCtx\)/);
    expect(settings).not.toContain('numCtxChanged');
  });

  test('the status bar shows what the server reported and infers nothing', () => {
    const bar = read('src/components/StatusBar/StatusBar.tsx');
    expect(bar).toContain('describeContextWindow(');
    expect(bar).toContain('modelMaxNumCtx');
    expect(bar).not.toContain('modelContextLimit');
    expect(bar).not.toContain('requestedNumCtx');
    expect(bar).toContain('(model max unknown)');
    expect(bar).not.toMatch(/effectiveNumCtx\s*<\s*requestedNumCtx/);
    expect(bar).not.toMatch(/tokenStats\?\.tokenLimit\s*\|\|/);
  });

  test('/ctx saves the setting BEFORE the page changes, so the refetch it causes reads it', () => {
    const slash = read('src/app/hooks/useSlashCommands.ts');
    const block = slash.slice(
      slash.indexOf("case 'ctx': {"),
      slash.indexOf("case 'ctx': {") + 1500
    );
    const save = block.indexOf("fetch('/api/config'");
    const show = block.indexOf("type: 'SET_CONFIG'");
    expect(save !== -1 && show !== -1).toBeTruthy();
    expect(save).toBeLessThan(show);
  });

  test('the page asks the server for the window and keeps it current', () => {
    const loaders = read('src/app/hooks/useDataLoaders.ts');
    expect(loaders).toContain('`/api/numctx?${params.toString()}`');
    expect(loaders).toContain('isStaleNumCtxAnswer(');
    expect(loaders).toContain('loadNumCtx,');
    expect(loaders).not.toContain('data.modelContextLimit');
    const sync = read('src/app/hooks/useNumCtxSync.ts');
    expect(sync).toMatch(/\[loadNumCtx, model, providerId, requestedNumCtx]/);
    expect(sync).toContain("addEventListener('focus'");
    expect(sync).toContain('shouldRefetchNumCtx(');
    expect(read('src/app/page.tsx')).toContain('useNumCtxSync(loadNumCtx');
  });

  test('GET /api/config does not probe a provider, so reading it never waits on one', () => {
    const route = read('src/app/api/config/route.ts');
    expect(route).not.toContain('resolveNumCtx');
    expect(route).not.toContain('modelContextLimit');
  });

  test.each([
    'src/app/lib/contextWindow.ts',
    'src/components/StatusBar/StatusBar.tsx',
    'src/components/SettingsModal/SettingsModal.tsx',
    'src/app/hooks/useDataLoaders.ts',
  ])('the page never computes a minimum (%p)', (file) => {
    const code = read(file)
      .replaceAll(/\/\*[\S\s]*?\*\//g, '')
      .replaceAll(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.min\(/);
  });
});

describe('Retry and the mid-turn switch use the setting as it is now', () => {
  test('the route resolves a mid-turn switch from the saved setting, not the body', () => {
    const route = read('src/app/api/chat/route.ts');
    expect(route).toContain('resolveNumCtxForModel(true)');
    expect(route).toMatch(/fromSavedSetting \? await loadConfig\(\)/);
    expect(route).not.toContain('bodyRequested');
    expect(route).toContain("phase: 'config_unavailable'");
  });

  test('the page warns when the config cannot be loaded', () => {
    const loaders = read('src/app/hooks/useDataLoaders.ts');
    expect(loaders).toContain('Config could not be loaded (HTTP');
    expect(loaders).toContain("console.warn('Config could not be loaded:'");
  });

  test('Retry replays the stored body, which carries no window', () => {
    const hook = read('src/app/hooks/useChatStream.ts');
    expect(hook).toContain('const body = stored;');
    expect(hook).not.toContain('withCurrentNumCtx');
  });

  test('the route logs a missing or unreadable config, not only a thrown one', () => {
    const route = read('src/app/api/chat/route.ts');
    // loadConfig() returns null instead of throwing, so the catch alone never sees it.
    expect(route).toMatch(/if \(config === null\) {[\S\s]*?phase: 'config_unavailable'/);
  });
});
