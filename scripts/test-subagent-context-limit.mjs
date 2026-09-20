#!/usr/bin/env node
/**
 * Unit tests for the reactive context-limit recovery clamp
 * (adoptDiscoveredContextLimit in src/tools/impl/subAgentTool.ts).
 *
 * Run with: npx tsx scripts/test-subagent-context-limit.mjs
 *
 * No network, no live server: the function under test is pure mutation of a
 * config object plus the cap resolver's in-process cache (whose hit path
 * short-circuits before any HTTP probe, so the cache assertion below is
 * network-free too).
 *
 * Regression focus: a sub-agent whose LLM call is rejected with a
 * context-limit 400 naming the real cap (e.g. llama-server's "request
 * (326517 tokens) exceeds the available context size (262144 tokens)") must
 * fold that cap into (a) the resolver cache, (b) its own config — including
 * the compaction runtime when that points at the same server+model — and
 * (c) the parent route via the onContextLimitDiscovered hook.
 *
 * Each test prints PASS/FAIL with a one-line label. Exit code is 0 when all
 * pass, 1 otherwise.
 */

import { clearCapCache, resolveEffectiveNumCtx } from '../src/services/capResolver.ts';
import { buildLlmRequestContext } from '../src/services/llm.ts';
import { adoptDiscoveredContextLimit } from '../src/tools/impl/subAgentTool.ts';

const CAP = 262144;
const REQUESTED = 1_000_000;

let pass = 0;
let fail = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}\n        expected: ${expected}\n        actual:   ${actual}`);
    fail += 1;
  }
}

function assertTrue(value, label) {
  assertEq(Boolean(value), true, label);
}

/**
 * Minimal SubAgentConfig with the same shape the chat route builds for a
 * batch: the main model also serves compaction unless a separate compaction
 * provider was configured.
 */
function makeConfig(overrides = {}) {
  return {
    provider: 'openai-compatible',
    baseUrl: 'http://192.168.1.15:8080',
    model: 'Ornith-1.5-35B-A3B-Heretic-MTP-APEX-I-Quality',
    numCtx: REQUESTED,
    compactionModel: 'Ornith-1.5-35B-A3B-Heretic-MTP-APEX-I-Quality',
    compactionLlmRequestContext: buildLlmRequestContext({
      provider: 'openai-compatible',
      baseUrl: 'http://192.168.1.15:8080',
    }),
    compactionNumCtx: REQUESTED,
    tools: [],
    ...overrides,
  };
}

// ── the happy path: same runtime for calls and compaction ──────────────────

console.log('adoptDiscoveredContextLimit — same runtime for calls and compaction');
{
  clearCapCache();
  const discovered = [];
  const config = makeConfig({ onContextLimitDiscovered: (cap) => discovered.push(cap) });

  adoptDiscoveredContextLimit(config, CAP);

  assertEq(config.numCtx, CAP, 'main numCtx clamped 1,000,000 → 262,144');
  assertEq(config.compactionNumCtx, CAP, 'compactionNumCtx clamped to the same cap');
  assertEq(discovered.length, 1, 'route hook invoked exactly once');
  assertEq(discovered[0], CAP, 'route hook receives the discovered cap');
}

// ── the resolver cache learns the cap (this is what stops the next 400) ────

console.log('adoptDiscoveredContextLimit — resolver cache');
{
  clearCapCache();
  const config = makeConfig();
  adoptDiscoveredContextLimit(config, CAP);

  const ctx = buildLlmRequestContext({
    provider: 'openai-compatible',
    baseUrl: config.baseUrl,
  });
  const resolved = await resolveEffectiveNumCtx(ctx, config.model, REQUESTED);

  assertEq(resolved.source, 'cache', 'a later resolve hits the discovered-cap cache');
  assertEq(resolved.modelCap, CAP, 'cached cap is the discovered 262,144');
  assertEq(resolved.effective, CAP, 'effective is clamped to 262,144, not 1,000,000');
}

// ── a compaction runtime on another server keeps its own cap ──────────────

console.log('adoptDiscoveredContextLimit — separate compaction provider');
{
  const config = makeConfig({
    compactionLlmRequestContext: buildLlmRequestContext({
      provider: 'openai-compatible',
      baseUrl: 'https://compaction.example.invalid',
    }),
  });
  adoptDiscoveredContextLimit(config, CAP);

  assertEq(config.numCtx, CAP, 'main numCtx still clamped');
  assertEq(config.compactionNumCtx, REQUESTED, 'other-server compactionNumCtx untouched');
}

console.log('adoptDiscoveredContextLimit — separate compaction model');
{
  const config = makeConfig({
    compactionModel: 'some-other-compaction-model',
    compactionLlmRequestContext: undefined,
  });
  adoptDiscoveredContextLimit(config, CAP);

  assertEq(config.numCtx, CAP, 'main numCtx clamped');
  assertEq(config.compactionNumCtx, REQUESTED, 'other-model compactionNumCtx untouched');
}

console.log('adoptDiscoveredContextLimit — empty compactionModel means "same as main"');
{
  const config = makeConfig({ compactionModel: '' });
  adoptDiscoveredContextLimit(config, CAP);

  assertEq(config.compactionNumCtx, CAP, 'empty compactionModel is treated as the main model');
}

// ── clamping is a ceiling, never a floor ─────────────────────────────────

console.log('adoptDiscoveredContextLimit — never raises a deliberate smaller ceiling');
{
  const config = makeConfig({ numCtx: 131072, compactionNumCtx: 65536 });
  const seen = [];
  config.onContextLimitDiscovered = (cap) => seen.push(cap);

  adoptDiscoveredContextLimit(config, CAP);

  assertEq(config.numCtx, 131072, 'numCtx below the server cap is preserved');
  assertEq(config.compactionNumCtx, 65536, 'compactionNumCtx below the cap is preserved');
  assertEq(seen[0], CAP, 'the route hook still learns the model cap for display');
}

console.log('adoptDiscoveredContextLimit — undefined compactionNumCtx adopts the cap');
{
  const config = makeConfig({ compactionNumCtx: undefined });
  adoptDiscoveredContextLimit(config, CAP);

  assertEq(config.compactionNumCtx, CAP, 'undefined compactionNumCtx becomes the cap');
}

// ── defensive input handling ─────────────────────────────────────────────

console.log('adoptDiscoveredContextLimit — invalid caps are ignored');
for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  const config = makeConfig();
  let hookCalls = 0;
  config.onContextLimitDiscovered = () => {
    hookCalls += 1;
  };
  adoptDiscoveredContextLimit(config, bad);

  assertEq(config.numCtx, REQUESTED, `cap ${String(bad)} leaves numCtx untouched`);
  assertEq(hookCalls, 0, `cap ${String(bad)} does not invoke the route hook`);
}

console.log('adoptDiscoveredContextLimit — missing hook is not an error');
{
  const config = makeConfig({ onContextLimitDiscovered: undefined });
  let threw = false;
  try {
    adoptDiscoveredContextLimit(config, CAP);
  } catch {
    threw = true;
  }
  assertTrue(!threw, 'no hook → no throw');
  assertEq(config.numCtx, CAP, 'clamping still happens without the hook');
}

// ── summary ──────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  process.exit(1);
}
