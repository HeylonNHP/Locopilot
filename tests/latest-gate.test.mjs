/**
 * Tests for the navigation order (src/app/lib/latestGate.ts).
 *
 * No network, no server, no React.
 *
 * Regression focus: clicking a conversation and then "+ New chat" before the
 * conversation had finished loading let the late load arrive afterwards and
 * take the view back, so the next message was typed into the conversation the
 * user had just left. Opening a conversation was the only navigation that
 * took part in the "latest wins" order; "+ New chat" now takes a turn in it
 * too. The hooks cannot be run without React, so the ordering rule is tested
 * here and the wiring is pinned by reading the hook sources.
 */

import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';

import { createLatestGate } from '../src/app/lib/latestGate.ts';

describe('the navigation order', () => {
  test('the first piece of work is the latest', () => {
    const gate = createLatestGate();
    const token = gate.begin();
    expect(gate.isLatest(token)).toBe(true);
  });

  test('starting newer work makes older work stale', () => {
    const gate = createLatestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isLatest(first)).toBe(false);
    expect(gate.isLatest(second)).toBe(true);
  });

  test('only the most recent of several is latest', () => {
    const gate = createLatestGate();
    const tokens = [gate.begin(), gate.begin(), gate.begin(), gate.begin()];
    expect(tokens.map((token) => gate.isLatest(token))).toStrictEqual([false, false, false, true]);
  });

  test('a stale token is never revived', () => {
    const gate = createLatestGate();
    const first = gate.begin();
    gate.begin();
    gate.begin();
    expect(gate.isLatest(first)).toBe(false);
  });

  test('each gate keeps its own order', () => {
    const a = createLatestGate();
    const b = createLatestGate();
    const tokenA = a.begin();
    b.begin();
    b.begin();
    expect(a.isLatest(tokenA)).toBe(true);
  });

  test('a token that was never issued is not latest', () => {
    const gate = createLatestGate();
    gate.begin();
    expect(gate.isLatest(0)).toBe(false);
    expect(gate.isLatest(99)).toBe(false);
  });
});

describe('the two orderings the bug was about', () => {
  test('a conversation load that is overtaken by "+ New chat" is stale', () => {
    const gate = createLatestGate();
    const openConversation = gate.begin(); // click a conversation; its fetch is slow
    const newChat = gate.begin(); //          click "+ New chat" before it arrives
    // The slow fetch arrives first: it must be dropped...
    expect(gate.isLatest(openConversation)).toBe(false);
    // ...and the new chat, when its server call returns, still wins.
    expect(gate.isLatest(newChat)).toBe(true);
  });

  test('a new chat that is overtaken by a conversation click is stale', () => {
    const gate = createLatestGate();
    const newChat = gate.begin(); //          click "+ New chat"; the server call is slow
    const openConversation = gate.begin(); // click a conversation before it returns
    expect(gate.isLatest(newChat)).toBe(false);
    expect(gate.isLatest(openConversation)).toBe(true);
  });
});

describe('the wiring the hooks must keep', () => {
  const read = (path) =>
    fs.readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const actionsSource = read('../src/app/hooks/useSessionActions.ts');
  const loadersSource = read('../src/app/hooks/useDataLoaders.ts');
  const pageSource = read('../src/app/page.tsx');

  test('"+ New chat" takes a turn in the navigation order when it starts', () => {
    const body = actionsSource.slice(actionsSource.indexOf('const handleNewSession'));
    const beforeFetch = body.slice(0, body.indexOf("fetch('/api/sessions'"));
    // handleNewSession must take a turn before its fetch
    expect(beforeFetch).toContain('navigation.begin()');
  });

  test('"+ New chat" only switches the view while it is still the latest click', () => {
    const body = actionsSource.slice(
      actionsSource.indexOf('const handleNewSession'),
      actionsSource.indexOf('const handleSelectSession')
    );
    const switches = body.match(/dispatch\({ type: 'SET_CURRENT_SESSION'/g) ?? [];
    const guards = body.match(/navigation\.isLatest\(turn\)/g) ?? [];
    // the two view switches in handleNewSession must each check their turn
    expect(switches).toHaveLength(2);
    expect(guards).toHaveLength(2);
  });

  test('opening a conversation takes its token from the shared gate', () => {
    expect(loadersSource).toContain('sessionNavigation.begin()');
    expect(loadersSource).toContain('sessionNavigation.isLatest(requestId)');
  });

  test('the loader and the session actions share ONE gate', () => {
    // the loader has to hand its gate out
    expect(loadersSource).toMatch(/return {[^}]*loadSessionMessages[^}]*sessionNavigation[^}]*}/);
    expect(pageSource).toContain('navigation: sessionNavigation');
  });
});
