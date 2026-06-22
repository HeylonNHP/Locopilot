import axios from 'axios';
import * as cheerio from 'cheerio';

import type { ToolSchema } from '@/tools/tools';

import type { ToolOutputSink } from '../toolOutput';
import type { ExtractedLink } from '../web/linkExtractor';

import {
  cleanText,
  DEFAULT_USER_AGENT,
  fetchAndExtract,
} from '../web/htmlExtractor';

export const webSearchToolSchema: ToolSchema = {
  name: 'web_search',
  description:
    'USE WEB SEARCH PROACTIVELY — it is your best friend for any task that needs more information, updated facts, or real documentation. ' +
    'Use it whenever you could benefit from more context, not just when explicitly asked. ' +
    'Good reasons to search: you are stuck and need ideas, documentation might be outdated, ' +
    'you need to verify something that has likely changed, you want up-to-date information, ' +
    'or you are about to make a decision with imperfect knowledge. ' +
    'Do not rely solely on your training knowledge — DuckDuckGo gives you the live web. ' +
    'When using search results, ALWAYS cite the full URL inline immediately after the relevant sentence(s). ' +
    'Do NOT use generic "result_N" placeholders. ' +
    'Use use_playwright=true for JavaScript-heavy pages (SPAs, sites requiring client-side rendering) where standard fetching misses content.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'User request text for deriving search queries if explicit queries are not supplied.',
      },
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of explicit search queries to run.',
      },
      max_queries: {
        type: 'number',
        description: 'Maximum number of queries to run for this call.',
      },
      use_playwright: {
        type: 'boolean',
        description:
          'When true, uses a real browser (Playwright) to render each result page before extracting text. This is useful for JavaScript-heavy pages, SPAs, or sites that require client-side rendering. May be slower but provides more complete content extraction.',
      },
    },
    required: [],
  },
};

const DUCKDUCKGO_HTML_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const DDG_REGION = 'wt-wt'; // All regions

/**
 * Human-readable names for DuckDuckGo's internal form parameters.
 *
 * DDG's HTML search endpoint uses cryptic single-letter / abbreviated field
 * names in its POST body.  These constants map each one to a self-documenting
 * name so the intent is clear at the call site.  The wire format is unchanged.
 *
 * References:
 *   - https://docs.searxng.org/dev/engines/online/duckduckgo.html
 *   - https://github.com/deedy5/duckduckgo_search
 */
const DDG = {
  PARAM: {
    /** Search query string */
    QUERY: 'q',
    /** "Beginning" — empty string for first page; omitted on subsequent pages */
    BEGINNING: 'b',
    /** Validation Query Digest — anti-bot token required for pagination */
    VALIDATION_TOKEN: 'vqd',
    /** Search offset for pagination (page 2 = 10, page 3+ = 10 + (n-2)*15) */
    OFFSET: 's',
    /** Display count — always offset + 1 */
    DISPLAY_COUNT: 'dc',
    /** Continuation params from previous page response */
    NEXT_PARAMS: 'nextParams',
    /** Backend identifier ("d.js" = web search) */
    API_ENDPOINT: 'api',
    /** Output format ("json") */
    OUTPUT_FORMAT: 'o',
    /** Version indicator ("l") */
    VERSION: 'v',
    /** Region / keyboard language code */
    REGION: 'kl',
  } as const,
  /** Web search backend */
  API_WEB_SEARCH: 'd.js',
  /** JSON output format */
  OUTPUT_JSON: 'json',
  /** Latest version indicator */
  VERSION_LATEST: 'l',
  /** All regions (worldwide) */
  REGION_WORLDWIDE: 'wt-wt',
} as const;

export interface WebSearchSettings {
  maxQueries: number;
  resultsPerQuery: number;
  requestTimeoutMs: number;
  perPageCharLimit: number;
  baseUrl: string; // Required - always from config
  compactionModel: string;
  output?: ToolOutputSink;
}

export interface WebSearchToolArgs {
  prompt?: string;
  queries?: string[];
  max_queries?: number;
  use_playwright?: boolean;
}

