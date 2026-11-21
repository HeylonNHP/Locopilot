import { afterAll, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempHome = await mkdtemp(path.join(tmpdir(), 'locopilot-oauth-readiness-'));
let spawnBehavior;

globalThis.__oauthSpawnBehavior = (...args) => spawnBehavior(...args);

jest.unstable_mockModule('node:os', () => {
  const actual = jest.requireActual('node:os');
  const patched = { ...actual, homedir: () => tempHome };
  return { ...patched, default: patched };
});
jest.unstable_mockModule('node:child_process', () => {
  const actual = jest.requireActual('node:child_process');
  return { ...actual, spawn: (...args) => globalThis.__oauthSpawnBehavior(...args) };
});

const { buildOAuthProvider } = await import('../src/mcp/oauthProvider.ts');

const configFor = (name) => ({
  name,
  transport: { type: 'http', url: 'https://mcp.example.test/mcp' },
});

function launchChild(onLaunch) {
  // The code under test attaches `.once('spawn' | 'error')` to a ChildProcess, which is an EventEmitter.
  // eslint-disable-next-line unicorn/prefer-event-target
  const child = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => {
    onLaunch?.();
    child.emit('spawn');
  });
  return child;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

afterAll(async () => {
  delete globalThis.__oauthSpawnBehavior;
  await rm(tempHome, { recursive: true, force: true });
});

describe('OAuth callback listener readiness barrier', () => {
  test('browser launch occurs only after callback server accepts the matching callback', async () => {
    let callbackStatus;
    let resolveCode;
    const receivedCode = new Promise((resolve) => {
      resolveCode = resolve;
    });
    const failures = [];
    const flow = {
      signal: new AbortController().signal,
      onCode: (code, returnedState) => resolveCode({ code, returnedState }),
      onFailure: (message) => failures.push(message),
    };
    // Rebuild with hooks so the real listener outcome is observable.
    const hookedProvider = await buildOAuthProvider(configFor('readiness-success-hooked'), {
      interactive: true,
      flow,
    });
    const hookedState = await hookedProvider.state();
    const hookedCallbackUrl = new URL(hookedProvider.redirectUrl);
    spawnBehavior = () =>
      launchChild(async () => {
        const target = new URL(
          hookedCallbackUrl.pathname,
          `http://127.0.0.1:${hookedCallbackUrl.port}`
        );
        target.searchParams.set('state', hookedState);
        target.searchParams.set('code', 'readiness-code');
        callbackStatus = await get(target);
      });

    await hookedProvider.redirectToAuthorization(new URL('https://idp.example.test/authorize'));
    const code = await receivedCode;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(callbackStatus).toBe(200);
    expect(code).toEqual({ code: 'readiness-code', returnedState: hookedState });
    expect(failures).toEqual([]);
  });

  test('a bind failure does not launch the browser and reports callback failure', async () => {
    const serverName = 'readiness-busy-hooked';
    const failures = [];
    const hookedProvider = await buildOAuthProvider(configFor(serverName), {
      interactive: true,
      flow: {
        signal: new AbortController().signal,
        onCode: () => {},
        onFailure: (message) => failures.push(message),
      },
    });
    const blockedPort = Number(new URL(hookedProvider.redirectUrl).port);
    const blocker = createServer();
    await listen(blocker, blockedPort);
    let launches = 0;
    spawnBehavior = () => {
      launches += 1;
      return launchChild();
    };
    // The callback port became occupied after provider construction, between
    // the free-port probe and the authoritative callback-server bind.
    expect(Number(new URL(hookedProvider.redirectUrl).port)).toBe(blockedPort);
    await hookedProvider.state();
    await hookedProvider.redirectToAuthorization(new URL('https://idp.example.test/authorize'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/already in use/);
    await close(blocker);
  });

  test('browser launch errors close the already-listening callback server', async () => {
    const failures = [];
    const provider = await buildOAuthProvider(configFor('readiness-launch-error'), {
      interactive: true,
      flow: {
        signal: new AbortController().signal,
        onCode: () => {},
        onFailure: (message) => failures.push(message),
      },
    });
    const address = new URL(provider.redirectUrl);
    await provider.state();
    spawnBehavior = () => {
      // The code under test attaches `.once('spawn' | 'error')` to a ChildProcess, which is an EventEmitter.
      // eslint-disable-next-line unicorn/prefer-event-target
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('error', new Error('browser unavailable')));
      return child;
    };

    await provider.redirectToAuthorization(new URL('https://idp.example.test/authorize'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(failures).toContain('Could not launch browser for OAuth authorization');

    // The callback listener was bound before the failed launch and must now be closed.
    const probe = createServer();
    await expect(listen(probe, Number(address.port))).resolves.toBe(Number(address.port));
    await close(probe);
  });
});
