import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const diagram = `graph TD
  A[User] --> B[Locopilot]
  B --> C[Render Mermaid]
  C --> D[Validated Chart]`;

const pageHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root {
      --bg-primary: #ffffff;
      --accent: #00a8e8;
    }
    [data-theme="dark"] {
      --bg-primary: #111827;
      --accent: #38bdf8;
    }
    body { font-family: system-ui, sans-serif; padding: 20px; }
    pre { border: 1px solid #ccc; padding: 10px; background: #f8f8f8; }
    .error-panel { color: red; border: 2px solid red; padding: 10px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    ${await fs.readFile(path.join(__dirname, 'dist/mermaidRenderer.mjs'), 'utf8')}
  </script>
</body>
</html>`;

async function build() {
  // Bundle renderer module for browser
  const src = await fs.readFile(path.join(__dirname, 'src/components/MarkdownMessage/mermaidRenderer.ts'), 'utf8');
  const out = src
    .replace(/export /g, '')
    .replace(/interface /g, 'var ')
    .replace(/:\s*(RenderOptions|string|void|Promise<void>|HTMLElement|HTMLPreElement|boolean)\b/g, '')
    .replace(/:\s*Promise<void>/g, '')
    .replace(/<[^>]+>/g, '');
  await fs.writeFile(path.join(__dirname, 'dist/mermaidRenderer.mjs'), out);
}

async function main() {
  await fs.mkdir(path.join(__dirname, 'dist'), { recursive: true });
  await build();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const filePath = path.join(__dirname, 'dist/test-mermaid-full.html');
  await fs.writeFile(filePath, pageHtml);
  await page.goto('file://' + filePath);
  await page.evaluate(async (diagramText) => {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-mermaid';
    code.textContent = diagramText;
    pre.appendChild(code);
    document.getElementById('root').appendChild(pre);
    await window.renderMermaidInPre(pre);
  }, diagram);
  await page.waitForTimeout(1000);
  const result = await page.evaluate(() => {
    const pre = document.querySelector('pre');
    return {
      rendered: pre?.dataset?.mermaidRendered,
      html: pre?.outerHTML?.slice(0, 500),
      svg: !!pre?.querySelector('svg'),
      error: pre?.querySelector('.mermaid-error-panel')?.textContent || null,
    };
  });
  console.log('Result:', result);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
