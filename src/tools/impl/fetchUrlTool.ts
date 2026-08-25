import type { ToolSchema } from '@/tools/tools';

export const fetchUrlToolSchema: ToolSchema = {
  name: 'fetch_url',
  description:
    'Fetches content from a specific URL and returns extracted page text. Use this for known URLs, not for searching. Useful for retrieving article content, documentation, or specific web pages.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'A full http or https URL to fetch, for example: https://example.com/article',
      },
      use_playwright: {
        type: 'boolean',
        description:
          'When true, uses a real browser (Playwright) to render the page before extracting text. Useful for JavaScript-heavy pages. May be slower but provides more complete content extraction.',
      },
      full_content: {
        type: 'boolean',
        description:
          'When true, returns the full extracted page text without applying the per-page character limit compaction. Useful when you need complete content such as large code snippets, documentation pages, or detailed articles that should not be truncated. Defaults to false (compaction applies when content exceeds the configured limit). When the returned content is large relative to your context window, a warning will be appended to the result.',
      },
    },
    required: ['url'],
  },
};

import { READ_FILE_TOKEN_CRITICAL_PCT, READ_FILE_TOKEN_WARN_PCT } from '@/constants';
import { countTextTokens } from '@/services/tokenizer';
import { fetchAndExtract } from '@/tools/web/htmlExtractor';

import type { WebSearchSettings } from './webSearchTool';

export interface FetchUrlToolArgs {
  url?: string;
  use_playwright?: boolean;
  full_content?: boolean;
}

export interface FetchUrlOptions {
  settings: WebSearchSettings;
  /** Model name for the current request (used for token-estimating context-window warnings). */
  model?: string | undefined;
  /** Context window size for the current request (used for token-estimating context-window warnings). */
  numCtx?: number | undefined;
  onProgress?: (message: string) => void;
}

export class FetchUrlTool {
  private readonly settings: WebSearchSettings;
  private readonly model: string | undefined;
  private readonly numCtx: number | undefined;
  private readonly onProgress: ((message: string) => void) | undefined;

  constructor(options: FetchUrlOptions) {
    this.settings = options.settings;
    this.model = options.model;
    this.numCtx = options.numCtx;
    this.onProgress = options.onProgress;
  }

  async run(args: FetchUrlToolArgs, signal?: AbortSignal): Promise<string> {
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
        fullContent: args.full_content === true,
        ...(signal ? { signal } : {}),
      });

      this.progress('Fetch URL: completed.');

      const linksStr =
        result.links.length > 0
          ? result.links.map((l) => `- [${l.text}](${l.url})`).join('\n')
          : '(none)';

      const methodNote = args.use_playwright
        ? '\n[Note: This page was rendered using Playwright (browser) because use_playwright was requested.]'
        : '';

      // ── Token-aware context window warning ─────────────────
      // When compaction is skipped (full_content=true) or when a
      // page is still large after compaction, warn the LLM so it
      // can decide whether to sub-agent the analysis rather than
      // blowing out the context window.
      const tokenWarning = buildContextWindowWarning(
        result.text,
        this.model,
        this.numCtx,
        args.full_content === true
      );

      return [
        tokenWarning,
        'fetch_url_result:',
        `url: ${result.finalUrl}`,
        `title: ${result.title || '(untitled)'}`,
        `text:\n${result.text || '(no extractable text)'}${methodNote}`,
        `links:\n${linksStr}`,
        `\nSOURCES (use these exact numbers and real URLs when citing; do not invent URLs):\n[1] ${
          result.title || '(untitled)'
        } — ${result.finalUrl}`,
      ]
        .filter((part) => part.length > 0)
        .join('\n');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return ['fetch_url_result:', `url: ${url}`, `error: failed to fetch page: ${reason}`].join(
        '\n'
      );
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
    `4. ${s.name}(url, use_playwright?, full_content?)\n` +
    `   ${s.description}\n\n` +
    `   - url: ${p.url!.description}\n` +
    `   - use_playwright: ${p.use_playwright!.description}\n` +
    `   - full_content: ${p.full_content!.description}\n`
  );
}

/**
 * Estimates the token cost of a piece of extracted page text and returns a
 * human-readable warning suitable for prepending to the tool result when
 * the content would consume a significant fraction of the model's context
 * window. The thresholds mirror those used by read_file and read_pdf so the
 * LLM gets a consistent signal across large-content tools.
 *
 * @param text - The extracted page text.
 * @param model - Model name, used to look up a tokenizer. If undefined, no warning is produced.
 * @param numCtx - Context window size in tokens. If undefined, no warning is produced.
 * @param fullContent - When true, the warning explicitly notes that compaction was skipped,
 *                      which is the most common reason a fetch_url result is unexpectedly large.
 */
function buildContextWindowWarning(
  text: string,
  model: string | undefined,
  numCtx: number | undefined,
  fullContent: boolean
): string {
  if (!text || text.length === 0) return '';
  if (!model || !numCtx || numCtx <= 0) return '';

  let tokenEstimate = 0;
  try {
    tokenEstimate = countTextTokens(text, model);
  } catch {
    return '';
  }
  if (tokenEstimate <= 0) return '';

  const pct = (tokenEstimate / numCtx) * 100;
  const skippedCompaction = fullContent
    ? ' (compaction was skipped because full_content=true)'
    : '';

  if (pct >= READ_FILE_TOKEN_CRITICAL_PCT) {
    return (
      `\n🚨  Token Warning: This page content is approximately ${tokenEstimate.toLocaleString()} tokens (~${pct.toFixed(2)}% of your ${numCtx.toLocaleString()}-token context window)${skippedCompaction}.\n` +
      `⚠️  Loading this entire page into context is strongly discouraged. Use sub-agents to analyze it instead.\n` +
      `💡  Sub-agents have isolated context and won't consume your working memory — send them the URL and ask them to answer your question.\n`
    );
  }
  if (pct >= READ_FILE_TOKEN_WARN_PCT) {
    return (
      `\n⚠️  Token Notice: This page content is approximately ${tokenEstimate.toLocaleString()} tokens (~${pct.toFixed(2)}% of your ${numCtx.toLocaleString()}-token context window)${skippedCompaction}.\n` +
      `💡  Consider using sub-agents to process large pages — they have isolated context and won't consume your working memory.\n`
    );
  }
  return '';
}
