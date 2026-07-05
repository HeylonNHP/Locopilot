const DEFAULT_WEB_USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0',
];

const DEFAULT_WEB_USER_AGENT = DEFAULT_WEB_USER_AGENTS[0]!;
const DEFAULT_WEB_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const DEFAULT_WEB_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
const WEB_COOKIE_ENV_KEYS = ['LOCOPILOT_WEB_COOKIE'];

export interface WebRequestHeaderOptions {
  cookieHeader?: string;
  referer?: string;
  userAgent?: string;
}

function normalizeHeaderValue(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function chooseRandomUserAgent(): string {
  const index = Math.floor(Math.random() * DEFAULT_WEB_USER_AGENTS.length);
  return DEFAULT_WEB_USER_AGENTS[index] ?? DEFAULT_WEB_USER_AGENT;
}

function buildDefaultReferer(targetUrl: string): string | undefined {
  try {
    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return undefined;
    }
    return `${parsedUrl.origin}/`;
  } catch {
    return undefined;
  }
}

function resolveCookieHeader(explicitCookieHeader?: string): string | undefined {
  const explicitHeader = normalizeHeaderValue(explicitCookieHeader);
  if (explicitHeader) {
    return explicitHeader;
  }

  for (const envKey of WEB_COOKIE_ENV_KEYS) {
    const envHeader = normalizeHeaderValue(process.env[envKey]);
    if (envHeader) {
      return envHeader;
    }
  }

  return undefined;
}

export function buildWebRequestHeaders(
  targetUrl: string,
  options: WebRequestHeaderOptions = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': normalizeHeaderValue(options.userAgent) ?? chooseRandomUserAgent(),
    Accept: DEFAULT_WEB_ACCEPT,
    'Accept-Language': DEFAULT_WEB_ACCEPT_LANGUAGE,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    DNT: '1',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
  };

  const referer = normalizeHeaderValue(options.referer) ?? buildDefaultReferer(targetUrl);
  if (referer) {
    headers.Referer = referer;
  }

  const cookieHeader = resolveCookieHeader(options.cookieHeader);
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  return headers;
}

export { DEFAULT_WEB_USER_AGENT };
