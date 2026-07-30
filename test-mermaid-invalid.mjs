/**
 * Test what error message Mermaid produces for corrupted sources.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

await build({
  entryPoints: ['./src/components/MarkdownMessage/mermaidRenderer.ts'],
  bundle: true,
  format: 'esm',
  outfile: '/tmp/mermaidRenderer.bundle.js',
  target: 'es2022',
});

const bundle = readFileSync('/tmp/mermaidRenderer.bundle.js', 'utf8');

const sources = [
  { name: 'trailing newline', source: `graph TD\n  A[User] --\u003E B[Locopilot]\n` },
  { name: 'leading newline', source: `\ngraph TD\n  A[User] --\u003E B[Locopilot]` },
  { name: 'leading spaces', source: `   graph TD\n  A[User] --\u003E B[Locopilot]` },
  { name: 'CRLF', source: `graph TD\r\n  A[User] --\u003E B[Locopilot]` },
  { name: 'with fence', source: `\`\`\`mermaid\ngraph TD\n  A[User] --\u003E B[Locopilot]\n\`\`\`` },
  { name: 'html entity', source: `graph TD\n  A[User] --\u0026gt; B[Locopilot]` },
];

const css = `:root { --bg-primary: transparent; --accent: #00a8e8; --text-primary: #1a3a5c; --bg-secondary: rgba(255,255,255,0.15); --text-secondary: #5a7a9a; --font-sans: sans-serif; }`;

const htmlBase = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      ${bundle}

      const cases = ${JSON.stringify(sources.map((s, i) => ({ id: i, ...s })))};
      window.__results = [];

      window.__runCases = async () => {
        for (const c of cases) {
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          code.className = 'language-mermaid';
          code.textContent = c.source;
          pre.append(code);
          document.getElementById('root').append(pre);

          try {
            await renderMermaidInPre(pre, { mermaidIdBase: 'case-' + c.id });
            window.__results.push({
              name: c.name,
              dataset: pre.dataset.mermaidRendered,
              hasSvg: !!pre.querySelector('svg'),
              hasErrorPanel: !!pre.querySelector('.mermaid-error-panel'),
              errorMessage: pre.querySelector('.mermaid-error-message')?.textContent ?? null,
              errorDetails: pre.querySelector('.mermaid-error-details pre')?.textContent ?? null,
            });
          } catch (err) {
            window.__results.push({ name: c.name, threw: String(err), message: err?.message });
          }

          pre.remove();
        }
        return window.__results;
      };
    </script>
  </body>
</html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(htmlBase, { waitUntil: 'networkidle' });
const results = await page.evaluate(async () => await globalThis.__runCases());
console.log(JSON.stringify(results, null, 2));
await browser.close();
