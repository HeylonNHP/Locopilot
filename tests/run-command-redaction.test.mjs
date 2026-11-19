/**
 * run_command tells the model what is done to its output, and whether secret
 * redaction is on right now.
 *
 * The user can switch redaction off in Settings, so the standing description
 * says what CAN be redacted and each request adds ON or OFF. The claims are
 * checked against the real capture: the carriage returns and control
 * sequences really are removed, a secret really is replaced when the setting
 * is on and really is kept when it is off. The route case calls the real
 * `POST` handler and reads the tool list the provider was actually sent.
 */
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { enterScratchCwd, startFakeOllama } from './helpers/fakeOllama.mjs';

const MODEL = 'main-model';

let scratch;
let fakeHome;
let provider;
let POST;
let toolRegistry;
let stopMCPConfigWatcher;
let getClientManager;
let createSession;
let recordProviderModels;
let invalidateModelIndex;
let setModelIndexDeps;
let enterRequestScope;
let runCommandToolSchema;
let describeRedactionState;
let withRunCommandRedactionState;

function writeConfig(redactSecrets) {
  fs.writeFileSync(
    `${scratch.dir}/config.json`,
    JSON.stringify({
      providers: [{ id: 'a', name: 'Provider A', provider: 'ollama', baseUrl: provider.baseUrl }],
      model: MODEL,
      numCtx: 8192,
      chatTimeoutMs: 20_000,
      yolo: true,
      thinkingEnabled: false,
      promptTimestamps: false,
      citeSources: false,
      redactSecrets,
      webSearch: {},
      completionMode: 'normal',
      maxPromptLoopIterations: 3,
    })
  );
}

beforeAll(async () => {
  scratch = enterScratchCwd('locopilot-redaction');
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'locopilot-redaction-home-'));
  jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  provider = await startFakeOllama(() => ({ text: 'ok' }));
  writeConfig(true);
  // The registry and the route reach jsdom only through the web tools, which
  // these tests never call; its ESM-only dependency cannot be required on
  // Node < 24.9 (same stub as tests/chat-route-pair-gates.test.mjs).
  jest.unstable_mockModule('jsdom', () => ({ JSDOM: class {}, VirtualConsole: class {} }));
  ({ POST } = await import('../src/app/api/chat/route.ts'));
  ({ toolRegistry } = await import('../src/tools/toolRegistry.ts'));
  ({ stopMCPConfigWatcher } = await import('../src/mcp/configWatcher.ts'));
  ({ getClientManager } = await import('../src/mcp/clientManager.ts'));
  ({ createSession } = await import('../src/services/history.ts'));
  ({
    enterRequestScope,
    runCommandToolSchema,
    describeRedactionState,
    withRunCommandRedactionState,
  } = await import('../src/tools/impl/runCommandTool.ts'));
  ({ recordProviderModels, invalidateModelIndex, setModelIndexDeps } =
    await import('../src/services/modelIndex.ts'));
  setModelIndexDeps({ fetchModels: async () => [MODEL] });
  invalidateModelIndex();
  recordProviderModels('a', provider.baseUrl, [MODEL]);
}, 60_000);

afterAll(async () => {
  setModelIndexDeps(null);
  await provider?.close();
  stopMCPConfigWatcher?.();
  await getClientManager?.().closeAll();
  scratch?.leave();
  jest.restoreAllMocks();
  try {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    // Best effort: an empty directory in the OS temp folder.
  }
});

describe('the standing description', () => {
  test('says what is removed and what can be redacted, and that the setting is the user’s', () => {
    const { description } = runCommandToolSchema;
    expect(description).toContain(String.raw`carriage returns (\r)`);
    expect(description).toContain('control sequences');
    expect(description).toContain('"Redact secrets in command output" setting');
    expect(description).toContain('[REDACTED]');
    for (const kind of [
      'API keys and tokens',
      'bearer tokens',
      'JSON web tokens',
      'private key blocks',
      'passwords in URLs',
      'PASSWORD',
    ]) {
      expect(description).toContain(kind);
    }
    expect(description).not.toMatch(/currently (ON|OFF)/);
  });
});

describe('describeRedactionState / withRunCommandRedactionState', () => {
  const tools = [
    { function: { name: 'run_command', description: 'RC' } },
    { function: { name: 'read_file', description: 'RF' } },
  ];

  test('the sentence says ON or OFF and what that means', () => {
    expect(describeRedactionState(true)).toMatch(/currently ON.*\[REDACTED]/);
    expect(describeRedactionState(false)).toMatch(/currently OFF.*raw.*secrets included/);
  });

  test.each([
    [true, 'currently ON'],
    [false, 'currently OFF'],
  ])('redactSecrets=%s changes only run_command, and not the input list', (on, text) => {
    const result = withRunCommandRedactionState(tools, on);
    expect(result[0].function.description).toContain('RC ');
    expect(result[0].function.description).toContain(text);
    expect(result[1]).toBe(tools[1]);
    expect(tools[0].function.description).toBe('RC');
  });
});

describe('what the capture really does', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const run = (redactSecrets) => {
    enterRequestScope();
    return toolRegistry.get('run_command').execute(
      {
        // String.fromCharCode(13) is a real carriage return, whatever the shell
        // does to a backslash-r typed in the command line.
        command: `node -e "process.stdout.write('line1' + String.fromCharCode(13, 10) + 'TOKEN=${secret}' + String.fromCharCode(10))"`,
      },
      undefined,
      undefined,
      { yoloMode: true, redactSecrets }
    );
  };

  test('on: a secret becomes [REDACTED] and the carriage return is gone', async () => {
    const { content } = await run(true);
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain(secret);
    expect(content).not.toContain('\r');
  });

  test('off: the secret is kept, and the carriage return is still removed', async () => {
    const { content } = await run(false);
    expect(content).toContain(secret);
    expect(content).not.toContain('[REDACTED]');
    expect(content).not.toContain('\r');
  });
});

describe('the tool list a provider is sent', () => {
  const runCommandDescription = (request) =>
    request.body.tools.find((tool) => tool.function.name === 'run_command').function.description;

  async function turn() {
    provider.requests.length = 0;
    const sessionId = createSession('redaction', {
      model: MODEL,
      providerId: 'a',
      compaction: { kind: 'inherit-default' },
      reasoningEffort: null,
      compactionReasoningEffort: null,
    });
    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hello' }],
          model: MODEL,
          providerId: 'a',
          sessionId,
        }),
      })
    );
    await response.text();
    return provider.requests.find((request) => request.body.stream === true);
  }

  test('says redaction is ON when the setting is on', async () => {
    writeConfig(true);
    const description = runCommandDescription(await turn());
    expect(description).toContain('Secret redaction is currently ON');
    expect(description).not.toContain('currently OFF');
  }, 30_000);

  test('says redaction is OFF when the user has turned it off', async () => {
    writeConfig(false);
    const description = runCommandDescription(await turn());
    expect(description).toContain('Secret redaction is currently OFF');
    expect(description).not.toContain('currently ON');
  }, 30_000);
});
