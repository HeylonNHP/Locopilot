import type { ToolSchema } from '../../tools/tools';

export const fetchUrlToolSchema: ToolSchema = {
    name: 'fetch_url',
    description: 'Fetches content from a specific URL and returns extracted page text. Use this for known URLs, not for searching. Useful for retrieving article content, documentation, or specific web pages.',
    parameters: {
        type: 'object',
        properties: {
            url:         { type: 'string', description: 'A full http or https URL to fetch, for example: https://example.com/article' },
            use_playwright:{ type: 'boolean', description: 'When true, uses a real browser (Playwright) to render the page before extracting text. Useful for JavaScript-heavy pages. May be slower but provides more complete content extraction.' },
        },
        required: ['url'],
    },
};

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
    const s = fetchUrlToolSchema;
    const p = s.parameters.properties;
    return (
        `4. ${s.name}(url, use_playwright?)\n` +
        `   ${s.description}\n\n` +
        `   - url: ${p.url!.description}\n` +
        `   - use_playwright: ${p.use_playwright!.description}\n`
    );
}
