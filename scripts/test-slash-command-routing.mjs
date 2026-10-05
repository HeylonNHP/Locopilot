#!/usr/bin/env node
/**
 * Tests for slash-command routing (src/services/slashCommands.ts).
 *
 * Run with: npx tsx scripts/test-slash-command-routing.mjs
 *
 * No network, no live server, no Ollama — the classifier, the help renderer
 * and the drift check between the command table and the dispatcher are all
 * exercised directly.
 *
 * Regression focus: the composer used to route on `input.startsWith('/')`, so
 * a prompt that began with a path was dispatched as a slash command, answered
 * with "Unknown command", and then discarded because the compose box was
 * cleared unconditionally. These tests pin (a) a path/sentence staying a
 * message, (b) only exact command names dispatching as commands, and (c) that
 * every command in the shared table still has a `case` in the dispatcher.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifySlashInput,
  formatSlashCommandHelp,
  isSlashCommandName,
  SLASH_COMMAND_NAMES,
  SLASH_COMMANDS,
} from '../src/services/slashCommands.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

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
  if (value) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}\n        expected truthy, got: ${value}`);
    fail += 1;
  }
}

function routeKind(input) {
  return classifySlashInput(input).kind;
}

// ── Paths and prose must stay messages ──────────────────────────────────────
console.log('paths and prose are messages, not commands');
assertEq(
  routeKind('/home/heylon/gt5/hp-calc/1/screenshot_20261005_142519.png'),
  'message',
  'absolute path with a file name is a message'
);
assertEq(
  routeKind('/mnt/Secondary/git/Locopilot - why does this fail'),
  'message',
  'absolute path followed by a question is a message'
);
assertEq(routeKind('/etc is broken'), 'message', 'sentence starting with a slash is a message');
assertEq(routeKind('/usr/local/bin'), 'message', 'directory path is a message');
assertEq(routeKind('hello /help'), 'message', 'a slash later in the line is a message');
assertEq(routeKind('what is in ~/notes.txt'), 'message', 'unrelated prose is a message');

// ── Real commands still dispatch ────────────────────────────────────────────
console.log('known commands dispatch');
assertEq(routeKind('/help'), 'command');
assertEq(routeKind('/HELP'), 'command', 'command names are case-insensitive');
assertEq(routeKind('  /compact  '), 'command', 'surrounding whitespace is ignored');
assertEq(routeKind('/ctx 8192'), 'command', 'command with an argument dispatches');

const parsed = classifySlashInput('/model qwen3:8b');
assertEq(parsed.kind, 'command', '/model with an argument is a command');
if (parsed.kind === 'command') {
  assertEq(parsed.name, 'model', 'parsed name has no slash');
  assertEq(parsed.args, 'qwen3:8b', 'parsed args exclude the command name');
}

for (const name of SLASH_COMMAND_NAMES) {
  const kind = routeKind(`/${name}`);
  assertEq(kind, 'command', `/${name} dispatches`);
  assertTrue(isSlashCommandName(name), `isSlashCommandName('${name}')`);
}

// ── Misspelled commands are reported, never silently dropped ───────────────
console.log('misspelled commands are flagged for editing');
assertEq(routeKind('/compac'), 'unknown-command', 'bare typo is an unknown command');
assertEq(routeKind('/'), 'unknown-command', 'a lone slash is an unknown command');
assertEq(
  routeKind('/compac now please'),
  'message',
  'typo with trailing text is sent as a message'
);
assertEq(isSlashCommandName('compac'), false, 'unknown name is rejected by the guard');

// ── Help text is generated from the table ──────────────────────────────────
console.log('help text');
const help = formatSlashCommandHelp();
assertTrue(help.startsWith('Available commands:'), 'help has a header');
for (const { command } of SLASH_COMMANDS) {
  assertTrue(help.includes(command), `help lists ${command}`);
}
assertTrue(help.includes('/ctx'), 'help lists /ctx (it was missing from the old hardcoded block)');

// ── Drift check: table ↔ dispatcher ↔ autocomplete ─────────────────────────
console.log('command table stays in sync with the dispatcher');
const dispatcherSource = readFileSync(
  path.join(repoRoot, 'src/app/hooks/useSlashCommands.ts'),
  'utf8'
);
const caseNames = [...dispatcherSource.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]);

assertTrue(
  !dispatcherSource.includes('Show all available commands'),
  '/help is no longer the hardcoded block'
);
assertTrue(
  dispatcherSource.includes('addSystem(formatSlashCommandHelp())'),
  '/help renders the shared table'
);
assertEq(
  (dispatcherSource.match(/formatSlashCommandHelp\(\)/g) ?? []).length,
  1,
  'formatSlashCommandHelp has exactly one call site'
);

for (const name of SLASH_COMMAND_NAMES) {
  assertTrue(caseNames.includes(name), `dispatcher handles /${name}`);
}
for (const name of caseNames) {
  assertTrue(
    SLASH_COMMAND_NAMES.includes(name),
    `dispatcher case '${name}' is declared in the shared table`
  );
}

const chatInputSource = readFileSync(
  path.join(repoRoot, 'src/components/ChatInput/ChatInput.tsx'),
  'utf8'
);
assertTrue(
  !/const COMMANDS = \[/.test(chatInputSource),
  'ChatInput no longer keeps a private COMMANDS list'
);
assertTrue(
  chatInputSource.includes('SLASH_COMMANDS.filter'),
  'ChatInput autocomplete filters the shared table'
);

const sendHandlerSource = readFileSync(
  path.join(repoRoot, 'src/app/hooks/useSendHandler.ts'),
  'utf8'
);
// Strip comments first: the negative checks below must look at executable code
// only, otherwise a comment that quotes the old routing rule trips them.
const sendHandlerCode = sendHandlerSource
  .replaceAll(/\/\*[\S\s]*?\*\//g, '')
  .replaceAll(/^\s*\/\/.*$/gm, '');
assertTrue(
  !/startsWith\('\/'\)/.test(sendHandlerCode),
  "useSendHandler no longer routes on startsWith('/')"
);
assertTrue(
  sendHandlerSource.includes('classifySlashInput'),
  'useSendHandler routes through classifySlashInput'
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
