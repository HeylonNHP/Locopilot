/**
 * Tests for slash-command routing (src/services/slashCommands.ts).
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

import { describe, expect, test } from '@jest/globals';
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

function routeKind(input) {
  return classifySlashInput(input).kind;
}

describe('paths and prose are messages, not commands', () => {
  test.each([
    [
      'absolute path with a file name is a message',
      '/home/heylon/gt5/hp-calc/1/screenshot_20261005_142519.png',
      'message',
    ],
    [
      'absolute path followed by a question is a message',
      '/mnt/Secondary/git/Locopilot - why does this fail',
      'message',
    ],
    ['sentence starting with a slash is a message', '/etc is broken', 'message'],
    ['directory path is a message', '/usr/local/bin', 'message'],
    ['a slash later in the line is a message', 'hello /help', 'message'],
    ['unrelated prose is a message', 'what is in ~/notes.txt', 'message'],
  ])('%s', (_label, input, expected) => {
    expect(routeKind(input)).toBe(expected);
  });
});

describe('known commands dispatch', () => {
  test.each([
    ['a command', '/help'],
    ['command names are case-insensitive', '/HELP'],
    ['surrounding whitespace is ignored', '  /compact  '],
    ['a command with an argument dispatches', '/ctx 8192'],
  ])('%s', (_label, input) => {
    expect(routeKind(input)).toBe('command');
  });

  test('/model with an argument is a command, with the name and the arguments split', () => {
    const parsed = classifySlashInput('/model qwen3:8b');
    expect(parsed).toMatchObject({
      kind: 'command',
      // the parsed name has no slash
      name: 'model',
      // the parsed args exclude the command name
      args: 'qwen3:8b',
    });
  });

  test.each(SLASH_COMMAND_NAMES)('/%s is a command', (name) => {
    expect(routeKind(`/${name}`)).toBe('command');
    expect(isSlashCommandName(name)).toBe(true);
  });
});

describe('misspelled commands are flagged for editing', () => {
  test.each([
    ['a bare typo is an unknown command', '/compac', 'unknown-command'],
    ['a lone slash is an unknown command', '/', 'unknown-command'],
    ['a typo with trailing text is sent as a message', '/compac now please', 'message'],
  ])('%s', (_label, input, expected) => {
    expect(routeKind(input)).toBe(expected);
  });

  test('an unknown name is rejected by the guard', () => {
    expect(isSlashCommandName('compac')).toBe(false);
  });
});

describe('help text', () => {
  const help = formatSlashCommandHelp();

  test('has a header', () => {
    expect(help.startsWith('Available commands:')).toBe(true);
  });

  test.each(SLASH_COMMANDS.map(({ command }) => command))('lists %s', (command) => {
    expect(help).toContain(command);
  });

  test('lists /ctx (it was missing from the old hardcoded block)', () => {
    expect(help).toContain('/ctx');
  });
});

describe('the command table stays in sync with the dispatcher', () => {
  const readSource = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');
  const dispatcherSource = readSource('src/app/hooks/useSlashCommands.ts');
  const caseNames = [...dispatcherSource.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]);

  test('/help is no longer the hardcoded block', () => {
    expect(dispatcherSource).not.toContain('Show all available commands');
  });

  test('/help renders the shared table', () => {
    expect(dispatcherSource).toContain('addSystem(formatSlashCommandHelp())');
  });

  test('formatSlashCommandHelp has exactly one call site', () => {
    expect(dispatcherSource.match(/formatSlashCommandHelp\(\)/g) ?? []).toHaveLength(1);
  });

  test.each(SLASH_COMMAND_NAMES)('the dispatcher has a case for /%s', (name) => {
    expect(caseNames).toContain(name);
  });

  test.each(caseNames)('the command table has an entry for the dispatcher case "%s"', (name) => {
    expect(SLASH_COMMAND_NAMES).toContain(name);
  });

  test('ChatInput no longer keeps a private COMMANDS list', () => {
    expect(readSource('src/components/ChatInput/ChatInput.tsx')).not.toMatch(/const COMMANDS = \[/);
  });

  test('ChatInput autocomplete filters the shared table', () => {
    expect(readSource('src/components/ChatInput/ChatInput.tsx')).toContain('SLASH_COMMANDS.filter');
  });

  describe('useSendHandler', () => {
    const sendHandlerSource = readSource('src/app/hooks/useSendHandler.ts');
    // Strip comments first: the negative checks below must look at executable code
    // only, otherwise a comment that quotes the old routing rule trips them.
    const sendHandlerCode = sendHandlerSource
      .replaceAll(/\/\*[\S\s]*?\*\//g, '')
      .replaceAll(/^\s*\/\/.*$/gm, '');

    test("no longer routes on startsWith('/')", () => {
      expect(sendHandlerCode).not.toMatch(/startsWith\('\/'\)/);
    });

    test('routes through classifySlashInput', () => {
      expect(sendHandlerSource).toContain('classifySlashInput');
    });
  });
});
