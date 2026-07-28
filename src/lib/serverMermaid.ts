/**
 * Server-side Mermaid environment shim.
 *
 * Mermaid depends on DOMPurify, which expects a browser `window`. In Node.js,
 * DOMPurify's default export is the unbound factory function
 * `createDOMPurify(window)` and has no `.addHook()` method. Mermaid calls
 * `.addHook()` during `parse()` / `initialize()`, so a JSDOM window must be
 * present before the `mermaid` package is first imported.
 *
 * This helper creates a temporary JSDOM environment, exposes it as
 * `globalThis.window` / `globalThis.document` only for the duration of the
 * Mermaid operation, then restores the original values. It avoids permanently
 * polluting the global scope.
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
 * Runs `operation(mermaid)` with a temporary JSDOM-backed `window`/`document`
 * installed on `globalThis`. Mermaid is loaded while the shim is active so that
 * its transitive `dompurify` import resolves to a window-bound instance instead
 * of the Node.js factory function.
 *
 * If loading jsdom, dompurify, or mermaid fails, a `ServerMermaidEnvironmentError`
 * is thrown. Errors thrown by `operation` are re-thrown as-is.
 */
export async function withServerMermaidEnvironment<T>(
  operation: (mermaid: Mermaid) => Promise<T>
): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const shimWindow = dom.window as unknown as Window & typeof globalThis;
  const shimDocument = shimWindow.document;

  const globalShim = globalThis as unknown as GlobalShim;
  const previousWindow = globalShim.window;
  const previousDocument = globalShim.document;

  globalShim.window = shimWindow;
  globalShim.document = shimDocument;

  let mermaid: Mermaid;
  try {
    // Prime the DOMPurify module cache with a window-bound instance before
    // mermaid imports it. Without a window, mermaid's transitive import of
    // `dompurify` resolves to the unbound factory in Node.js and throws
    // "default.addHook is not a function".
    await import('dompurify');

    const mod = await import('mermaid');
    mermaid = mod.default;
  } catch (err) {
    globalShim.window = previousWindow;
    globalShim.document = previousDocument;
    throw new ServerMermaidEnvironmentError(err);
  }

  try {
    return await operation(mermaid);
  } finally {
    globalShim.window = previousWindow;
    globalShim.document = previousDocument;
  }
}
