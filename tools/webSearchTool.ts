import axios from 'axios';
import * as cheerio from 'cheerio';
import { cleanText, fetchAndExtract, DEFAULT_USER_AGENT } from './htmlExtractor.js';

const DUCKDUCKGO_HTML_SEARCH_URL = 'https://duckduckgo.com/html/';

export interface WebSearchSettings {
    maxQueries: number;
    resultsPerQuery: number;
    requestTimeoutMs: number;
    perPageCharLimit: number;
}

export interface WebSearchToolArgs {
    prompt?: string;
    queries?: string[];
    max_queries?: number;
    results_per_query?: number;
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

export class WebSearchTool {
    private readonly settings: WebSearchSettings;
    private readonly onProgress: ((message: string) => void) | undefined;

    constructor(options: WebSearchOptions) {
        this.settings = options.settings;
        this.onProgress = options.onProgress;
    }

    async run(args: WebSearchToolArgs): Promise<string> {
        const effectiveMaxQueries = clampToPositiveInt(args.max_queries ?? this.settings.maxQueries, this.settings.maxQueries);
        const effectiveResultsPerQuery = this.settings.resultsPerQuery;

        const queries = this.generateQueries(args, effectiveMaxQueries);
        if (queries.length === 0) {
            return '[Web search error: no prompt/queries were provided.]';
        }

        this.progress(`Web search: ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} selected.`);

        const querySections: string[] = [];
        for (const [queryIndex, query] of queries.entries()) {
            this.progress(`Web search: fetching DuckDuckGo results (${queryIndex + 1}/${queries.length}) for "${query}"...`);

            const searchResults = await this.fetchSearchResults(query, effectiveResultsPerQuery);
            if (searchResults.length === 0) {
                querySections.push([
                    `query: ${query}`,
                    'results: 0',
                ].join('\n'));
                continue;
            }

            const pages: ExtractedPage[] = [];
            for (const [resultIndex, result] of searchResults.entries()) {
                this.progress(
                    `Web search: loading page ${resultIndex + 1}/${searchResults.length} for query ${queryIndex + 1}/${queries.length}...`,
                );

                const extracted = await this.fetchAndExtractText(result);
                if (extracted) {
                    pages.push(extracted);
                }
            }

            const resultLines: string[] = [
                `query: ${query}`,
                `results: ${pages.length}`,
            ];

            for (const [index, page] of pages.entries()) {
                const urlLines = [`result_${index + 1}_source_url: ${page.url}`];
                if (page.finalUrl !== page.url) {
                    urlLines.push(`result_${index + 1}_final_url: ${page.finalUrl}`);
                }

                resultLines.push(
                    [
                        `result_${index + 1}_title: ${page.title || '(untitled)'}`,
                        ...urlLines,
                        `result_${index + 1}_snippet: ${page.snippet || '(none)'}`,
                        `result_${index + 1}_text:\n${page.text || '(no extractable text)'}`,
                    ].join('\n'),
                );
            }

            querySections.push(resultLines.join('\n\n'));
        }

        this.progress('Web search: completed.');
        return [
            'web_search_results:',
            'REMINDER: When citing these results, use the REAL URLs (e.g. https://example.com) immediately after the relevant text. Do NOT use result_N placeholders or special tags.',
            `queries_used: ${queries.length}`,
            `results_per_query_requested: ${effectiveResultsPerQuery}`,
            '',
            querySections.join('\n\n---\n\n'),
        ].join('\n');
    }

    private progress(message: string): void {
        if (this.onProgress) this.onProgress(message);
    }

    private generateQueries(args: WebSearchToolArgs, maxQueries: number): string[] {
        const provided = (args.queries ?? [])
            .map((q) => q.trim())
            .filter((q) => q.length > 0);

        if (provided.length > 0) {
            return Array.from(new Set(provided)).slice(0, maxQueries);
        }

        const prompt = (args.prompt ?? '').trim();
        if (!prompt) return [];

        const baseCandidates = prompt
            .split(/\n|[?.!]| and | or |;|,/g)
            .map((segment) => segment.trim())
            .filter((segment) => segment.length > 0);

        const candidates = new Set<string>();
        if (prompt.length > 0) candidates.add(prompt);
        for (const candidate of baseCandidates) {
            if (candidates.size >= maxQueries) break;
            candidates.add(candidate);
        }

        return Array.from(candidates).slice(0, maxQueries);
    }