interface DuckDuckGoResult {
  title: string;
  url: string;
  snippet: string;
}

interface ExtractedPage {
  url: string;
  finalUrl: string;
  title: string;
  snippet: string;
  text: string;
  links: ExtractedLink[];
  usedPlaywright?: boolean;
}

export interface WebSearchOptions {
  settings: WebSearchSettings;
  onProgress?: (message: string) => void;
}

function clampToPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function parseDuckDuckGoRedirect(href: string): string {
  try {
    const parsed = new URL(href, DUCKDUCKGO_HTML_SEARCH_URL);
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return parsed.href;
  } catch {
    return href;
  }
}

// Per-query VQD cache (shared across all WebSearchTool instances for the lifetime of this module)
const vqdCache = new Map<string, string>();

function isDdgCaptcha($: ReturnType<typeof cheerio.load>): boolean {
  return $('#challenge-form').length > 0;
}

export class WebSearchTool {
  private readonly settings: WebSearchSettings;
  private readonly onProgress: ((message: string) => void) | undefined;

  constructor(options: WebSearchOptions) {
    this.settings = options.settings;
    this.onProgress = options.onProgress;
  }

  async run(args: WebSearchToolArgs, signal?: AbortSignal): Promise<string> {
    const effectiveMaxQueries = clampToPositiveInt(
      args.max_queries ?? this.settings.maxQueries,
      this.settings.maxQueries
    );
    const effectiveResultsPerQuery = this.settings.resultsPerQuery;

    const queries = this.generateQueries(args, effectiveMaxQueries);
    if (queries.length === 0) {
      return '[Web search error: no prompt/queries were provided.]';
    }

    this.progress(
      `Web search: ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} selected.`
    );

    const querySections: string[] = [];
    for (const [queryIndex, query] of queries.entries()) {
      this.progress(
        `Web search: fetching DuckDuckGo results (${queryIndex + 1}/${queries.length}) for "${query}"...`
      );

      const searchResults = await this.fetchSearchResults(query, effectiveResultsPerQuery, signal);
      if (searchResults.length === 0) {
        querySections.push([`query: ${query}`, 'results: 0'].join('\n'));
        continue;
      }

      const pages: ExtractedPage[] = [];
      for (const [resultIndex, result] of searchResults.entries()) {
        this.progress(
          `Web search: loading page ${resultIndex + 1}/${searchResults.length} for query ${queryIndex + 1}/${queries.length}...`
        );

        const extracted = await this.fetchAndExtractText(result, args.use_playwright, signal);
        if (extracted) {
          pages.push(extracted);
        }
      }

      const resultLines: string[] = [`query: ${query}`, `results: ${pages.length}`];

      for (const [index, page] of pages.entries()) {
        const urlLines = [`result_${index + 1}_source_url: ${page.url}`];
        if (page.finalUrl !== page.url) {
          urlLines.push(`result_${index + 1}_final_url: ${page.finalUrl}`);
        }

        const linksStr =
          page.links.length > 0
            ? page.links.map((l) => `- [${l.text}](${l.url})`).join('\n')
            : '(none)';

        const methodNote = page.usedPlaywright
          ? '\n[Note: This page was rendered using Playwright (browser) because use_playwright was requested.]'
          : '';

        resultLines.push(
          [
            `result_${index + 1}_title: ${page.title || '(untitled)'}`,
            ...urlLines,
            `result_${index + 1}_snippet: ${page.snippet || '(none)'}`,
            `result_${index + 1}_text:\n${page.text || '(no extractable text)'}${methodNote}`,
            `result_${index + 1}_links:\n${linksStr}`,
          ].join('\n')
        );
      }

      querySections.push(resultLines.join('\n\n'));
    }

    this.progress('Web search: completed.');
    return [
      'web_search_results:',
      'REMINDER: When citing these results, use the REAL URLs (e.g. https://example.com) immediately after the relevant text. Do NOT use result_N placeholders or special tags.',
      `queries_used: ${queries.length}`,
      `results_per_query: ${effectiveResultsPerQuery}`,
      '',
      querySections.join('\n\n---\n\n'),
    ].join('\n');
  }

