/**
 * Regression tests for the sub-agent / namespaced MCP fixes.
 *
 * No network, no live MCP server, no Ollama. The MCP config root is
 * isolated by pointing HOME at a temp directory before importing the
 * module graph (getMCPConfigPath resolves os.homedir() at call time).
 *
 * Covers two confirmed bugs:
 *
 * Bug 1 — direct `mcp__<server>__<tool>` tool calls used to return
 *   '[Unknown tool: ...]' because both dispatch sites resolved through
 *   the static native-tool registry. They must now reach the MCP layer
 *   (observed via '[MCP error: ...' results for unconfigured servers).
 *
 * Bug 2 — the sub-agent mcp_call approval gate prompted on every call
 *   and then discarded the user's approval: the immediate namespaced
 *   target was never added to the sub-agent's ledger, so the dispatcher
 *   rejected the call with '[MCP call requires approval]' even though
 *   the user had just approved it. The ledger must now contain the
 *   approved target, pre-approved targets and autoApprove glob matches
 *   must skip the prompt entirely, and grantedTools must be verified
 *   against configured servers.
 */

import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let fakeHome;
let handleToolCall;
let isAutoApprovedMCPTarget;
let executeNestedToolCall;
let noopToolOutputSink;

// Isolate the MCP config root BEFORE any @/mcp import. Jest gives every test
// file its own copy of `process.env`, which `os.homedir()` cannot see, so the
// fake home is applied to `os.homedir()` itself (and to HOME/USERPROFILE for
// code that reads them directly).
beforeAll(async () => {
  fakeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'locopilot-mcp-test-'));
  const mcpDir = path.join(fakeHome, '.locopilot');
  await fsp.mkdir(mcpDir, { recursive: true });
  jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  // Server with a glob autoApprove list (short form) and one with a
  // long-form pattern. Transports are deliberately invalid — these
  // servers must never actually connect; the tests only exercise the
  // gating and dispatch seams, which fail closed before any transport.
  await fsp.writeFile(
    path.join(mcpDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        globtest: {
          name: 'globtest',
          transport: { type: 'stdio', command: 'definitely-not-a-real-binary' },
          autoApprove: ['list_*', 'exact_tool'],
        },
        longform: {
          name: 'longform',
          transport: { type: 'stdio', command: 'definitely-not-a-real-binary' },
          autoApprove: ['mcp__longform__*'],
        },
      },
    })
  );

  ({ handleToolCall } = await import('../src/tools/tools.ts'));
  ({ isAutoApprovedMCPTarget } = await import('../src/tools/impl/mcpTool.ts'));
  ({ executeNestedToolCall } = await import('../src/tools/impl/subAgentTool.ts'));
  ({ noopToolOutputSink } = await import('../src/tools/toolOutput.ts'));
});

afterAll(async () => {
  jest.restoreAllMocks();
  await fsp.rm(fakeHome, { recursive: true, force: true });
});

function makeToolCall(name, args) {
  return { id: 'call_test_1', type: 'function', function: { name, arguments: args } };
}

function makeContext(approvalRequester) {
  return {
    yoloMode: false,
    webSearch: {},
    subAgent: {
      baseUrl: 'http://localhost:11434',
      model: 'test-model',
      numCtx: 4096,
      tools: [],
      approvalRequester,
    },
  };
}

/** Runs one tool call as a sub-agent would, against an approval ledger. */
function runNested(toolCall, requester, ledger = new Set()) {
  return executeNestedToolCall(
    'a1',
    toolCall,
    noopToolOutputSink,
    undefined,
    makeContext(requester),
    undefined,
    ledger
  );
}

describe('isAutoApprovedMCPTarget (dispatcher-parity glob semantics)', () => {
  test.each([
    ['an exact autoApprove entry matches', 'globtest', 'exact_tool', true],
    ['a short-form glob pattern matches a bare tool name', 'globtest', 'list_issues', true],
    ['a short-form glob does not match other prefixes', 'globtest', 'create_issue', false],
    ['a long-form mcp__server__* pattern matches', 'longform', 'anything', true],
    ['an unknown server is not auto-approved', 'no_such_server', 'list_issues', false],
  ])('%s', async (_label, server, tool, expected) => {
    expect(await isAutoApprovedMCPTarget(server, tool)).toBe(expected);
  });
});

describe("bug 1 — handleToolCall dispatches namespaced 'mcp__*' calls", () => {
  test('a namespaced call reaches the MCP layer', async () => {
    const result = await handleToolCall(
      'mcp__no_such_server__list_issues',
      {},
      undefined,
      noopToolOutputSink
    );
    expect(result.content.startsWith('[MCP error:')).toBe(true);
    // the call did not fall through to [Unknown tool]
    expect(result.content.startsWith('[Unknown tool')).toBe(false);
  });

  test.each([
    ["an unparseable 'mcp__broken'", 'mcp__broken'],
    ['a plain unknown tool', 'definitely_not_a_tool'],
  ])('%s still returns [Unknown tool]', async (_label, name) => {
    const result = await handleToolCall(name, {}, undefined, noopToolOutputSink);
    expect(result.content.startsWith('[Unknown tool')).toBe(true);
  });
});

