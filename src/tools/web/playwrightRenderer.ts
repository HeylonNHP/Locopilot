import type { Browser, BrowserContext, Page } from 'playwright';

import { DEFAULT_WEB_REQUEST_TIMEOUT_MS } from '@/constants';

import { buildWebRequestHeaders } from './webRequestHeaders';

export const DEFAULT_USER_AGENT = 'Locopilot/1.0 (+https://ollama.com)';
const BROWSER_RENDER_TIMEOUT_MS = 15_000;
const MIN_BROWSER_FALLBACK_TEXT_LENGTH = 300;

/**
 * Emergency opt-out for the shared-browser pool. Set
 * `LOCOPILOT_DISABLE_BROWSER_POOL=1` to force per-call browser launches
 * (the legacy behavior). Used to roll back without a code change if the
 * pool regresses in production.
 */
const BROWSER_POOL_DISABLED = process.env.LOCOPILOT_DISABLE_BROWSER_POOL === '1';

const JS_HEAVY_PATTERNS = [
  /__next_data__/i,
  /__nuxt__/i,
  /window\.__initial_state__/i,
  /window\.__apollo_state__/i,
  /data-reactroot/i,
  /data-react/i,
  /ng-version/i,
  /id=["']?(?:__next|__nuxt|root|app)["']?/i,
];

export interface RenderedPage {
  html: string;
  finalUrl: string;
}

interface PlaywrightRenderSettings {
  requestTimeoutMs: number;
  cookieHeader?: string;
}

/**
 * Thrown by `BrowserPool.withPage` when the underlying browser process has
 * died (closed target, browser-disconnected, etc.). Callers can catch this
 * and fall back to a per-call launch for a single render without evicting
 * the whole search.
 */
export class BrowserPoolExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserPoolExhaustedError';
  }
}

/**
 * Owns a single headless Chromium browser for the lifetime of a tool call.
 * Lazy-launches on first `withPage`; closes the browser (and only the
 * browser — per-call contexts are owned by their callers).
 *
 * Designed to be created at the top of a tool's `run()` and closed in a
 * `finally`. Multiple `withPage` calls share the same Chromium but each get
 * their own `BrowserContext` so cookies / storage stay isolated per URL.
 */
export class BrowserPool {
  private browserPromise: Promise<Browser> | null = null;

