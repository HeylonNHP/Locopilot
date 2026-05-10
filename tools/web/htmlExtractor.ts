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
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { ContentCompactor } from '../impl/contentCompactor';
import { buildWebRequestHeaders } from './webRequestHeaders';
import type { ToolOutputSink } from '../toolOutput';

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

export interface ExtractedLink {
    url: string;
    text: string;
}

/**
 * Threshold for Readability extraction; if the resulting text is shorter
 * than this, we consider it a possible failure and try a fallback.
 */
const MIN_READABILITY_LENGTH = 200;
export const DEFAULT_USER_AGENT = 'Locopilot/1.0 (+https://ollama.com)';
const MAX_LINKS = 50;
const MIN_BROWSER_FALLBACK_TEXT_LENGTH = 300;
const BROWSER_RENDER_TIMEOUT_MS = 15_000;

const JS_HEAVY_PATTERNS = [
    /__NEXT_DATA__/i,
    /__NUXT__/i,
    /window\.__INITIAL_STATE__/i,
    /window\.__APOLLO_STATE__/i,
    /data-reactroot/i,
    /data-react/i,
    /ng-version/i,
    /id=["']?(?:__next|__nuxt|root|app)["']?/i,
];

interface RenderedPage {
    html: string;
    finalUrl: string;
}

/**
 * Strips extra whitespace, normalizes line endings, and trims.
 */
export function cleanText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Robust title extraction from <title> and common meta tags.
 */
export function extractTitle(html: string, url?: string): string {
    try {
        const dom = new JSDOM(html, { 
            url,
            virtualConsole: new VirtualConsole() // Suppress CSS parsing errors
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
            virtualConsole: new VirtualConsole() // Suppress CSS parsing errors
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
            'body'
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

function shouldTryBrowserFallback(html: string, text: string): boolean {
    if (text.length >= MIN_BROWSER_FALLBACK_TEXT_LENGTH) {
        return false;
    }

    if (JS_HEAVY_PATTERNS.some((pattern) => pattern.test(html))) {
        return true;
    }

    const scriptCount = (html.match(/<script\b/gi) ?? []).length;
    const noscriptCount = (html.match(/<noscript\b/gi) ?? []).length;
    const textIsVeryThin = text.length < 120;
    const htmlLooksAppLike = html.length > 3000 && scriptCount >= 3;

    return (textIsVeryThin && (scriptCount >= 3 || noscriptCount > 0)) || htmlLooksAppLike;
}

function shouldPreferRenderedText(staticText: string, renderedText: string): boolean {
    if (renderedText.length === 0) {
        return false;
    }

    if (staticText.length === 0) {
        return true;
    }

    if (renderedText.length >= staticText.length) {
        return true;
    }

    return staticText.length < MIN_BROWSER_FALLBACK_TEXT_LENGTH && renderedText.length >= Math.floor(staticText.length * 0.75);
}

async function renderWithPlaywright(url: string, settings: WebExtractionSettings, signal?: AbortSignal): Promise<RenderedPage | null> {
    try {
        const playwrightModule = await import('playwright');
        const browser = await playwrightModule.chromium.launch({ headless: true });

        try {
            const headers = buildWebRequestHeaders(
                url,
                settings.cookieHeader ? { cookieHeader: settings.cookieHeader } : undefined,
            );

            const extraHTTPHeaders: Record<string, string> = {};
            if (headers['Accept-Language']) extraHTTPHeaders['Accept-Language'] = headers['Accept-Language'];
            if (headers.Referer) extraHTTPHeaders['Referer'] = headers.Referer;
            if (headers.Cookie) extraHTTPHeaders['Cookie'] = headers.Cookie;

            const context = await browser.newContext({
                userAgent: headers['User-Agent'] ?? DEFAULT_USER_AGENT,
                extraHTTPHeaders,
                ...(signal ? { signal } : {}),
            });

            try {
                const page = await context.newPage();
                const timeoutMs = Math.min(settings.requestTimeoutMs, BROWSER_RENDER_TIMEOUT_MS);

                try {
                    await page.goto(url, {
                        waitUntil: 'domcontentloaded',
                        timeout: timeoutMs,
                        ...(signal ? { signal } : {}),
                    });
                } catch {
                    // Continue with the partially rendered DOM if navigation times out.
                }

                await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 5000), ...(signal ? { signal } : {}) }).catch(() => undefined);

                const html = await page.content();
                const finalUrl = page.url() || url;
                if (!html.trim()) {
                    return null;
                }

                return { html, finalUrl };
            } finally {
                await context.close();
            }
        } finally {
            await browser.close();
        }
    } catch {
        return null;
    }
}

/**
 * Extracts unique, absolute http/https links from an HTML page.
 * Relative hrefs are resolved against `baseUrl`.
 */
export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
    try {
        const $ = cheerio.load(html);
        const seen = new Set<string>();
        const links: ExtractedLink[] = [];

        $('a[href]').each((_, el) => {
            if (links.length >= MAX_LINKS) return;
            const href = $(el).attr('href')?.trim() ?? '';
            if (!href) return;

            let resolved: string;
            try {
                resolved = new URL(href, baseUrl).toString();
            } catch {
                return;
            }

            if (!/^https?:\/\//i.test(resolved)) return;
            if (seen.has(resolved)) return;
            seen.add(resolved);

            const text = cleanText($(el).text()) || resolved;
            links.push({ url: resolved, text });
        });

        return links;
    } catch {
        return [];
    }
}

export interface FetchAndExtractOptions {
    usePlaywright?: boolean;
    signal?: AbortSignal;
}

/**
 * Common fetch + extraction logic shared by web tools.
 * 
 * @param url - The URL to fetch
 * @param settings - Extraction settings
 * @param options - Additional options
 * @param options.usePlaywright - If true, always use Playwright for rendering (useful for JavaScript-heavy pages)
 */
export async function fetchAndExtract(
    url: string,
    settings: WebExtractionSettings,
    options: FetchAndExtractOptions = {},
    signal?: AbortSignal,
): Promise<{ title: string; text: string; finalUrl: string; links: ExtractedLink[] }> {
    const response = await axios.get<string>(url, {
        timeout: settings.requestTimeoutMs,
        ...(signal ? { signal } : {}),
        headers: buildWebRequestHeaders(
            url,
            settings.cookieHeader ? { cookieHeader: settings.cookieHeader } : undefined,
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

    if (settings.perPageCharLimit <= 0) {
        return { title, text, finalUrl: extractionUrl, links };
    }

    // Use content compactor if text exceeds the character limit
    // baseUrl is REQUIRED and always comes from config
    const compactor = ContentCompactor.create(settings, settings.baseUrl);
    const processedText = await compactor.compactIfNeeded(text);

    return { title, text: processedText, finalUrl: extractionUrl, links };
}
