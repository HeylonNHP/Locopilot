#!/usr/bin/env node
/**
 * Regression tests for the sub-agent / namespaced MCP fixes.
 *
 * Run with: npx tsx scripts/test-subagent-mcp.mjs
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

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ── Isolate the MCP config root BEFORE any @/mcp import ──────────────
const fakeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'locopilot-mcp-test-'));
const mcpDir = path.join(fakeHome, '.locopilot');
await fsp.mkdir(mcpDir, { recursive: true });
process.env.HOME = fakeHome;

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

const { handleToolCall } = await import('../src/tools/tools.ts');
const { isAutoApprovedMCPTarget } = await import('../src/tools/impl/mcpTool.ts');
const { executeNestedToolCall } = await import('../src/tools/impl/subAgentTool.ts');
const { noopToolOutputSink } = await import('../src/tools/toolOutput.ts');

let pass = 0;
let fail = 0;

async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
  }
}

console.log('isAutoApprovedMCPTarget (dispatcher-parity glob semantics)');

await checkAsync('exact autoApprove entry matches', async () => {
  assert.equal(await isAutoApprovedMCPTarget('globtest', 'exact_tool'), true);
});
await checkAsync('short-form glob pattern matches bare tool name', async () => {
  assert.equal(await isAutoApprovedMCPTarget('globtest', 'list_issues'), true);
});
await checkAsync('short-form glob does not match other prefixes', async () => {
  assert.equal(await isAutoApprovedMCPTarget('globtest', 'create_issue'), false);
});
await checkAsync('long-form mcp__server__* pattern matches', async () => {
  assert.equal(await isAutoApprovedMCPTarget('longform', 'anything'), true);
});
await checkAsync('unknown server is not auto-approved', async () => {
  assert.equal(await isAutoApprovedMCPTarget('no_such_server', 'list_issues'), false);
});

console.log("bug 1 — handleToolCall dispatches namespaced 'mcp__*' calls");

await checkAsync('namespaced call reaches the MCP layer', async () => {
  const result = await handleToolCall(
    'mcp__no_such_server__list_issues',
    {},
    undefined,
    noopToolOutputSink
  );
  assert.ok(
    result.content.startsWith('[MCP error:'),
    `expected [MCP error: prefix, got: ${result.content}`
  );
  assert.ok(
    !result.content.startsWith('[Unknown tool'),
    `namespaced call fell through to [Unknown tool]: ${result.content}`
  );
});
await checkAsync("unparseable 'mcp__broken' still returns [Unknown tool]", async () => {
  const result = await handleToolCall('mcp__broken', {}, undefined, noopToolOutputSink);
  assert.ok(
    result.content.startsWith('[Unknown tool'),
    `expected [Unknown tool fall-through, got: ${result.content}`
  );
});
await checkAsync('plain unknown tool still returns [Unknown tool]', async () => {
  const result = await handleToolCall('definitely_not_a_tool', {}, undefined, noopToolOutputSink);
  assert.ok(result.content.startsWith('[Unknown tool'), `got: ${result.content}`);
});

console.log('bug 2 — sub-agent mcp_call approval ledger');

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

await checkAsync(
  'approved mcp_call records the immediate target in the ledger and executes',
  async () => {
    let promptCount = 0;
    const ledger = new Set();
    const requester = async () => {
      promptCount += 1;
      return { approved: true, grantedTools: [] };
    };
    const result = await executeNestedToolCall(
      'a1',
      makeToolCall('mcp_call', { server: 'unconfigured_srv', tool: 'do_thing', arguments: {} }),
      noopToolOutputSink,
      undefined,
      makeContext(requester),
      undefined,
      ledger
    );
    assert.equal(promptCount, 1, 'user should be prompted exactly once');
    assert.ok(
      ledger.has('mcp__unconfigured_srv__do_thing'),
      `ledger missing approved target; has: ${[...ledger]}`
    );
    assert.ok(
      !result.content.startsWith('[MCP call requires approval'),
      `dispatcher rejected an approved call: ${result.content}`
    );
    assert.ok(
      result.content.startsWith('[MCP error:'),
      `expected execution to reach the MCP layer, got: ${result.content}`
    );
  }
);

await checkAsync('pre-approved target skips the prompt entirely', async () => {
  let promptCount = 0;
  const ledger = new Set(['mcp__unconfigured_srv__do_thing']);
  const requester = async () => {
    promptCount += 1;
    return { approved: true };
  };
  const result = await executeNestedToolCall(
    'a1',
    makeToolCall('mcp_call', { server: 'unconfigured_srv', tool: 'do_thing', arguments: {} }),
    noopToolOutputSink,
    undefined,
    makeContext(requester),
    undefined,
    ledger
  );
  assert.equal(promptCount, 0, 'pre-approved target must not re-prompt');
  assert.ok(
    result.content.startsWith('[MCP error:'),
    `expected execution to reach the MCP layer, got: ${result.content}`
  );
});

await checkAsync('autoApprove glob match skips the prompt', async () => {
  let promptCount = 0;
  const ledger = new Set();
  const requester = async () => {
    promptCount += 1;
    return { approved: true };
  };
  const result = await executeNestedToolCall(
    'a1',
    makeToolCall('mcp_call', { server: 'globtest', tool: 'list_issues', arguments: {} }),
    noopToolOutputSink,
    undefined,
    makeContext(requester),
    undefined,
    ledger
  );
  assert.equal(promptCount, 0, 'autoApprove-covered tool must not prompt');
  assert.ok(
    result.content.startsWith('[MCP error:'),
    `expected execution to reach the MCP layer, got: ${result.content}`
  );
});

await checkAsync(
  'autoApprove glob match skips the prompt for direct namespaced call',
  async () => {
    // Regression for the bug where the sub-agent gate read
    // `toolArgs.server` / `toolArgs.tool` to derive the target. A
    // direct `mcp__<server>__<tool>` call has empty `toolArgs`, so the
    // autoApprove check was always skipped and the user was prompted
    // even when the server's `autoApprove: ['list_*']` covered it.
    let promptCount = 0;
    const ledger = new Set();
    const requester = async () => {
      promptCount += 1;
      return { approved: true };
    };
    const result = await executeNestedToolCall(
      'a1',
      makeToolCall('mcp__globtest__list_issues', {}),
      noopToolOutputSink,
      undefined,
      makeContext(requester),
      undefined,
      ledger
    );
    assert.equal(
      promptCount,
      0,
      'autoApprove-covered direct namespaced call must not prompt'
    );
    assert.ok(
      result.content.startsWith('[MCP error:'),
      `expected execution to reach the MCP layer, got: ${result.content}`
    );
  }
);

await checkAsync('denied mcp_call rejects without touching the ledger', async () => {
  const ledger = new Set();
  const requester = async () => ({ approved: false });
  const result = await executeNestedToolCall(
    'a1',
    makeToolCall('mcp_call', { server: 'unconfigured_srv', tool: 'do_thing', arguments: {} }),
    noopToolOutputSink,
    undefined,
    makeContext(requester),
    undefined,
    ledger
  );
  assert.equal(result.content, '[MCP call rejected by user]');
  assert.equal(ledger.size, 0, 'denied call must not extend the ledger');
});

await checkAsync('grantedTools entries from unconfigured servers are rejected', async () => {
  const ledger = new Set();
  const requester = async () => ({
    approved: true,
    grantedTools: ['mcp__ghost_server__tool_x'],
  });
  await executeNestedToolCall(
    'a1',
    makeToolCall('mcp_call', { server: 'unconfigured_srv', tool: 'do_thing', arguments: {} }),
    noopToolOutputSink,
    undefined,
    makeContext(requester),
    undefined,
    ledger
  );
  assert.ok(
    !ledger.has('mcp__ghost_server__tool_x'),
    'unverifiable grantedTools entry entered the ledger'
  );
  assert.ok(
    ledger.has('mcp__unconfigured_srv__do_thing'),
    'immediate approved target must still be recorded'
  );
});

await checkAsync('grantedTools entries for configured servers are accepted', async () => {
  const ledger = new Set();
  const requester = async () => ({
    approved: true,
    grantedTools: ['mcp__globtest__anything'],
  });
  await executeNestedToolCall(
    'a1',
    makeToolCall('mcp_call', { server: 'unconfigured_srv', tool: 'do_thing', arguments: {} }),
    noopToolOutputSink,
    undefined,
    makeContext(requester),
    undefined,
    ledger
  );
  assert.ok(ledger.has('mcp__globtest__anything'), 'valid grantedTools entry missing');
});

console.log("bug 1 — sub-agent direct 'mcp__*' calls dispatch through the MCP layer");

await checkAsync('direct namespaced call reaches the MCP layer with derived ledger', async () => {
  let promptCount = 0;
  const ledger = new Set(['mcp__unconfigured_srv__do_thing']);
  const requester = async () => {
    promptCount += 1;
    return { approved: true };
  };
  const result = await executeNestedToolCall(
    'a1',
    makeToolCall('mcp__unconfigured_srv__do_thing', { extra: 'arg' }),
    noopToolOutputSink,
    undefined,
    makeContext(requester),
    undefined,
    ledger
  );
  assert.equal(promptCount, 0, 'pre-approved direct namespaced call must not prompt');
  assert.ok(
    result.content.startsWith('[MCP error:'),
    `expected [MCP error: from the dispatcher, got: ${result.content}`
  );
});

await checkAsync('unapproved direct namespaced call prompts and records the target', async () => {
  let promptCount = 0;
  const ledger = new Set();
  const requester = async () => {
    promptCount += 1;
    return { approved: true, grantedTools: [] };
  };
  await executeNestedToolCall(
    'a1',
    makeToolCall('mcp__unconfigured_srv__fresh_tool', {}),
    noopToolOutputSink,
    undefined,
    makeContext(requester),
    undefined,
    ledger
  );
  assert.equal(promptCount, 1, 'fresh namespaced call must prompt once');
  assert.ok(
    ledger.has('mcp__unconfigured_srv__fresh_tool'),
    'approved namespaced target missing from ledger'
  );
});

await checkAsync('run_command approval flow is unchanged', async () => {
  let prompted = 0;
  const ledger = new Set();
  const requester = async () => {
    prompted += 1;
    return { approved: false };
  };
  const result = await executeNestedToolCall(
    'a1',
    makeToolCall('run_command', { command: 'echo hi' }),
    noopToolOutputSink,
    undefined,
    makeContext(requester),
    undefined,
    ledger
  );
  assert.equal(prompted, 1, 'run_command must still prompt');
  assert.equal(result.content, '[Command rejected by user]');
  assert.equal(ledger.size, 0, 'run_command decisions must not touch the MCP ledger');
});

console.log(`\n${pass} passed, ${fail} failed`);
await fsp.rm(fakeHome, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