describe('bug 2 — the sub-agent mcp_call approval ledger', () => {
  const mcpCall = (server, tool) => makeToolCall('mcp_call', { server, tool, arguments: {} });

  test('an approved mcp_call records the immediate target in the ledger and executes', async () => {
    const ledger = new Set();
    const requester = jest.fn(async () => ({ approved: true, grantedTools: [] }));

    const result = await runNested(mcpCall('unconfigured_srv', 'do_thing'), requester, ledger);

    // the user is prompted exactly once
    expect(requester).toHaveBeenCalledTimes(1);
    expect(ledger.has('mcp__unconfigured_srv__do_thing')).toBe(true);
    // the dispatcher must not reject an approved call...
    expect(result.content.startsWith('[MCP call requires approval')).toBe(false);
    // ...execution reaches the MCP layer
    expect(result.content.startsWith('[MCP error:')).toBe(true);
  });

  test('a pre-approved target skips the prompt entirely', async () => {
    const ledger = new Set(['mcp__unconfigured_srv__do_thing']);
    const requester = jest.fn(async () => ({ approved: true }));

    const result = await runNested(mcpCall('unconfigured_srv', 'do_thing'), requester, ledger);

    expect(requester).not.toHaveBeenCalled();
    expect(result.content.startsWith('[MCP error:')).toBe(true);
  });

  test('an autoApprove glob match skips the prompt', async () => {
    const requester = jest.fn(async () => ({ approved: true }));

    const result = await runNested(mcpCall('globtest', 'list_issues'), requester);

    expect(requester).not.toHaveBeenCalled();
    expect(result.content.startsWith('[MCP error:')).toBe(true);
  });

  // Regression for the bug where the sub-agent gate read `toolArgs.server` /
  // `toolArgs.tool` to derive the target. A direct `mcp__<server>__<tool>`
  // call has empty `toolArgs`, so the autoApprove check was always skipped and
  // the user was prompted even when the server's `autoApprove: ['list_*']`
  // covered it.
  test('an autoApprove glob match skips the prompt for a direct namespaced call', async () => {
    const requester = jest.fn(async () => ({ approved: true }));

    const result = await runNested(makeToolCall('mcp__globtest__list_issues', {}), requester);

    expect(requester).not.toHaveBeenCalled();
    expect(result.content.startsWith('[MCP error:')).toBe(true);
  });

  test('a denied mcp_call rejects without touching the ledger', async () => {
    const ledger = new Set();
    const requester = jest.fn(async () => ({ approved: false }));

    const result = await runNested(mcpCall('unconfigured_srv', 'do_thing'), requester, ledger);

    expect(result.content).toBe('[MCP call rejected by user]');
    expect(ledger.size).toBe(0);
  });

  test('grantedTools entries from unconfigured servers are rejected', async () => {
    const ledger = new Set();
    const requester = async () => ({
      approved: true,
      grantedTools: ['mcp__ghost_server__tool_x'],
    });

    await runNested(mcpCall('unconfigured_srv', 'do_thing'), requester, ledger);

    // an unverifiable grantedTools entry must not enter the ledger
    expect(ledger.has('mcp__ghost_server__tool_x')).toBe(false);
    // the immediate approved target is still recorded
    expect(ledger.has('mcp__unconfigured_srv__do_thing')).toBe(true);
  });

  test('grantedTools entries for configured servers are accepted', async () => {
    const ledger = new Set();
    const requester = async () => ({
      approved: true,
      grantedTools: ['mcp__globtest__anything'],
    });

    await runNested(mcpCall('unconfigured_srv', 'do_thing'), requester, ledger);

    expect(ledger.has('mcp__globtest__anything')).toBe(true);
  });
});

describe("bug 1 — sub-agent direct 'mcp__*' calls dispatch through the MCP layer", () => {
  test('a direct namespaced call reaches the MCP layer with a derived ledger', async () => {
    const ledger = new Set(['mcp__unconfigured_srv__do_thing']);
    const requester = jest.fn(async () => ({ approved: true }));

    const result = await runNested(
      makeToolCall('mcp__unconfigured_srv__do_thing', { extra: 'arg' }),
      requester,
      ledger
    );

    // a pre-approved direct namespaced call must not prompt
    expect(requester).not.toHaveBeenCalled();
    expect(result.content.startsWith('[MCP error:')).toBe(true);
  });

  test('an unapproved direct namespaced call prompts and records the target', async () => {
    const ledger = new Set();
    const requester = jest.fn(async () => ({ approved: true, grantedTools: [] }));

    await runNested(makeToolCall('mcp__unconfigured_srv__fresh_tool', {}), requester, ledger);

    expect(requester).toHaveBeenCalledTimes(1);
    expect(ledger.has('mcp__unconfigured_srv__fresh_tool')).toBe(true);
  });

  test('the run_command approval flow is unchanged', async () => {
    const ledger = new Set();
    const requester = jest.fn(async () => ({ approved: false }));

    const result = await runNested(
      makeToolCall('run_command', { command: 'echo hi' }),
      requester,
      ledger
    );

    expect(requester).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('[Command rejected by user]');
    // run_command decisions must not touch the MCP ledger
    expect(ledger.size).toBe(0);
  });
});
