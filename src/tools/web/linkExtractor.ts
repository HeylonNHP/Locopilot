import * as cheerio from 'cheerio';

import { cleanText } from './htmlExtractor';

export interface ExtractedLink {
  url: string;
  text: string;
}

const MAX_LINKS = 50;

/**
 * Extracts unique, absolute http/https links from an HTML page.
 * Relative hrefs are resolved against `baseUrl`.
 */
export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  const $ = cheerio.load(html);
  const anchors = [...$('a[href]')];
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();

  for (const el of anchors) {
    if (links.length >= MAX_LINKS) break;
    const $el = $(el);
    const resolved = tryResolveUrl($el.attr('href') ?? '', baseUrl);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    links.push({ url: resolved, text: cleanText($el.text()) || resolved });
  }

  return links;
}

function tryResolveUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base).toString();
    return url.startsWith('http://') || url.startsWith('https://') ? url : null;
  } catch {
    return null;
  }
}
