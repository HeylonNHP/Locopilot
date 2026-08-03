/**
 * Server-side Mermaid environment shim.
 *
 * Mermaid depends on DOMPurify, which expects a browser `window`. In Node.js,
 * DOMPurify's default export is the unbound factory function
 * `createDOMPurify(window)` and has no `.addHook()` method. Mermaid calls
 * `.addHook()` during `parse()` / `initialize()`, so a JSDOM window must be
 * present before the `mermaid` package is first imported.
 *
 * This helper creates a single JSDOM window once for the process lifetime and
 * exposes it as `globalThis.window` / `globalThis.document`, then runs the
 * Mermaid operation against the cached, window-bound `mermaid` module.
 *
 * Why a persistent singleton instead of one JSDOM per call? `mermaid` and
 * `dompurify` are Node module singletons that bind to whatever window they are
 * first imported against. If we created a fresh JSDOM per call, we could never
 * call `dom.window.close()` on it — the cached modules keep a reference to its
 * window/document — so every prior revision leaked the window (and the first
 * one permanently). A single long-lived window avoids both the leak and the
 * per-call allocation. `globalThis.window`/`document` are set once at init and
 * never mutated afterwards, so concurrent tool calls cannot race on them.
 */

import type { Mermaid } from 'mermaid';

/**
 * Thrown when the server-side Mermaid environment (jsdom / dompurify /
 * mermaid) cannot be set up. Distinguishing this from a diagram parse error
 * lets callers surface a clearer "failed to load" message.
 */
export class ServerMermaidEnvironmentError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ServerMermaidEnvironmentError';
  }
}

interface GlobalShim {
  document?: Document | undefined;
  window?: (Window & typeof globalThis) | undefined;
}

/**
 * Lazily-initialised singleton promise that builds the shared JSDOM-backed
 * environment and returns the window-bound `mermaid` module. Reset to `null`
 * if initialisation fails so a transient failure can be retried on the next
 * call.
 */
let environmentPromise: Promise<Mermaid> | null = null;

async function getMermaid(): Promise<Mermaid> {
  if (!environmentPromise) {
    environmentPromise = (async () => {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
      const shimWindow = dom.window as unknown as Window & typeof globalThis;
      const globalShim = globalThis as unknown as GlobalShim;
      // Install the window/document globals once so the transitive
      // `dompurify` import below resolves to a window-bound instance instead
      // of the Node.js factory function.
      globalShim.window = shimWindow;
      globalShim.document = shimWindow.document;

      // Prime the DOMPurify module cache with a window-bound instance before
      // mermaid imports it. Without a window, mermaid's transitive import of
      // `dompurify` resolves to the unbound factory in Node.js and throws
      // "default.addHook is not a function".
      await import('dompurify');

      const mod = await import('mermaid');
      return mod.default;
    })();
  }
  return environmentPromise;
}

/**
 * Runs `operation(mermaid)` against the shared, window-bound Mermaid module.
 * The environment is initialised lazily on first use and reused for the
 * process lifetime, so no per-call JSDOM is allocated (and none is leaked).
 *
 * If loading jsdom, dompurify, or mermaid fails, a
 * `ServerMermaidEnvironmentError` is thrown. Errors thrown by `operation` are
 * re-thrown as-is.
 */
export async function withServerMermaidEnvironment<T>(
  operation: (mermaid: Mermaid) => Promise<T>
): Promise<T> {
  let mermaid: Mermaid;
  try {
    mermaid = await getMermaid();
  } catch (err) {
    // A failed init may have been a transient import failure; allow the next
    // call to retry rather than caching the rejection.
    environmentPromise = null;
    throw new ServerMermaidEnvironmentError(err);
  }

  return operation(mermaid);
}
