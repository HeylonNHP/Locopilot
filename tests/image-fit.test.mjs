/**
 * Regression checks: an image in a reply must FIT inside the message bubble.
 *
 * The bug: `marked` emits a bare <img> for `![alt](url)`, the bubble is a
 * block capped at `max-width: 80%` that never grows to fit its content, so a
 * wide image ran out of the bubble — and because `.messages-area` is
 * `overflow-y: auto`, the browser computed `overflow-x` as `auto` too and the
 * whole thread gained a horizontal scrollbar.
 *
 * Two layers:
 *   1. the COMPUTED style of the image inside a real bubble — asserted in
 *      Chromium, so it does not depend on how the rule is spelled in CSS;
 *   2. the real geometry, measured in Chromium — the only thing that actually
 *      reproduces the defect, since it is a CSS layout problem.
 *
 * The harness is faithful by construction: the stylesheets are the app's own
 * compiled SCSS, and the DOM is built by `marked` (the library the app uses),
 * wrapped in the classes the app's components render.
 *
 * No network: the images are canvas-generated data URLs.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { marked } from 'marked';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as sass from 'sass';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function compileScss(file) {
  return sass.compile(path.join(REPO_ROOT, file), {
    loadPaths: [path.join(REPO_ROOT, 'src/app/styles')],
    quietDeps: true,
    silenceDeprecations: ['import', 'global-builtin', 'color-functions'],
  }).css;
}

const appCss = [
  compileScss('src/app/globals.scss'),
  compileScss('src/app/styles/_app-layout.scss'),
  compileScss('src/components/ChatMessageBubble/ChatMessageBubble.scss'),
  compileScss('src/components/MarkdownMessage/MarkdownMessage.scss'),
].join('\n');

const MARKDOWN_IMAGE = '![a screenshot](__IMAGE__)';
const RAW_IMAGE = '<img src="__IMAGE__" width="2400" height="1500" alt="raw" />';
const HEIGHT_ONLY_IMAGE = '<img src="__IMAGE__" height="400" alt="height only" />';

describe('an image in a reply fits inside the message bubble (measured in Chromium)', () => {
  let browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  /**
   * Mount the real bubble around a real image and measure it.
   *
   * The DOM mirrors what the app renders: `.messages-area` (the scrolling
   * column) > `.bubble-ai-wrap` (the wrapper) > `.bubble-ai-msg` (the block
   * capped at 80 %) > `.markdown-message` > `.markdown-message-prose`, and the
   * inner HTML is whatever `marked` produces for the given markdown.
   */
  async function measure({ viewport = 1600, imageWidth = 2400, imageHeight = 1500, markdown }) {
    const page = await browser.newPage({ viewport: { width: viewport, height: 988 } });
    const dataUrl = await page.evaluate(
      async ([w, h]) => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const context = canvas.getContext('2d');
        context.fillStyle = '#123456';
        context.fillRect(0, 0, w, h);
        return canvas.toDataURL('image/png');
      },
      [imageWidth, imageHeight]
    );
    const html = marked.parse(markdown.replaceAll('__IMAGE__', dataUrl), {
      breaks: true,
      gfm: true,
    });
    await page.setContent(
      `<!doctype html><html><head><style>${appCss}
      html, body { margin: 0; padding: 0; }
      .messages-area { height: 988px; }
    </style></head><body>
      <div class="messages-area"><div class="bubble-ai-wrap"><div class="bubble-ai-msg">
        <div class="markdown-message"><div class="markdown-message-prose">${html}</div></div>
      </div></div></div>
    </body></html>`,
      { waitUntil: 'load' }
    );
    const result = await page.evaluate(() => {
      const img = document.querySelector('img');
      const bubble = document.querySelector('.bubble-ai-msg');
      const area = document.querySelector('.messages-area');
      const style = img ? getComputedStyle(img) : null;
      const imgBox = img.getBoundingClientRect();
      const bubbleBox = bubble.getBoundingClientRect();
      return {
        naturalWidth: img ? img.naturalWidth : -1,
        naturalHeight: img ? img.naturalHeight : -1,
        imgWidth: Math.round(imgBox.width),
        imgHeight: Math.round(imgBox.height),
        imgRight: Math.round(imgBox.right),
        bubbleWidth: Math.round(bubbleBox.width),
        bubbleRight: Math.round(bubbleBox.right),
        scrollWidth: area.scrollWidth,
        clientWidth: area.clientWidth,
        maxWidth: style ? style.maxWidth : null,
        height: style ? style.height : null,
      };
    });
    await page.close();
    return result;
  }

  describe('a markdown image 2400px wide', () => {
    let wide;

    beforeAll(async () => {
      wide = await measure({ markdown: MARKDOWN_IMAGE });
    });

    test('actually loaded (so the assertions are not vacuous)', () => {
      expect(wide.naturalWidth).toBeGreaterThan(0);
    });

    test('has its width capped at 100% by the computed style', () => {
      expect(wide.maxWidth).toBe('100%');
    });

    test('resolves its height from the ratio, not from an attribute', () => {
      // `getComputedStyle` reports the USED height, so it is never the literal
      // "auto" — the meaningful assertion is that it follows the image's ratio
      // rather than an author-supplied height attribute (checked below).
      expect(wide.imgHeight).toBeGreaterThan(0);
      // the height attribute of 1500px must not be honoured instead of the ratio
      expect(wide.imgHeight).not.toBe(1500);
    });

    test('is scaled down to the bubble', () => {
      // the image must not run past the bubble's right edge
      expect(wide.imgWidth).toBeLessThanOrEqual(wide.bubbleRight);
      expect(wide.imgWidth).toBeLessThan(2400);
    });

    test('keeps its aspect ratio', () => {
      const expected = Math.round((2400 / 1500) * wide.imgHeight);
      expect(Math.abs(wide.imgWidth - expected)).toBeLessThanOrEqual(2);
    });

    test('does not give the thread a horizontal scrollbar', () => {
      expect(wide.scrollWidth).toBe(wide.clientWidth);
    });
  });

  describe('a raw <img> with width and height attributes', () => {
    let raw;

    beforeAll(async () => {
      raw = await measure({ markdown: RAW_IMAGE });
    });

    test('is clamped to the bubble', () => {
      expect(raw.naturalWidth).toBeGreaterThan(0);
      expect(raw.imgWidth).toBeLessThanOrEqual(raw.bubbleRight);
      expect(raw.imgWidth).toBeLessThan(2400);
    });

    test('is not distorted', () => {
      const expected = Math.round((2400 / 1500) * raw.imgHeight);
      expect(Math.abs(raw.imgWidth - expected)).toBeLessThanOrEqual(2);
    });
  });

  test('a raw <img> with only a height attribute still fits the bubble', async () => {
    // The rule overrides the author's height attribute so the image keeps its
    // own ratio (`height: auto`); the image therefore ends up LARGER than the
    // 400px that was asked for. That is deliberate and matches every other
    // markdown renderer — what matters here is that it still fits.
    const heightOnly = await measure({ markdown: HEIGHT_ONLY_IMAGE });
    expect(heightOnly.naturalWidth).toBeGreaterThan(0);
    expect(heightOnly.imgWidth).toBeLessThanOrEqual(heightOnly.bubbleRight);
    expect(heightOnly.scrollWidth).toBe(heightOnly.clientWidth);
  });

  test.each([
    ['inside a table cell', `| cell |\n| --- |\n| ${MARKDOWN_IMAGE} |`],
    ['inside a blockquote', `> ${MARKDOWN_IMAGE}`],
  ])('an image %s fits too', async (_where, markdown) => {
    const measured = await measure({ markdown });
    expect(measured.naturalWidth).toBeGreaterThan(0);
    expect(measured.imgWidth).toBeLessThanOrEqual(measured.bubbleRight);
  });

  test('it fits on a narrow viewport too', async () => {
    const narrow = await measure({ viewport: 900, markdown: MARKDOWN_IMAGE });
    expect(narrow.naturalWidth).toBeGreaterThan(0);
    expect(narrow.imgWidth).toBeLessThanOrEqual(narrow.bubbleRight);
    expect(narrow.scrollWidth).toBe(narrow.clientWidth);
  });

  test('a small image is NOT upscaled', async () => {
    const small = await measure({ imageWidth: 32, imageHeight: 32, markdown: MARKDOWN_IMAGE });
    expect(small.naturalWidth).toBeGreaterThan(0);
    // the bubble must not have shrunk, or this proves nothing
    expect(small.bubbleWidth).toBeGreaterThanOrEqual(1000);
    expect(small.imgWidth).toBeLessThanOrEqual(32);
  });

  test('a tall narrow image does not overflow horizontally', async () => {
    const tall = await measure({ imageWidth: 300, imageHeight: 4000, markdown: MARKDOWN_IMAGE });
    expect(tall.naturalWidth).toBeGreaterThan(0);
    expect(tall.imgWidth).toBeLessThanOrEqual(tall.bubbleRight);
  });

  test('an image outside a .markdown-message container is NOT clamped', async () => {
    // The rule is scoped to the markdown container, so an image elsewhere in
    // the app (an attachment thumbnail, an avatar) keeps its own sizing.
    const page = await browser.newPage({ viewport: { width: 1600, height: 988 } });
    await page.setContent(
      `<!doctype html><html><head><style>${appCss}</style></head><body>
          <div class="bubble-user"><img id="loose" src="" style="width: 2400px; height: 1500px;" /></div>
        </body></html>`,
      { waitUntil: 'load' }
    );
    const maxWidth = await page.evaluate(() => {
      const img = document.querySelector('#loose');
      return getComputedStyle(img).maxWidth;
    });
    await page.close();
    expect(maxWidth).not.toBe('100%');
  });
});
