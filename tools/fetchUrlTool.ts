import axios from 'axios';
import { extractMainText, extractTitle, DEFAULT_USER_AGENT } from './htmlExtractor.js';
import type { WebSearchSettings } from './webSearchTool.js';

export interface FetchUrlToolArgs {
    url?: string;
}

export interface FetchUrlOptions {
    settings: WebSearchSettings;
    onProgress?: (message: string) => void;
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
            const title = extractTitle(html, finalUrl);
            const text = extractMainText(html, finalUrl).slice(0, this.settings.perPageCharLimit);

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
}

export function getToolPrompt(): string {
    return (
        '4. fetch_url(url)\n' +
        '   Fetch a specific URL and return extracted page text.\n' +
        '   Use this to follow links from web_search, revisit a page, or inspect a\n' +
        '   known URL directly without running a new search query.\n\n'
    );
}
