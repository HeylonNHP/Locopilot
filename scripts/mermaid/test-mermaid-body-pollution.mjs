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

const css = `:root { --bg-primary: transparent; --accent: #00a8e8; --text-primary: #1a3a5c; --bg-secondary: rgba(255,255,255,0.15); --text-secondary: #5a7a9a; --font-sans: sans-serif; }`;

const htmlBase = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <style>${css}</style>
  </head>
  <body>
    <div id="target"></div>
    <script type="module">
      ${bundle}

      window.__run = async () => {
        const before = document.body.children.length;
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'language-mermaid';
        code.textContent = 'graph TD\n  A[User] --&gt; B[Locopilot]'; // invalid due to HTML entity in source
        pre.append(code);
        document.getElementById('target').append(pre);

        try {
          await renderMermaidInPre(pre, { mermaidIdBase: 'pollution-test' });
        } catch (e) {
          // ignored
        }

        const after = document.body.children.length;
        const svgsInBody = Array.from(document.querySelectorAll('body > svg')).map(s => s.textContent.slice(0, 60));
        const tempDivs = Array.from(document.body.children).filter(c => c.tagName === 'DIV' && !c.id && !document.getElementById('target').contains(c)).map(d => d.innerHTML.slice(0, 60));
        return {
          before,
          after,
          svgsInBody,
          tempDivs,
          preDataset: pre.dataset.mermaidRendered,
          preInner: pre.innerHTML.slice(0, 200)
        };
      };
    </script>
  </body>
</html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(htmlBase, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof globalThis.__run === 'function');
const result = await page.evaluate(async () => await globalThis.__run());
console.log(JSON.stringify(result, null, 2));
await browser.close();
