/**
 * Tests for how `WebSearchTool.run` schedules its work
 * (src/tools/impl/webSearchTool.ts): the queries run in PARALLEL, the page
 * downloads are capped across all of them, the output keeps query order, and
 * one failed query does not take the others down.
 *
 * The two I/O seams (`fetchSearchResults` and `fetchAndExtractText`) are
 * replaced on the prototype; there is no network and no browser.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
  DEFAULT_WEB_SEARCH_PARALLEL_PAGE_FETCHES,
  WEB_SEARCH_MAX_CONCURRENT_SEARCHES,
} from '../src/constants.ts';
import { WebSearchTool } from '../src/tools/impl/webSearchTool.ts';

const settings = {
  maxQueries: 10,
  resultsPerQuery: 15,
  requestTimeoutMs: 1000,
  perPageCharLimit: 5000,
  baseUrl: 'http://ollama.test',
  compactionModel: 'test-model',
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `n` fake search results for `query`. */
function resultsFor(query, n) {
  return Array.from({ length: n }, (_, i) => ({
    title: `${query} #${i + 1}`,
    url: `https://example.test/${encodeURIComponent(query)}/${i + 1}`,
    snippet: `snippet ${i + 1}`,
  }));
}

function pageFor(result) {
  return {
    url: result.url,
    finalUrl: result.url,
    title: result.title,
    snippet: result.snippet,
    text: `text of ${result.title}`,
    links: [],
  };
}

function newTool(onProgress) {
  return new WebSearchTool({ settings, ...(onProgress ? { onProgress } : {}) });
}

describe('WebSearchTool.run scheduling', () => {
  let searchSpy;
  let pageSpy;

  beforeEach(() => {
    searchSpy = jest.spyOn(WebSearchTool.prototype, 'fetchSearchResults');
    pageSpy = jest.spyOn(WebSearchTool.prototype, 'fetchAndExtractText');
    pageSpy.mockImplementation(async (result) => pageFor(result));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('the queries run in parallel: pages of different queries load at the same time', async () => {
    searchSpy.mockImplementation(async (query) => resultsFor(query, 1));
    let loading = 0;
    let peak = 0;
    pageSpy.mockImplementation(async (result) => {
      loading += 1;
      peak = Math.max(peak, loading);
      await delay(1000);
      loading -= 1;
      return pageFor(result);
    });

    const startedAt = Date.now();
    await newTool().run({ queries: ['one', 'two', 'three'] });
    const elapsed = Date.now() - startedAt;

    // One after another this is 3 × 1000 ms. In parallel it is the stagger
    // (2 × 300 ms) plus one page load.
    expect(peak).toBe(3);
    expect(elapsed).toBeLessThan(2500);
  });

  test('no more searches are in flight than WEB_SEARCH_MAX_CONCURRENT_SEARCHES', async () => {
    let searching = 0;
    let peak = 0;
    searchSpy.mockImplementation(async (query) => {
      searching += 1;
      peak = Math.max(peak, searching);
      await delay(1000); // longer than 3 staggers, so the 4th has to wait
      searching -= 1;
      return resultsFor(query, 1);
    });

    await newTool().run({ queries: ['a', 'b', 'c', 'd'] });
    expect(peak).toBeLessThanOrEqual(WEB_SEARCH_MAX_CONCURRENT_SEARCHES);
    expect(peak).toBe(WEB_SEARCH_MAX_CONCURRENT_SEARCHES);
  });

  test('page loads are capped across ALL queries, not per query', async () => {
    searchSpy.mockImplementation(async (query) => resultsFor(query, 15));
    let loading = 0;
    let peak = 0;
    pageSpy.mockImplementation(async (result) => {
      loading += 1;
      peak = Math.max(peak, loading);
      await delay(5);
      loading -= 1;
      return pageFor(result);
    });

    await newTool().run({ queries: ['q1', 'q2', 'q3'] }); // 45 pages
    expect(pageSpy).toHaveBeenCalledTimes(45);
    expect(peak).toBe(DEFAULT_WEB_SEARCH_PARALLEL_PAGE_FETCHES);
  });

  test('sections and sources follow the query order even when a later query finishes first', async () => {
    searchSpy.mockImplementation(async (query) => {
      if (query === 'slow') await delay(120);
      return resultsFor(query, 2);
    });

    const output = await newTool().run({ queries: ['slow', 'fast'] });

    expect(output.indexOf('query: slow')).toBeLessThan(output.indexOf('query: fast'));
    const sources = output.slice(output.indexOf('SOURCES'));
    expect(sources.indexOf('slow #1')).toBeLessThan(sources.indexOf('fast #1'));
    expect(sources).toContain('[1] slow #1');
    expect(sources).toContain('[3] fast #1');
  });

  test('a source found by two queries is numbered once', async () => {
    const shared = { title: 'shared', url: 'https://example.test/shared', snippet: '' };
    searchSpy.mockImplementation(async () => [shared]);
    const output = await newTool().run({ queries: ['x', 'y'] });
    expect(output.match(/\[\d+] shared/g)).toHaveLength(1);
  });

  test('one failed search is reported in its section and the other queries keep their pages', async () => {
    searchSpy.mockImplementation(async (query) => {
      if (query === 'broken') throw new Error('DuckDuckGo exploded');
      return resultsFor(query, 2);
    });

    const output = await newTool().run({ queries: ['good', 'broken', 'also good'] });

    expect(output).toContain('query: broken\nresults: 0\nsearch_error: DuckDuckGo exploded');
    expect(output).toMatch(/query: good\n+results: 2/);
    expect(output).toMatch(/query: also good\n+results: 2/);
  });

  test('when EVERY search fails the first error is thrown, as before', async () => {
    searchSpy.mockImplementation(async () => {
      throw new Error('network down');
    });
    await expect(newTool().run({ queries: ['a', 'b'] })).rejects.toThrow('network down');
  });

  test('a query with no results is a "results: 0" section, not an error', async () => {
    searchSpy.mockImplementation(async (query) => (query === 'empty' ? [] : resultsFor(query, 1)));
    const output = await newTool().run({ queries: ['empty', 'full'] });
    expect(output).toContain('query: empty\nresults: 0');
    expect(output).not.toContain('search_error');
    expect(pageSpy).toHaveBeenCalledTimes(1);
  });

  test('an abort rejects the run instead of returning a partial result', async () => {
    searchSpy.mockImplementation(async (query) => {
      await delay(50);
      return resultsFor(query, 2);
    });
    const controller = new AbortController();
    const promise = newTool().run({ queries: ['a', 'b', 'c'] }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toBeDefined();
  });

  test('reports progress for every query', async () => {
    searchSpy.mockImplementation(async (query) => resultsFor(query, 1));
    const messages = [];
    await newTool((m) => messages.push(m)).run({ queries: ['alpha', 'beta'] });
    expect(messages.some((m) => m.includes('(1/2)') && m.includes('alpha'))).toBe(true);
    expect(messages.some((m) => m.includes('(2/2)') && m.includes('beta'))).toBe(true);
    expect(messages.at(-1)).toBe('Web search: completed.');
  });
});
