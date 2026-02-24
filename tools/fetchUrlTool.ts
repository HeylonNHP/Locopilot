import axios from 'axios';
import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type { WebSearchSettings } from './webSearchTool.js';

const DEFAULT_USER_AGENT = 'Locopilot/1.0 (+https://ollama.com)';

export interface FetchUrlToolArgs {
    url?: string;
}

export interface FetchUrlOptions {
    settings: WebSearchSettings;
    onProgress?: (message: string) => void;
}

function cleanText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export class FetchUrlTool {
    private readonly settings: WebSearchSettings;
    private readonly onProgress: ((message: string) => void) | undefined;

    constructor(options: FetchUrlOptions) {
        this.settings = options.settings;
        this.onProgress = options.onProgress;
    }

    async run(args: FetchUrlToolArgs): Promise<string> {
        const rawUrl = (args.url ?? '').trim();
        if (!rawUrl) {
            return '[fetch_url error: missing required argument "url".]';
        }

        let parsedUrl: URL;
        try {
            parsedUrl = new URL(rawUrl);
        } catch {
            return '[fetch_url error: invalid URL.]';
        }

        if (!/^https?:$/i.test(parsedUrl.protocol)) {
            return '[fetch_url error: only http and https URLs are supported.]';
        }

        const url = parsedUrl.toString();
        this.progress(`Fetch URL: loading ${url}...`);

        try {
            const response = await axios.get<string>(url, {
                timeout: this.settings.requestTimeoutMs,
                headers: {
                    'User-Agent': DEFAULT_USER_AGENT,
                    Accept: 'text/html,application/xhtml+xml',
                },
                responseType: 'text',
                maxRedirects: 5,
            });

            const finalUrl = response.request?.res?.responseUrl || url;
            const html = response.data;
            const title = this.extractTitle(html, finalUrl);
            const readabilityText = this.extractWithReadability(html, finalUrl);
            const fallbackText = this.extractWithCheerio(html);
            const chosen = readabilityText.length >= fallbackText.length ? readabilityText : fallbackText;
            const text = chosen.slice(0, this.settings.perPageCharLimit);

            this.progress('Fetch URL: completed.');

            return [
                'fetch_url_result:',
                `url: ${finalUrl}`,
                `title: ${title || '(untitled)'}`,
                `text:\n${text || '(no extractable text)'}`,
            ].join('\n');
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return [
                'fetch_url_result:',
                `url: ${url}`,
                `error: failed to fetch page: ${reason}`,
            ].join('\n');
        }
    }

    private progress(message: string): void {
        if (this.onProgress) this.onProgress(message);
    }

    private extractTitle(html: string, pageUrl: string): string {
        try {
            const dom = new JSDOM(html, { url: pageUrl });
            return cleanText(dom.window.document.title || '');
        } catch {
            return '';
        }
    }

    private extractWithReadability(html: string, pageUrl: string): string {
        try {
            const dom = new JSDOM(html, { url: pageUrl });
            const article = new Readability(dom.window.document).parse();
            return cleanText(article?.textContent ?? '');
        } catch {
            return '';
        }
    }

    private extractWithCheerio(html: string): string {
        const $ = cheerio.load(html);
        $('script, style, noscript').remove();

        const mainCandidate = cleanText($('main').text());
        if (mainCandidate.length > 0) return mainCandidate;

        const articleCandidate = cleanText($('article').text());
        if (articleCandidate.length > 0) return articleCandidate;

        return cleanText($('body').text());
    }
}

export function getToolPrompt(): string {
    return (
        '4. fetch_url(url)\n' +
        '   Fetch a specific URL and return extracted page text.\n' +
        '   Use this to follow links from web_search, revisit a page, or inspect a\n' +
        '   known URL directly without running a new search query.\n\n'
    );
}
