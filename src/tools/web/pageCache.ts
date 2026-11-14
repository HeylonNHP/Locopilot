/**
 * In-memory cache of extracted-and-compacted pages for `web_search`.
 *
 * WHO USES IT. Only `WebSearchTool`. `fetch_url` never touches it: a model
 * that fetches a URL on purpose wants the live page, so the cache is not
 * something `fetchAndExtract` knows about; the search tool wraps its call.
 *
 * WHAT IS CACHED. The finished result (title, final URL, links and the text
 * after compaction): a hit costs no download, no extraction and no LLM call.
 * A page that was cut instead of summarised is never stored (see
 * `FetchedPage.truncated`), so a transient failure cannot stick for the TTL.
 *
 * WHEN TWO REQUESTS SHARE AN ENTRY. The key holds everything that changes the
 * stored text: the URL, whether a browser rendered it, the per-page limit and
 * the compaction model. A search with another limit or another compaction
 * model never reads a summary written for a different one.
 */

import { WEB_SEARCH_PAGE_CACHE_MAX_ENTRIES, WEB_SEARCH_PAGE_CACHE_TTL_MS } from '@/constants';

import type { ExtractedLink } from './linkExtractor';

export interface CachedPage {
  title: string;
  text: string;
  finalUrl: string;
  links: ExtractedLink[];
}

export interface PageCacheHit {
  page: CachedPage;
  /** How long ago the page was stored, in milliseconds. */
  ageMs: number;
}

export interface PageCacheKeyParts {
  url: string;
  usePlaywright: boolean;
  perPageCharLimit: number;
  compactionModel: string;
}

export interface PageCacheOptions {
  /** Entries expire this long after they were stored; 0 or less turns the cache off. */
  ttlMs: number;
  maxEntries: number;
  /** Replaceable for tests. */
  now?: () => number;
}

/** The URL without its fragment: `#section` never changes what the server sends. */
function normaliseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

export function buildPageCacheKey(parts: PageCacheKeyParts): string {
  return [
    normaliseUrl(parts.url),
    parts.usePlaywright ? 'browser' : 'http',
    String(parts.perPageCharLimit),
    parts.compactionModel,
  ].join('\u0000');
}

export class PageCache {
  private readonly entries = new Map<string, { page: CachedPage; storedAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: PageCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = Math.max(1, options.maxEntries);
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): PageCacheHit | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const ageMs = this.now() - entry.storedAt;
    if (ageMs >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // A copy of the links, so a caller cannot change what the next hit sees.
    return { page: { ...entry.page, links: [...entry.page.links] }, ageMs };
  }

  set(key: string, page: CachedPage): void {
    if (!this.enabled) return;
    // Re-inserting moves the key to the back, so a refreshed page is the newest.
    this.entries.delete(key);
    this.entries.set(key, { page: { ...page, links: [...page.links] }, storedAt: this.now() });
    this.evict();
  }

  clear(): void {
    this.entries.clear();
  }

  /** Drops expired entries first, then the oldest until the cache fits. */
  private evict(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.storedAt >= this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * The process-wide cache `web_search` uses. Tests and callers that want an
 * isolated one pass their own `PageCache` to `WebSearchTool`.
 */
export const webSearchPageCache = new PageCache({
  ttlMs: WEB_SEARCH_PAGE_CACHE_TTL_MS,
  maxEntries: WEB_SEARCH_PAGE_CACHE_MAX_ENTRIES,
});