  private progress(message: string): void {
    if (this.onProgress) this.onProgress(message);
  }

  private generateQueries(args: WebSearchToolArgs, maxQueries: number): string[] {
    const provided = (args.queries ?? []).map((q) => q.trim()).filter((q) => q.length > 0);

    if (provided.length > 0) {
      return [...new Set(provided)].slice(0, maxQueries);
    }

    const prompt = (args.prompt ?? '').trim();
    if (!prompt) return [];

    const baseCandidates = prompt
      .split(/\n|[!.?]| and | or |;|,/g)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    const candidates = new Set<string>();
    if (prompt.length > 0) candidates.add(prompt);
    for (const candidate of baseCandidates) {
      if (candidates.size >= maxQueries) break;
      candidates.add(candidate);
    }

    return [...candidates].slice(0, maxQueries);
  }

  private parseResultsFromPage(
    $: ReturnType<typeof cheerio.load>,
    results: DuckDuckGoResult[],
    limit: number
  ): number {
    const seen = new Set(results.map((r) => r.url));
    let added = 0;

    // Try the newer DDG HTML structure first (div#links > div.web-result),
    // then fall back to the legacy .result selector.
    const newerResults = $('div#links div.web-result');
    const resultElements = newerResults.length > 0 ? newerResults : $('.result');

    resultElements.each((_, element) => {
      if (results.length >= limit) return;

      // Newer structure: h2 a for title, .result__snippet for snippet
      let link = $(element).find('h2 a').first();
      if (link.length === 0) {
        link = $(element).find('a.result__a').first();
      }
      const title = cleanText(link.text());
      const href = link.attr('href') ?? '';

      let snippetEl = $(element).find('a.result__snippet').first();
      if (snippetEl.length === 0) {
        snippetEl = $(element).find('.result__snippet').first();
      }
      const snippet = cleanText(snippetEl.text());

      if (!href || !title) return;

      const url = parseDuckDuckGoRedirect(href);
      if (!/^https?:\/\//i.test(url)) return;
      if (seen.has(url)) return;

      seen.add(url);
      results.push({ title, url, snippet });
      added++;
    });

    return added;
  }

  private async fetchSearchResults(
    query: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<DuckDuckGoResult[]> {
    const results: DuckDuckGoResult[] = [];

    const commonHeaders: Record<string, string> = {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: DUCKDUCKGO_HTML_SEARCH_URL,
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
    };

    // First page via POST (DDG HTML endpoint expects POST even for the intro page)
    const firstPageData = new URLSearchParams({
      [DDG.PARAM.QUERY]: query,
      [DDG.PARAM.BEGINNING]: '',
      [DDG.PARAM.REGION]: DDG_REGION,
    }).toString();

    const firstResponse = await axios.post<string>(DUCKDUCKGO_HTML_SEARCH_URL, firstPageData, {
      timeout: this.settings.requestTimeoutMs,
      headers: commonHeaders,
      responseType: 'text',
      ...(signal ? { signal } : {}),
    });

    const $first = cheerio.load(firstResponse.data);

    // Check for CAPTCHA before anything else
    if (isDdgCaptcha($first)) {
      this.progress(
        `Web search: DuckDuckGo returned a CAPTCHA challenge for "${query}" — returning partial results only.`
      );
      return results;
    }

    this.parseResultsFromPage($first, results, limit);

    if (results.length >= limit) return results;

    // Extract vqd token from the first page (try multiple selectors)
    let vqd = ($first('input[name="vqd"]').first().val() as string | undefined) ?? '';
    if (!vqd) {
      // Try extracting from a script or link tag as a fallback
      const vqdMatch = firstResponse.data.match(/vqd=([^\s"&']+)/);
      if (vqdMatch && vqdMatch[1]) {
        vqd = vqdMatch[1];
      }
    }
    if (!vqd) {
      this.progress(
        `Web search: could not extract vqd token for "${query}" — pagination unavailable.`
      );
      return results;
    }

    // Cache the vqd token for this query
    vqdCache.set(query, vqd);

    // Subsequent pages via POST with proper offset stepping.
    // DDG page 2 offset=10, page 3+ offset=10+(pageNum-2)*15
    let pageNum = 2;
    while (results.length < limit) {
      const offset = pageNum === 2 ? 10 : 10 + (pageNum - 2) * 15;
      const pageData = new URLSearchParams({
        [DDG.PARAM.QUERY]: query,
        [DDG.PARAM.VALIDATION_TOKEN]: vqd,
        [DDG.PARAM.OFFSET]: String(offset),
        [DDG.PARAM.DISPLAY_COUNT]: String(offset + 1),
        [DDG.PARAM.NEXT_PARAMS]: '',
        [DDG.PARAM.API_ENDPOINT]: DDG.API_WEB_SEARCH,
        [DDG.PARAM.OUTPUT_FORMAT]: DDG.OUTPUT_JSON,
        [DDG.PARAM.VERSION]: DDG.VERSION_LATEST,
        [DDG.PARAM.REGION]: DDG_REGION,
      }).toString();

      let pageResponse;
      try {
        pageResponse = await axios.post<string>(DUCKDUCKGO_HTML_SEARCH_URL, pageData, {
          timeout: this.settings.requestTimeoutMs,
          headers: commonHeaders,
          responseType: 'text',
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        // If we get a 403 or network error, stop paginating
        this.progress(
          `Web search: pagination request failed for page ${pageNum} (${err instanceof Error ? err.message : String(err)})`
        );
        break;
      }

      const $page = cheerio.load(pageResponse.data);

      if (isDdgCaptcha($page)) {
        this.progress(`Web search: DuckDuckGo CAPTCHA on page ${pageNum} — stopping pagination.`);
        break;
      }

      // Also update vqd from this page if present (may rotate)
      const freshVqd = ($page('input[name="vqd"]').first().val() as string | undefined) ?? '';
      if (freshVqd) {
        vqd = freshVqd;
        vqdCache.set(query, vqd);
      }

      const added = this.parseResultsFromPage($page, results, limit);
      if (added === 0) break; // No more results available

      pageNum++;
    }

    return results;
  }

  private async fetchAndExtractText(
    result: DuckDuckGoResult,
    usePlaywright?: boolean,
    signal?: AbortSignal
  ): Promise<ExtractedPage | null> {
    try {
      const extracted = await fetchAndExtract(result.url, this.settings, {
        usePlaywright: usePlaywright === true,
        ...(signal ? { signal } : {}),
      });

      return {
        url: result.url,
        finalUrl: extracted.finalUrl,
        title: result.title,
        snippet: result.snippet,
        text: extracted.text || '(no extractable text)',
        links: extracted.links,
        usedPlaywright: usePlaywright === true,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        url: result.url,
        finalUrl: result.url,
        title: result.title,
        snippet: result.snippet,
        text: `(failed to fetch page: ${reason})`,
        links: [],
        usedPlaywright: false,
      };
    }
  }
}

/**
 * Returns the web_search tool section for the system prompt.
 */
export function getToolPrompt(): string {
  const s = webSearchToolSchema;
  const p = s.parameters.properties;
  return (
    `3. ${s.name}(prompt?, queries?, max_queries?, use_playwright?)\n` +
    `   Web search via DuckDuckGo with full page extraction. Returns page text, titles, snippets, and extracted links. When using results, ALWAYS cite the full URL inline immediately after the relevant sentence(s). Do NOT use generic "result_N" placeholders. Use use_playwright=true for JavaScript-heavy pages (SPAs, sites requiring client-side rendering) where standard fetching misses content.\n\n` +
    `   - prompt: ${p.prompt!.description}\n` +
    `   - queries: ${p.queries!.description}\n` +
    `   - max_queries: ${p.max_queries!.description}\n` +
    `   - use_playwright: ${p.use_playwright!.description}\n` +
    `   - CITATION: always cite the full URL inline after each referenced fact. ` +
    `     Do NOT use "result_N" placeholders. Example: "Guzman y Gomez has locations in Townsville (https://guzmanygomez.com.au/locations)"`
  );
}
