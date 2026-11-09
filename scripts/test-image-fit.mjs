#!/usr/bin/env node
/**
 * Regression checks: an image in a reply must FIT inside the message bubble.
 *
 * Run with: npx tsx scripts/test-image-fit.mjs
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

import { marked } from 'marked';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as sass from 'sass';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
  }
}

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

console.log('The computed style (measured in Chromium)');

const browser = await chromium.launch({ headless: true });

/**
 * Mount the real bubble around a real image and measure it.
 *
 * The DOM mirrors what the app renders: `.messages-area` (the scrolling
 * column) > `.bubble-ai-wrap` (the wrapper) > `.bubble-ai-msg` (the block
 * capped at 80 %) > `.markdown-message` > `.markdown-message-prose`, and the
 * inner HTML is whatever `marked` produces for the given markdown.
 */
async function measure({ viewport, imageWidth, imageHeight, markdown }) {
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

const MARKDOWN_IMAGE = '![a screenshot](__IMAGE__)';
const RAW_IMAGE = '<img src="__IMAGE__" width="2400" height="1500" alt="raw" />';
const HEIGHT_ONLY_IMAGE = '<img src="__IMAGE__" height="400" alt="height only" />';

try {
  const wide = await measure({
    viewport: 1600,
    imageWidth: 2400,
    imageHeight: 1500,
    markdown: MARKDOWN_IMAGE,
  });

  await check('the image actually loaded (the assertions are not vacuous)', () => {
    assert.ok(wide.naturalWidth > 0, `the image never loaded (naturalWidth ${wide.naturalWidth})`);
  });

  await check('the computed style caps the width at 100%', () => {
    assert.equal(wide.maxWidth, '100%');
  });

  await check('the computed style resolves the height from the ratio, not an attribute', () => {
    // `getComputedStyle` reports the USED height, so it is never the literal
    // "auto" — the meaningful assertion is that it follows the image's ratio
    // rather than an author-supplied height attribute (checked below).
    assert.ok(wide.imgHeight > 0, 'the image has no used height');
    assert.notEqual(
      wide.imgHeight,
      1500,
      'the height attribute of 1500px was honoured instead of the ratio'
    );
  });

  await check('a 2400px-wide image is scaled down to the bubble', () => {
    assert.ok(
      wide.imgWidth <= wide.bubbleRight,
      `the image (${wide.imgWidth}px wide, right edge ${wide.imgRight}) still runs past the bubble's right edge (${wide.bubbleRight})`
    );
    assert.ok(wide.imgWidth < 2400, `the image was not scaled down (width ${wide.imgWidth})`);
  });

  await check('the scaled image keeps its aspect ratio', () => {
    const expected = Math.round((2400 / 1500) * wide.imgHeight);
    assert.ok(
      Math.abs(wide.imgWidth - expected) <= 2,
      `width ${wide.imgWidth} does not match the height ${wide.imgHeight} at a 1.6 ratio (expected ~${expected})`
    );
  });

  await check('the thread does not gain a horizontal scrollbar', () => {
    assert.equal(
      wide.scrollWidth,
      wide.clientWidth,
      `scrollWidth ${wide.scrollWidth} > clientWidth ${wide.clientWidth}`
    );
  });

  const raw = await measure({
    viewport: 1600,
    imageWidth: 2400,
    imageHeight: 1500,
    markdown: RAW_IMAGE,
  });

  await check('a raw <img> with width/height attributes is also clamped', () => {
    assert.ok(
      raw.naturalWidth > 0,
      `the raw image never loaded (naturalWidth ${raw.naturalWidth})`
    );
    assert.ok(
      raw.imgWidth <= raw.bubbleRight,
      `the raw image (${raw.imgWidth}px) still overflows the bubble (${raw.bubbleRight})`
    );
    assert.ok(raw.imgWidth < 2400, `the raw image was not scaled down (width ${raw.imgWidth})`);
  });

  await check('a raw <img> with width/height attributes is not distorted', () => {
    const expected = Math.round((2400 / 1500) * raw.imgHeight);
    assert.ok(
      Math.abs(raw.imgWidth - expected) <= 2,
      `width ${raw.imgWidth} does not match the height ${raw.imgHeight} at a 1.6 ratio (expected ~${expected})`
    );
  });

  const heightOnly = await measure({
    viewport: 1600,
    imageWidth: 2400,
    imageHeight: 1500,
    markdown: HEIGHT_ONLY_IMAGE,
  });

  await check('a raw <img> with only a height attribute still fits the bubble', () => {
    // The rule overrides the author's height attribute so the image keeps its
    // own ratio (`height: auto`); the image therefore ends up LARGER than the
    // 400px that was asked for. That is deliberate and matches every other
    // markdown renderer — what matters here is that it still fits.
    assert.ok(heightOnly.naturalWidth > 0, 'the image never loaded');
    assert.ok(
      heightOnly.imgWidth <= heightOnly.bubbleRight,
      `the image (${heightOnly.imgWidth}px) overflows the bubble (${heightOnly.bubbleRight})`
    );
    assert.equal(heightOnly.scrollWidth, heightOnly.clientWidth);
  });

  const inTable = await measure({
    viewport: 1600,
    imageWidth: 2400,
    imageHeight: 1500,
    markdown: `| cell |\n| --- |\n| ${MARKDOWN_IMAGE} |`,
  });

  await check('an image inside a table cell fits too', () => {
    assert.ok(inTable.naturalWidth > 0, 'the image never loaded');
    assert.ok(
      inTable.imgWidth <= inTable.bubbleRight,
      `the image in a table (${inTable.imgWidth}px) overflows (${inTable.bubbleRight})`
    );
  });

  const inQuote = await measure({
    viewport: 1600,
    imageWidth: 2400,
    imageHeight: 1500,
    markdown: `> ${MARKDOWN_IMAGE}`,
  });

  await check('an image inside a blockquote fits too', () => {
    assert.ok(inQuote.naturalWidth > 0, 'the image never loaded');
    assert.ok(
      inQuote.imgWidth <= inQuote.bubbleRight,
      `the image in a quote (${inQuote.imgWidth}px) overflows (${inQuote.bubbleRight})`
    );
  });

  const narrow = await measure({
    viewport: 900,
    imageWidth: 2400,
    imageHeight: 1500,
    markdown: MARKDOWN_IMAGE,
  });

  await check('it fits on a narrow viewport too', () => {
    assert.ok(narrow.naturalWidth > 0, 'the image never loaded');
    assert.ok(
      narrow.imgWidth <= narrow.bubbleRight,
      `the image (${narrow.imgWidth}px) overflows a 900px viewport (${narrow.bubbleRight})`
    );
    assert.equal(narrow.scrollWidth, narrow.clientWidth);
  });

  const small = await measure({
    viewport: 1600,
    imageWidth: 32,
    imageHeight: 32,
    markdown: MARKDOWN_IMAGE,
  });

  await check('a small image is NOT upscaled', () => {
    assert.ok(small.naturalWidth > 0, 'the image never loaded');
    assert.ok(
      small.bubbleWidth >= 1000,
      `the bubble shrank to ${small.bubbleWidth}px, so this proves nothing`
    );
    assert.ok(small.imgWidth <= 32, `a 32px image was stretched to ${small.imgWidth}px`);
  });

  const tall = await measure({
    viewport: 1600,
    imageWidth: 300,
    imageHeight: 4000,
    markdown: MARKDOWN_IMAGE,
  });

  await check('a tall narrow image does not overflow horizontally', () => {
    assert.ok(tall.naturalWidth > 0, 'the image never loaded');
    assert.ok(
      tall.imgWidth <= tall.bubbleRight,
      `the tall image (${tall.imgWidth}px) overflows (${tall.bubbleRight})`
    );
  });

  await check('an image outside a .markdown-message container is NOT clamped', () => {
    // The rule is scoped to the markdown container, so an image elsewhere in
    // the app (an attachment thumbnail, an avatar) keeps its own sizing.
    return browser.newPage({ viewport: { width: 1600, height: 988 } }).then(async (page) => {
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
      assert.notEqual(maxWidth, '100%', 'the rule reached an image outside .markdown-message');
    });
  });
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
