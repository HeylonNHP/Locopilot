#!/usr/bin/env node
/**
 * Regression checks for model/provider persistence payloads and refresh recovery.
 *
 * Run with: npx tsx scripts/test-provider-persistence.mjs
 *
 * These checks are intentionally network-free and follow the repository's
 * lightweight PASS/FAIL harness convention.
 */

import { readFile } from 'node:fs/promises';

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}`);
    fail += 1;
  }
}

function assertIncludes(source, value, label) {
  assert(source.includes(value), label);
}

function assertExcludes(source, value, label) {
  assert(!source.includes(value), label);
}

const slashCommands = await readFile(
  new URL('../src/app/hooks/useSlashCommands.ts', import.meta.url),
  'utf8'
);
const dataLoaders = await readFile(
  new URL('../src/app/hooks/useDataLoaders.ts', import.meta.url),
  'utf8'
);
const modelSelector = await readFile(
  new URL('../src/components/ModelSelector/ModelSelector.tsx', import.meta.url),
  'utf8'
);
const completionSelector = await readFile(
  new URL('../src/components/CompletionModeSelector/CompletionModeSelector.tsx', import.meta.url),
  'utf8'
);

console.log('Provider persistence — /model command');
assertIncludes(
  slashCommands,
  "const selectedProviderId =\n                typeof matched === 'string' ? undefined : matched.providerId;",
  'reads providerId from the matched model'
);
assertIncludes(
  slashCommands,
  "dispatch({ type: 'SET_ACTIVE_PROVIDER', providerId: selectedProviderId });",
  'updates the active provider when metadata is available'
);
assertIncludes(
  slashCommands,
  '...(selectedProviderId ? { activeProviderId: selectedProviderId } : {}),',
  'persists activeProviderId with the model'
);

console.log('Provider persistence — refresh reconciliation');
assertIncludes(
  dataLoaders,
  'm.name === state.model && m.providerId === state.activeProviderId',
  'checks that the restored provider owns the selected model'
);
assertIncludes(
  dataLoaders,
  'if (!selectedModelMatchesProvider)',
  'repairs a mismatched provider instead of only a missing provider'
);

console.log('Config payloads — strict /api/config contract');
assertExcludes(
  modelSelector,
  'body: JSON.stringify({\n              baseUrl,',
  'main/compaction model selector payloads do not send top-level baseUrl'
);
assertExcludes(
  completionSelector,
  'body: JSON.stringify({\n              baseUrl,',
  'completion selector payload does not send top-level baseUrl'
);
assertIncludes(
  modelSelector,
  'activeProviderId: selectedProviderId,',
  'model selector persists the selected provider ID'
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
