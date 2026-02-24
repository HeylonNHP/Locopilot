import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';

export interface ExtractResult {
    title: string;
    text: string;
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
        const dom = new JSDOM(html, { url });
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
        const dom = new JSDOM(html, { url });
        const article = new Readability(dom.window.document).parse();
        return cleanText(article?.textContent ?? '');
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
        $('script, style, noscript').remove();

        const mainCandidate = cleanText($('main').text());
        if (mainCandidate.length > 0) return mainCandidate;

        const articleCandidate = cleanText($('article').text());
        if (articleCandidate.length > 0) return articleCandidate;

        return cleanText($('body').text());
    } catch {
        return '';
    }
}

/**
 * High-level: try Readability first, fall back to cheerio.
 */
export function extractMainText(html: string, url: string): string {
    const readabilityText = extractWithReadability(html, url);
    const fallbackText = extractWithCheerio(html);
    
    // If readability returned something decent, use it. 
    // Otherwise fallback to whatever cheerio got.
    if (readabilityText && readabilityText.length >= fallbackText.length) {
        return readabilityText;
    }
    return fallbackText;
}

export const DEFAULT_USER_AGENT = 'Locopilot/1.0 (+https://ollama.com)';
