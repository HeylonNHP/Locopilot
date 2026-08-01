import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
/**
 * Playwright-based reproduction using the real Locopilot CSS tokens.
 * Bundles the renderer with esbuild and renders the test diagram in Chromium.
 */
import { chromium } from 'playwright';

await build({
  entryPoints: ['./src/components/MarkdownMessage/mermaidRenderer.ts'],
  bundle: true,
  format: 'esm',
  outfile: '/tmp/mermaidRenderer.bundle.js',
  target: 'es2022',
});

const bundle = readFileSync('/tmp/mermaidRenderer.bundle.js', 'utf8');

// Use the real Locopilot CSS variables.
const css = `
:root {
  --bg-primary: transparent;
  --accent: #00a8e8;
  --text-primary: #1a3a5c;
  --bg-secondary: rgba(255, 255, 255, 0.15);
  --text-secondary: #5a7a9a;
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
}`;

const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      ${bundle}

      const source = \`graph TD\n  A[User] --> B[Locopilot]\n  B --> C[Render Mermaid]\n  C --> D[Validated Chart]\`;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = source;
      pre.append(code);
      document.getElementById('root').append(pre);

      window.__renderResult = null;
      renderMermaidInPre(pre, { mermaidIdBase: 'test' }).then(() => {
        window.__renderResult = {
          dataset: pre.dataset.mermaidRendered,
          hasSvg: !!pre.querySelector('svg'),
          hasErrorPanel: !!pre.querySelector('.mermaid-error-panel'),
          innerHTML: pre.innerHTML,
        };
      }).catch((err) => {
        window.__renderResult = {
          threw: String(err),
          message: err?.message,
          stack: err?.stack,
        };
      });
    </script>
  </body>
</html>`;

const browser = await chromium.launch();
const page = await browser.newPage();

await page.setContent(html, { waitUntil: 'networkidle' });
await page.waitForFunction(() => globalThis.__renderResult !== null, { timeout: 30000 });
const result = await page.evaluate(() => globalThis.__renderResult);

console.log('Browser render result:', JSON.stringify(result, null, 2));

await browser.close();

if (result.threw || result.hasErrorPanel || result.dataset === 'error' || !result.hasSvg) {
  console.error('\n❌ Reproduction: Mermaid failed to render client-side.');
  throw new Error("test failed");
} else {
  console.log('\n✅ Mermaid rendered successfully in real browser.');
}