  /**
   * Run `fn` against a freshly-created context+page on the shared browser.
   * Crashes the pool if the browser errors out so the next call launches
   * a fresh one — never strands the caller on a dead handle.
   */
  async withPage<T>(
    url: string,
    settings: PlaywrightRenderSettings,
    signal: AbortSignal | undefined,
    fn: (context: BrowserContext, page: Page) => Promise<T>
  ): Promise<T> {
    if (BROWSER_POOL_DISABLED) {
      throw new BrowserPoolExhaustedError('Browser pool disabled via env flag');
    }

    let browser: Browser;
    try {
      browser = await this.getBrowser();
    } catch (err) {
      // First-launch failure: do not silently swallow. Surface as exhausted
      // so callers can fall back to a one-off launch.
      this.browserPromise = null;
      throw new BrowserPoolExhaustedError(
        `Browser pool failed to launch: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const headers = buildWebRequestHeaders(
      url,
      settings.cookieHeader ? { cookieHeader: settings.cookieHeader } : undefined
    );
    const extraHTTPHeaders: Record<string, string> = {};
    if (headers['Accept-Language']) extraHTTPHeaders['Accept-Language'] = headers['Accept-Language'];
    if (headers.Referer) extraHTTPHeaders.Referer = headers.Referer;
    if (headers.Cookie) extraHTTPHeaders['Cookie'] = headers.Cookie;

    let context: BrowserContext | null = null;
    try {
      context = await browser.newContext({
        userAgent: headers['User-Agent'] ?? DEFAULT_USER_AGENT,
        extraHTTPHeaders,
        ...(signal ? { signal } : {}),
      });
      const page = await context.newPage();
      try {
        return await fn(context, page);
      } finally {
        await context.close().catch(() => {});
      }
    } catch (err) {
      // If the shared browser died mid-render, evict it so the next call
      // triggers a fresh launch. Re-throw a typed error so the caller can
      // opt to fall back to per-call rendering for just this one page.
      const message = err instanceof Error ? err.message : String(err);
      if (isBrowserCrashMessage(message)) {
        this.browserPromise = null;
        try {
          await browser.close().catch(() => {});
        } catch {
          // ignore
        }
        throw new BrowserPoolExhaustedError(message);
      }
      // Non-crash error: still close the context we opened, but keep the
      // pool alive for subsequent renders.
      if (context) {
        await context.close().catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Idempotent. Safe to call even if no browser was ever launched.
   */
  async close(): Promise<void> {
    const pending = this.browserPromise;
    this.browserPromise = null;
    if (!pending) return;
    try {
      const browser = await pending;
      // close() on an already-closed browser is a no-op in Playwright.
      await browser.close();
    } catch {
      // Browser may already be dead; nothing meaningful to do here.
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      const launcher = async (): Promise<Browser> => {
        const playwrightModule = await import('playwright');
        return playwrightModule.chromium.launch({ headless: true });
      };
      this.browserPromise = launcher();
    }
    return this.browserPromise;
  }
}

function isBrowserCrashMessage(message: string): boolean {
  return (
    message.includes('Target closed') ||
    message.includes('Browser has been closed') ||
    message.includes('Browser has disconnected') ||
    message.includes('Connection closed') ||
    message.includes('Context closed')
  );
}

export function shouldTryBrowserFallback(html: string, text: string): boolean {
  if (text.length >= MIN_BROWSER_FALLBACK_TEXT_LENGTH) {
    return false;
  }

  if (JS_HEAVY_PATTERNS.some((pattern) => pattern.test(html))) {
    return true;
  }

  const scriptCount = (html.match(/<script\b/gi) ?? []).length;
  const noscriptCount = (html.match(/<noscript\b/gi) ?? []).length;
  const textIsVeryThin = text.length < 120;
  const htmlLooksAppLike = html.length > 3000 && scriptCount >= 3;

  return (textIsVeryThin && (scriptCount >= 3 || noscriptCount > 0)) || htmlLooksAppLike;
}

export function shouldPreferRenderedText(staticText: string, renderedText: string): boolean {
  if (renderedText.length === 0) {
    return false;
  }

  if (staticText.length === 0) {
    return true;
  }

  if (renderedText.length >= staticText.length) {
    return true;
  }

  return (
    staticText.length < MIN_BROWSER_FALLBACK_TEXT_LENGTH &&
    renderedText.length >= Math.floor(staticText.length * 0.75)
  );
}

/**
 * Drive a freshly-created page to `url`, wait for networkidle, and return
 * its rendered HTML. Used by both the pool path and the per-call-fallback
 * path. Errors here are not caught — the caller decides whether they
 * represent a crashed shared browser (pool evict + fall back) or an
 * ordinary failure.
 */
async function navigateAndRead(
  page: Page,
  url: string,
  signal: AbortSignal | undefined
): Promise<RenderedPage | null> {
  const timeoutMs = Math.min(DEFAULT_WEB_REQUEST_TIMEOUT_MS, BROWSER_RENDER_TIMEOUT_MS);

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
      ...(signal ? { signal } : {}),
    });
  } catch {
    // Continue with the partially rendered DOM if navigation times out.
  }

  await page
    .waitForLoadState('networkidle', {
      timeout: Math.min(timeoutMs, 5000),
      ...(signal ? { signal } : {}),
    })
    .catch(() => {});

  const html = await page.content();
  const finalUrl = page.url() || url;
  if (!html.trim()) {
    return null;
  }

  return { html, finalUrl };
}

/**
 * Render `url` with Playwright. If `pool` is supplied, reuses the shared
 * browser owned by the caller. On pool failure, falls back to a one-off
 * launch so a single bad page doesn't take down the rest of the call.
 *
 * If `pool` is omitted, performs a self-contained per-call launch (the
 * legacy path — used by `fetch_url` for single-shot fetches).
 */
export async function renderWithPlaywright(
  url: string,
  settings: PlaywrightRenderSettings,
  signal?: AbortSignal,
  pool?: BrowserPool
): Promise<RenderedPage | null> {
  if (pool) {
    try {
      return await pool.withPage(url, settings, signal, async (_context, page) =>
        navigateAndRead(page, url, signal)
      );
    } catch (err) {
      if (err instanceof BrowserPoolExhaustedError) {
        // Pool is dead or disabled — fall back to a one-off launch for
        // this single render. The next render through the pool will retry.
        return renderWithOwnBrowser(url, settings, signal);
      }
      throw err;
    }
  }
  return renderWithOwnBrowser(url, settings, signal);
}

/**
 * The original per-call-launch behavior, extracted so it can serve as both
 * the no-pool default and the fallback path when the pool is exhausted.
 */
async function renderWithOwnBrowser(
  url: string,
  settings: PlaywrightRenderSettings,
  signal?: AbortSignal
): Promise<RenderedPage | null> {
  try {
    const playwrightModule = await import('playwright');
    const browser = await playwrightModule.chromium.launch({ headless: true });

    try {
      const headers = buildWebRequestHeaders(
        url,
        settings.cookieHeader ? { cookieHeader: settings.cookieHeader } : undefined
      );

      const extraHTTPHeaders: Record<string, string> = {};
      if (headers['Accept-Language'])
        extraHTTPHeaders['Accept-Language'] = headers['Accept-Language'];
      if (headers.Referer) extraHTTPHeaders.Referer = headers.Referer;
      if (headers.Cookie) extraHTTPHeaders['Cookie'] = headers.Cookie;

      const context = await browser.newContext({
        userAgent: headers['User-Agent'] ?? DEFAULT_USER_AGENT,
        extraHTTPHeaders,
        ...(signal ? { signal } : {}),
      });

      try {
        const page = await context.newPage();
        try {
          return await navigateAndRead(page, url, signal);
        } finally {
          await page.close().catch(() => {});
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}