    private parseResultsFromPage(
        $: ReturnType<typeof cheerio.load>,
        results: DuckDuckGoResult[],
        limit: number,
    ): number {
        const seen = new Set(results.map((r) => r.url));
        let added = 0;

        $('.result').each((_, element) => {
            if (results.length >= limit) return;

            const link = $(element).find('a.result__a').first();
            const title = cleanText(link.text());
            const href = link.attr('href') ?? '';
            const snippet = cleanText($(element).find('.result__snippet').first().text());

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

    private async fetchSearchResults(query: string, limit: number): Promise<DuckDuckGoResult[]> {
        const results: DuckDuckGoResult[] = [];

        // First page via GET
        const firstResponse = await axios.get<string>(DUCKDUCKGO_HTML_SEARCH_URL, {
            params: { q: query },
            timeout: this.settings.requestTimeoutMs,
            headers: {
                'User-Agent': DEFAULT_USER_AGENT,
                Accept: 'text/html,application/xhtml+xml',
            },
            responseType: 'text',
        });

        let $ = cheerio.load(firstResponse.data);
        this.parseResultsFromPage($, results, limit);

        if (results.length >= limit) return results;

        // Extract vqd token required for subsequent pages
        const vqd = ($('input[name="vqd"]').first().val() as string | undefined) ?? '';
        if (!vqd) return results;

        // Subsequent pages via POST with offset (DDG uses steps of 30)
        let offset = 30;
        while (results.length < limit) {
            const pageResponse = await axios.post<string>(
                DUCKDUCKGO_HTML_SEARCH_URL,
                new URLSearchParams({
                    q: query,
                    vqd,
                    s: String(offset),
                    dc: String(offset + 1),
                }).toString(),
                {
                    timeout: this.settings.requestTimeoutMs,
                    headers: {
                        'User-Agent': DEFAULT_USER_AGENT,
                        Accept: 'text/html,application/xhtml+xml',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        Referer: DUCKDUCKGO_HTML_SEARCH_URL,
                    },
                    responseType: 'text',
                },
            );

            $ = cheerio.load(pageResponse.data);
            const added = this.parseResultsFromPage($, results, limit);
            if (added === 0) break; // No more results available

            offset += 30;
        }

        return results;
    }

    private async fetchAndExtractText(result: DuckDuckGoResult): Promise<ExtractedPage | null> {
        try {
            const extracted = await fetchAndExtract(result.url, this.settings);

            return {
                url: result.url,
                finalUrl: extracted.finalUrl,
                title: result.title,
                snippet: result.snippet,
                text: extracted.text || '(no extractable text)',
            };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                url: result.url,
                finalUrl: result.url,
                title: result.title,
                snippet: result.snippet,
                text: `(failed to fetch page: ${reason})`,
            };
        }
    }
}

/**
 * Returns the web_search tool section for the system prompt.
 */
export function getToolPrompt(): string {
    return (
        '3. web_search(prompt?, queries?, max_queries?)\n' +
        '   Search DuckDuckGo and return extracted page text from top result pages.\n' +
        '   Use this when external web context is needed. Provide explicit queries as\n' +
        '   an array when possible; aim for 2-3 distinct queries for complex requests\n' +
        '   to ensure comprehensive coverage. The tool will respect the max_queries limit.\n\n' +
        '   CITATION RULES:\n' +
        '   When referencing a search result, always include the full result URL inline immediately\n' +
        '   after the referenced sentence. Avoid generic "result_N" placeholders or special\n' +
        '   tags. Format examples:\n' +
        '   - Guzman y Gomez has multiple locations in Townsville. (https://guzmanygomez.com.au/locations)\n' +
        '   - Zambrero was founded in 2005. (https://www.productreview.com.au/listings/zambrero)\n\n'
    );
}
