#!/usr/bin/env node
/**
 * Tests for the navigation order (src/app/lib/latestGate.ts).
 *
 * Run with: npx tsx scripts/test-latest-gate.mjs
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

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createLatestGate } from '../src/app/lib/latestGate.ts';

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

// ── the rule ───────────────────────────────────────────────────────────────
check('the first piece of work is the latest', () => {
  const gate = createLatestGate();
  const token = gate.begin();
  assert.equal(gate.isLatest(token), true);
});

check('starting newer work makes older work stale', () => {
  const gate = createLatestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isLatest(first), false);
  assert.equal(gate.isLatest(second), true);
});

check('only the most recent of several is latest', () => {
  const gate = createLatestGate();
  const tokens = [gate.begin(), gate.begin(), gate.begin(), gate.begin()];
  assert.deepEqual(
    tokens.map((token) => gate.isLatest(token)),
    [false, false, false, true]
  );
});

check('a stale token is never revived', () => {
  const gate = createLatestGate();
  const first = gate.begin();
  gate.begin();
  gate.begin();
  assert.equal(gate.isLatest(first), false);
});

check('each gate keeps its own order', () => {
  const a = createLatestGate();
  const b = createLatestGate();
  const tokenA = a.begin();
  b.begin();
  b.begin();
  assert.equal(a.isLatest(tokenA), true);
});

check('a token that was never issued is not latest', () => {
  const gate = createLatestGate();
  gate.begin();
  assert.equal(gate.isLatest(0), false);
  assert.equal(gate.isLatest(99), false);
});

// ── the two orderings the bug was about ────────────────────────────────────
check('a conversation load that is overtaken by "+ New chat" is stale', () => {
  const gate = createLatestGate();
  const openConversation = gate.begin(); // click a conversation; its fetch is slow
  const newChat = gate.begin(); //          click "+ New chat" before it arrives
  // The slow fetch arrives first: it must be dropped...
  assert.equal(gate.isLatest(openConversation), false);
  // ...and the new chat, when its server call returns, still wins.
  assert.equal(gate.isLatest(newChat), true);
});

check('a new chat that is overtaken by a conversation click is stale', () => {
  const gate = createLatestGate();
  const newChat = gate.begin(); //          click "+ New chat"; the server call is slow
  const openConversation = gate.begin(); // click a conversation before it returns
  assert.equal(gate.isLatest(newChat), false);
  assert.equal(gate.isLatest(openConversation), true);
});

// ── the wiring the hooks must keep ─────────────────────────────────────────
const read = (path) =>
  fs.readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const actionsSource = read('../src/app/hooks/useSessionActions.ts');
const loadersSource = read('../src/app/hooks/useDataLoaders.ts');
const pageSource = read('../src/app/page.tsx');

check('"+ New chat" takes a turn in the navigation order when it starts', () => {
  const body = actionsSource.slice(actionsSource.indexOf('const handleNewSession'));
  const beforeFetch = body.slice(0, body.indexOf("fetch('/api/sessions'"));
  assert.ok(
    beforeFetch.includes('navigation.begin()'),
    'handleNewSession does not take a turn before its fetch'
  );
});

check('"+ New chat" only switches the view while it is still the latest click', () => {
  const body = actionsSource.slice(
    actionsSource.indexOf('const handleNewSession'),
    actionsSource.indexOf('const handleSelectSession')
  );
  const switches = body.match(/dispatch\({ type: 'SET_CURRENT_SESSION'/g) ?? [];
  const guards = body.match(/navigation\.isLatest\(turn\)/g) ?? [];
  assert.equal(switches.length, 2, 'expected the two view switches in handleNewSession');
  assert.equal(guards.length, 2, 'every view switch in handleNewSession must check its turn');
});

check('opening a conversation takes its token from the shared gate', () => {
  assert.ok(loadersSource.includes('sessionNavigation.begin()'));
  assert.ok(loadersSource.includes('sessionNavigation.isLatest(requestId)'));
});

check('the loader and the session actions share ONE gate', () => {
  assert.ok(
    /return {[^}]*loadSessionMessages[^}]*sessionNavigation[^}]*}/.test(loadersSource),
    'the loader does not hand its gate out'
  );
  assert.ok(pageSource.includes('navigation: sessionNavigation'));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
