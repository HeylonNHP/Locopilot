import { buildWebRequestHeaders } from './webRequestHeaders';

export const DEFAULT_USER_AGENT = 'Locopilot/1.0 (+https://ollama.com)';
const BROWSER_RENDER_TIMEOUT_MS = 15_000;
const MIN_BROWSER_FALLBACK_TEXT_LENGTH = 300;

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

export async function renderWithPlaywright(
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
        const timeoutMs = Math.min(settings.requestTimeoutMs, BROWSER_RENDER_TIMEOUT_MS);

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