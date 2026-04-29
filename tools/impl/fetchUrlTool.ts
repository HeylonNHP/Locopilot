import { fetchAndExtract } from '../web/htmlExtractor';
import type { WebSearchSettings } from './webSearchTool';

export interface FetchUrlToolArgs {
    url?: string;
    use_playwright?: boolean;
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
            const result = await fetchAndExtract(url, this.settings, {
                usePlaywright: args.use_playwright === true,
            });

            this.progress('Fetch URL: completed.');

            const linksStr = result.links.length > 0
                ? result.links.map((l) => `- [${l.text}](${l.url})`).join('\n')
                : '(none)';

            const methodNote = args.use_playwright
                ? '\n[Note: This page was rendered using Playwright (browser) because use_playwright was requested.]'
                : '';

            return [
                'fetch_url_result:',
                `url: ${result.finalUrl}`,
                `title: ${result.title || '(untitled)'}`,
                `text:\n${result.text || '(no extractable text)'}${methodNote}`,
                `links:\n${linksStr}`,
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
        '4. fetch_url(url, use_playwright?)\n' +
        '   Fetch a specific URL and return extracted page text.\n' +
        '   Use this to follow links from web_search, revisit a known page directly,\n' +
        '   or when you need more control over the extraction process.\n\n' +
        '   - url: A full http or https URL to fetch, for example: https://example.com/article\n' +
        '   - use_playwright (optional): When true, uses a real browser (Playwright) to render\n' +
        '     the page before extracting text. This is useful for JavaScript-heavy pages,\n' +
        '     SPAs, or sites that require client-side rendering. May be slower than standard\n' +
        '     fetching but provides more complete content extraction.\n\n'
    );
}
