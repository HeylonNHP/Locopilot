/**
 * Playwright test that loads the temporary /mermaid-test Next.js route
 * and checks whether the Mermaid diagram rendered or shows the error panel.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();

page.on('console', (msg) => {
  const text = msg.text();
  console.log(`[page ${msg.type()}] ${text}`);
});

page.on('pageerror', (err) => {
  console.log(`[page error] ${err.message}\n${err.stack?.slice(0, 500) ?? ''}`);
});

await page.goto('http://127.0.0.1:3457/mermaid-test', { waitUntil: 'networkidle' });

// Wait briefly for useEffect / requestAnimationFrame to run.
await page.waitForTimeout(3000);

// Directly invoke the renderer in the page to bypass React/useEffect issues.
const directResult = await page.evaluate(async () => {
  const pre = document.querySelector('pre:has(code.language-mermaid)');
  if (!pre) return { noPre: true, bodyText: document.body.textContent.slice(0, 500) };
  try {
    await globalThis.__renderMermaidInPre?.(pre, { mermaidIdBase: 'direct' });
    return {
      dataset: pre.dataset.mermaidRendered,
      hasSvg: !!pre.querySelector('svg'),
      hasErrorPanel: !!pre.querySelector('.mermaid-error-panel'),
      errorMessage: pre.querySelector('.mermaid-error-message')?.textContent ?? null,
      errorDetails: pre.querySelector('.mermaid-error-details pre')?.textContent ?? null,
      html: pre.innerHTML.slice(0, 300),
    };
  } catch (err) {
    return { threw: String(err), message: err?.message, stack: err?.stack };
  }
});
console.log('Direct render result:', JSON.stringify(directResult, null, 2));

const result = await page.evaluate(() => {
  const pres = document.querySelectorAll('pre');
  const preInfo = [...pres].map((pre) => ({
    className: pre.className,
    dataset: pre.dataset.mermaidRendered,
    tagName: pre.tagName,
    html: pre.outerHTML.slice(0, 500),
  }));
  const pre = document.querySelector('pre.mermaid-rendered, pre.mermaid-error');
  if (!pre) {
    return { notFound: true, preInfo, bodyText: document.body.textContent.slice(0, 1000) };
  }
  const errorDetails = pre.querySelector('.mermaid-error-details pre');
  return {
    dataset: pre.dataset.mermaidRendered,
    hasSvg: !!pre.querySelector('svg'),
    hasErrorPanel: !!pre.querySelector('.mermaid-error-panel'),
    errorMessage: pre.querySelector('.mermaid-error-message')?.textContent ?? null,
    errorDetails: errorDetails?.textContent ?? null,
    source: pre.querySelector('.mermaid-error-source')?.textContent ?? null,
  };
});

console.log('Next.js page render result:', JSON.stringify(result, null, 2));

await browser.close();

if (directResult.threw || directResult.hasErrorPanel || directResult.dataset === 'error' || !directResult.hasSvg) {
  console.error('\n❌ Reproduction: Mermaid failed to render in Next.js app.');
  throw new Error("test failed");
} else {
  console.log('\n✅ Mermaid rendered successfully in Next.js app.');
}
