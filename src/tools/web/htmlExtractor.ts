import { Readability } from '@mozilla/readability';
import axios from 'axios';
import * as cheerio from 'cheerio';
/**
 * HTML extraction utilities for Locopilot web tools.
 *
 * This module fetches remote pages, validates HTML content, and extracts
 * readable text and titles using a best-effort pipeline.
 *
 * Extraction order:
 * 1. Mozilla Readability for article-style content
 * 2. cheerio-based fallback selectors when Readability fails or returns
 *    insufficient text
 * 3. Playwright browser rendering (when requested or as automatic fallback)
 *    — see playwrightRenderer.ts
 */
import { JSDOM, VirtualConsole } from 'jsdom';

import type { ToolOutputSink } from '../toolOutput';

import { ContentCompactor } from '../impl/contentCompactor';
import { type ExtractedLink, extractLinks } from './linkExtractor';
import {
  renderWithPlaywright,
  shouldPreferRenderedText,
  shouldTryBrowserFallback,
} from './playwrightRenderer';
import { buildWebRequestHeaders } from './webRequestHeaders';

export interface WebExtractionSettings {
  requestTimeoutMs: number;
  perPageCharLimit: number;
  baseUrl: string; // REQUIRED - always from config, never optional
  compactionModel: string;
  cookieHeader?: string;
  output?: ToolOutputSink;
}

export interface ExtractResult {
  title: string;
  text: string;
}

/**
 * Threshold for Readability extraction; if the resulting text is shorter
 * than this, we consider it a possible failure and try a fallback.
 */
const MIN_READABILITY_LENGTH = 200;

/**
 * Strips extra whitespace, normalizes line endings, and trims.
 */
export function cleanText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll(/[\t ]+/g, ' ')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Robust title extraction from <title> and common meta tags.
 */
export function extractTitle(html: string, url?: string): string {
  try {
    const dom = new JSDOM(html, {
      url,
      virtualConsole: new VirtualConsole(), // Suppress CSS parsing errors
    });
    const doc = dom.window.document;
    const title =
      doc.querySelector('title')?.textContent?.trim() ||
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ||
      '';
    return cleanText(title);
  } catch {
    return '';
  }
}

/**
 * Try Readability (best effort). Returns null on failure.
 */
export function extractWithReadability(html: string, url: string): string | null {
  try {
    const dom = new JSDOM(html, {
      url,
      virtualConsole: new VirtualConsole(), // Suppress CSS parsing errors
    });
    const article = new Readability(dom.window.document).parse();
    const text = cleanText(article?.textContent ?? '');
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Simple cheerio-based fallback extractor.
 */
export function extractWithCheerio(html: string): string {
  try {
    const $ = cheerio.load(html);
    $('script, style, noscript, nav, footer, header').remove();

    // ── Priority-based selector candidates ───────────────────────
    const selectors = [
      'main',
      'article',
      'div[role="main"]',
      '#content',
      '.post-content',
      '.article-content',
      'body',
    ];

    for (const selector of selectors) {
      const candidate = cleanText($(selector).text());
      if (candidate.length > 50) return candidate;
    }

    return '';
  } catch {
    return '';
  }
}

/**
 * High-level: try Readability first, fall back to cheerio.
 */
export function extractMainText(html: string, url: string): string {
  const readabilityText = extractWithReadability(html, url);

  // If readability returned something decent, use it and skip cheerio.
  if (readabilityText && readabilityText.length > MIN_READABILITY_LENGTH) {
    return readabilityText;
  }

  const fallbackText = extractWithCheerio(html);

  // If readability got something but it was very short (less than threshold),
  // and cheerio got more, prefer cheerio.
  if (readabilityText && readabilityText.length >= fallbackText.length) {
    return readabilityText;
  }
  return fallbackText;
}

export interface FetchAndExtractOptions {
  usePlaywright?: boolean;
  /**
   * When true, skip per-page character-limit compaction and return the
   * full extracted text. Used by the fetch_url tool's `full_content`
   * option to let the LLM opt out of compaction for a specific URL
   * (e.g. large code snippets or documentation pages where the full
   * content is needed).
   */
  fullContent?: boolean;
  signal?: AbortSignal;
}

/**
 * Fetches a webpage from the given URL, extracts its main content, title, final URL, and links,
 * and optionally applies Playwright rendering or text compaction if needed.
 *
 * @param {string} url - The URL of the webpage to fetch and extract content from.
 * @param {WebExtractionSettings} settings - The settings used for web extraction, including request timeout and cookie headers.
 * @param {FetchAndExtractOptions} [options={}] - Optional parameters that specify extraction preferences such as Playwright usage and full content extraction.
 * @param {AbortSignal} [signal] - Optional signal to abort the request, typically used for canceling a fetch operation.
 * @return {Promise<{ title: string; text: string; finalUrl: string; links: ExtractedLink[] }>} A promise that resolves to an object containing the extracted title, main text, final URL, and list of links.
 */
export async function fetchAndExtract(
  url: string,
  settings: WebExtractionSettings,
  options: FetchAndExtractOptions = {},
  signal?: AbortSignal
): Promise<{ title: string; text: string; finalUrl: string; links: ExtractedLink[] }> {
  const response = await axios.get<string>(url, {
    timeout: settings.requestTimeoutMs,
    ...(signal ? { signal } : {}),
    headers: buildWebRequestHeaders(
      url,
      settings.cookieHeader ? { cookieHeader: settings.cookieHeader } : undefined
    ),
    responseType: 'text',
    maxRedirects: 5,
  });

  const finalUrl = response.request?.res?.responseUrl || url;

  // ── Suggestion #7: Content-Type check ────────────────────────────
  const contentType = String(response.headers['content-type'] ?? '');
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw new Error(`Unsupported content type: ${contentType}. only HTML pages are supported.`);
  }

  const html = response.data;
  const staticText = extractMainText(html, finalUrl);

  let extractionHtml = html;
  let extractionUrl = finalUrl;
  let text = staticText;

  // Use Playwright if explicitly requested OR if automatic fallback detection suggests it
  const shouldTryPlaywright = options.usePlaywright || shouldTryBrowserFallback(html, staticText);

  if (shouldTryPlaywright) {
    const renderedPage = await renderWithPlaywright(url, settings, signal);
    if (renderedPage) {
      const renderedText = extractMainText(renderedPage.html, renderedPage.finalUrl);

      // If explicitly requested, always prefer the rendered result (unless empty)
      // If automatic fallback, use the preference logic
      const shouldUseRendered = options.usePlaywright
        ? renderedText.length > 0
        : shouldPreferRenderedText(staticText, renderedText);

      if (shouldUseRendered) {
        extractionHtml = renderedPage.html;
        extractionUrl = renderedPage.finalUrl;
        text = renderedText;
      }
    }
  }

  const title = extractTitle(extractionHtml, extractionUrl);
  const links = extractLinks(extractionHtml, extractionUrl);

  if (options.fullContent || settings.perPageCharLimit <= 0) {
    return { title, text, finalUrl: extractionUrl, links };
  }

  // Use content compactor if text exceeds the character limit
  // baseUrl is REQUIRED and always comes from config
  const compactor = ContentCompactor.create(settings, settings.baseUrl);
  const processedText = await compactor.compactIfNeeded(text);

  return { title, text: processedText, finalUrl: extractionUrl, links };
}