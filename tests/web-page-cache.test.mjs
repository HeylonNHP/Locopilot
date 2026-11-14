/**
 * Tests for the `web_search` page cache: the cache itself
 * (src/tools/web/pageCache.ts) and how `WebSearchTool` and `FetchUrlTool` use
 * it. The rule under test: ONLY `web_search` reads or writes the cache;
 * `fetch_url` always reads the live page.
 *
 * Pages are served by a local HTTP server, so `fetchAndExtract` runs for real
 * (download, extraction) and the tests can count requests. No LLM is called:
 * a page within the limit needs no compaction, and a page over it with no
 * compaction model configured is cut, which is the "truncated" case.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { createServer } from 'node:http';

import { FetchUrlTool } from '../src/tools/impl/fetchUrlTool.ts';
import { WebSearchTool } from '../src/tools/impl/webSearchTool.ts';
import { buildPageCacheKey, PageCache, webSearchPageCache } from '../src/tools/web/pageCache.ts';

const PAGE_TEXT = 'The cached page explains how the thing works in plain words. '.repeat(8); // ~490 chars

const KEY_PARTS = {
  url: 'https://example.test/a',
  usePlaywright: false,
  perPageCharLimit: 5000,
  compactionModel: 'model-a',
};

const PAGE = { title: 'T', text: 'text', finalUrl: 'https://example.test/a', links: [] };

describe('PageCache', () => {
  let clock;
  const makeCache = (options = {}) =>
    new PageCache({ ttlMs: 1000, maxEntries: 3, now: () => clock, ...options });

  beforeEach(() => {
    clock = 0;
  });

  test('a stored page comes back with its age', () => {
    const cache = makeCache();
    cache.set('k', PAGE);
    clock = 400;
    expect(cache.get('k')).toEqual({ page: PAGE, ageMs: 400 });
  });

  test('an unknown key is a miss', () => {
    expect(makeCache().get('nope')).toBeUndefined();
  });

  test('an entry expires after the TTL, and the TTL counts from when it was stored', () => {
    const cache = makeCache();
    cache.set('k', PAGE);
    clock = 999;
    expect(cache.get('k')).toBeDefined();
    // Reading did not extend it.
    clock = 1000;
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test('a TTL of 0 turns the cache off', () => {
    const cache = makeCache({ ttlMs: 0 });
    cache.set('k', PAGE);
    expect(cache.enabled).toBe(false);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test('the oldest entry is dropped when the cache is full', () => {
    const cache = makeCache();
    for (const key of ['a', 'b', 'c', 'd']) cache.set(key, PAGE);
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toBeDefined();
  });

  test('storing a key again refreshes it and makes it the newest', () => {
    const cache = makeCache();
    cache.set('a', PAGE);
    cache.set('b', PAGE);
    cache.set('c', PAGE);
    clock = 500;
    cache.set('a', { ...PAGE, text: 'newer' });
    cache.set('d', PAGE); // evicts the oldest, which is now b
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.page.text).toBe('newer');
    expect(cache.get('a')?.ageMs).toBe(0);
  });

  test('expired entries are cleared out when something new is stored', () => {
    const cache = makeCache({ maxEntries: 10 });
    cache.set('old', PAGE);
    clock = 2000;
    cache.set('new', PAGE);
    expect(cache.size).toBe(1);
  });

  test('a caller cannot change what the next hit sees', () => {
    const cache = makeCache();
    const links = [{ url: 'https://example.test/x', text: 'x' }];
    cache.set('k', { ...PAGE, links });
    links.push({ url: 'https://example.test/y', text: 'y' });
    const first = cache.get('k');
    first.page.links.push({ url: 'https://example.test/z', text: 'z' });
    expect(cache.get('k').page.links).toEqual([{ url: 'https://example.test/x', text: 'x' }]);
  });
});

describe('buildPageCacheKey', () => {
  test('is the same for the same inputs', () => {
    expect(buildPageCacheKey(KEY_PARTS)).toBe(buildPageCacheKey({ ...KEY_PARTS }));
  });

  test.each([
    ['another URL', { url: 'https://example.test/b' }],
    ['browser rendering', { usePlaywright: true }],
    ['another page limit', { perPageCharLimit: 3000 }],
    ['another compaction model', { compactionModel: 'model-b' }],
  ])('differs for %s', (_name, change) => {
    expect(buildPageCacheKey({ ...KEY_PARTS, ...change })).not.toBe(buildPageCacheKey(KEY_PARTS));
  });

  test('ignores the #fragment, which never changes what the server sends', () => {
    expect(buildPageCacheKey({ ...KEY_PARTS, url: 'https://example.test/a#section-2' })).toBe(
      buildPageCacheKey(KEY_PARTS)
    );
  });

  test('keeps the query string', () => {
    expect(buildPageCacheKey({ ...KEY_PARTS, url: 'https://example.test/a?page=2' })).not.toBe(
      buildPageCacheKey(KEY_PARTS)
    );
  });
});

describe('web_search and fetch_url against a live page', () => {
  let server;
  let baseUrl;
  /** Requests the local server has answered, by path. */
  let hits;
  /** What the server answers for a path (reassigned per test). */
  let body;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url);
      if (req.url.startsWith('/missing')) {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html><body>gone</body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<html><head><title>Live</title></head><body><article><p>${body}</p></article></body></html>`
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    hits = [];
    body = PAGE_TEXT;
    webSearchPageCache.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    webSearchPageCache.clear();
  });

  const settings = (overrides = {}) => ({
    maxQueries: 3,
    resultsPerQuery: 3,
    requestTimeoutMs: 5000,
    perPageCharLimit: 5000,
    baseUrl: 'http://ollama.test',
    compactionModel: 'model-a',
    ...overrides,
  });

  /** A web search whose DuckDuckGo step finds the given paths on the local server. */
  function searchTool(
    paths,
    { cache = new PageCache({ ttlMs: 60_000, maxEntries: 50 }), ...overrides } = {}
  ) {
    const tool = new WebSearchTool({ settings: settings(overrides), pageCache: cache });
    jest
      .spyOn(tool, 'fetchSearchResults')
      .mockImplementation(async () =>
        paths.map((path) => ({ title: `title ${path}`, url: `${baseUrl}${path}`, snippet: 's' }))
      );
    return { tool, cache };
  }

  test('a repeat web_search for the same page is served from the cache, with a note', async () => {
    const cache = new PageCache({ ttlMs: 60_000, maxEntries: 50 });
    const first = await searchTool(['/page'], { cache }).tool.run({ queries: ['q'] });
    const second = await searchTool(['/page'], { cache }).tool.run({ queries: ['q again'] });

    expect(hits).toEqual(['/page']); // the second search never downloaded it
    expect(first).not.toContain('web_search cache');
    expect(second).toContain('copy from the web_search cache');
    expect(second).toContain('fetch_url always reads the live page');
    expect(second).toContain(PAGE_TEXT.trim());
  });

  test('the cached result is the same page the first search returned', async () => {
    const cache = new PageCache({ ttlMs: 60_000, maxEntries: 50 });
    const first = await searchTool(['/page'], { cache }).tool.run({ queries: ['q'] });
    const second = await searchTool(['/page'], { cache }).tool.run({ queries: ['q'] });
    const textOf = (output) =>
      output.match(/result_1_text:\n([\S\s]*?)\n(?:\[Note|result_1_links)/)[1];
    expect(textOf(second)).toBe(textOf(first));
  });

  test('a page asked for with another per-page limit is not served from the cache', async () => {
    const cache = new PageCache({ ttlMs: 60_000, maxEntries: 50 });
    await searchTool(['/page'], { cache }).tool.run({ queries: ['q'] });
    await searchTool(['/page'], { cache, perPageCharLimit: 4000 }).tool.run({ queries: ['q'] });
    expect(hits).toEqual(['/page', '/page']);
  });

  test('a page asked for with another compaction model is not served from the cache', async () => {
    const cache = new PageCache({ ttlMs: 60_000, maxEntries: 50 });
    await searchTool(['/page'], { cache }).tool.run({ queries: ['q'] });
    await searchTool(['/page'], { cache, compactionModel: 'model-b' }).tool.run({ queries: ['q'] });
    expect(hits).toEqual(['/page', '/page']);
  });

  test('an expired copy is fetched again', async () => {
    let clock = 0;
    const cache = new PageCache({ ttlMs: 1000, maxEntries: 50, now: () => clock });
    await searchTool(['/page'], { cache }).tool.run({ queries: ['q'] });
    clock = 1000;
    const again = await searchTool(['/page'], { cache }).tool.run({ queries: ['q'] });
    expect(hits).toEqual(['/page', '/page']);
    expect(again).not.toContain('web_search cache');
  });

  test('a page that was cut instead of summarised is NOT cached', async () => {
    // Over the limit, and no compaction model: compaction fails, the page is cut.
    body = 'A long paragraph that will not be summarised. '.repeat(30);
    const cache = new PageCache({ ttlMs: 60_000, maxEntries: 50 });
    const options = { cache, perPageCharLimit: 200, compactionModel: '' };
    const first = await searchTool(['/page'], options).tool.run({ queries: ['q'] });
    expect(first).toContain('NOT summarised');
    expect(cache.size).toBe(0);

    await searchTool(['/page'], options).tool.run({ queries: ['q'] });
    expect(hits).toEqual(['/page', '/page']);
  });

  test('a page that failed to load is NOT cached', async () => {
    const cache = new PageCache({ ttlMs: 60_000, maxEntries: 50 });
    const first = await searchTool(['/missing'], { cache }).tool.run({ queries: ['q'] });
    expect(first).toContain('failed to fetch page');
    expect(cache.size).toBe(0);
    await searchTool(['/missing'], { cache }).tool.run({ queries: ['q'] });
    expect(hits).toEqual(['/missing', '/missing']);
  });

  test('by default web_search uses the shared cache', async () => {
    const tool = new WebSearchTool({ settings: settings() });
    jest
      .spyOn(tool, 'fetchSearchResults')
      .mockResolvedValue([{ title: 't', url: `${baseUrl}/page`, snippet: 's' }]);
    await tool.run({ queries: ['q'] });
    expect(webSearchPageCache.size).toBe(1);
  });

  describe('fetch_url never uses the cache', () => {
    const fetchTool = () => new FetchUrlTool({ settings: settings() });

    test('it returns the live page even when web_search cached that URL, and does not read the cache', async () => {
      // web_search caches the page ...
      const tool = new WebSearchTool({ settings: settings() });
      jest
        .spyOn(tool, 'fetchSearchResults')
        .mockResolvedValue([{ title: 't', url: `${baseUrl}/page`, snippet: 's' }]);
      await tool.run({ queries: ['q'] });
      // ... and then the page changes on the server.
      body = 'This is the NEW content of the page, changed since the search. '.repeat(8);
      hits = [];
      const getSpy = jest.spyOn(webSearchPageCache, 'get');

      const output = await fetchTool().run({ url: `${baseUrl}/page` });

      expect(hits).toEqual(['/page']); // it went to the server
      expect(output).toContain('NEW content of the page');
      expect(output).not.toContain(PAGE_TEXT.trim());
      expect(getSpy).not.toHaveBeenCalled();
    });

    test('it does not write to the cache either', async () => {
      const setSpy = jest.spyOn(webSearchPageCache, 'set');
      await fetchTool().run({ url: `${baseUrl}/page` });
      expect(setSpy).not.toHaveBeenCalled();
      expect(webSearchPageCache.size).toBe(0);
    });
  });
});
