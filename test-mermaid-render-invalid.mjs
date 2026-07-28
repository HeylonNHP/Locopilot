import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { readFile } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cases = [
  { name: 'valid', source: `graph TD\n  A[User] --\u003e B[Locopilot]` },
  { name: 'html entity', source: `graph TD\n  A[User] --\u0026gt; B[Locopilot]` },
  { name: 'with fence', source: `\`\`\`mermaid\ngraph TD\n  A --\u003e B\n\`\`\`` },
  { name: 'bad keyword', source: `grap TD\n  A --\u003e B` },
  { name: 'empty', source: '' },
];

const html = `<!DOCTYPE html>
<html data-theme="light">
<head>
  <meta charset="utf-8">
  <style>:root{--bg-primary:#fff;--accent:#00a8e8;--text-primary:#000;--bg-secondary:#f0f0f0;--text-secondary:#666;--font-sans:sans-serif}</style>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    import mermaid from './node_modules/mermaid/dist/mermaid.esm.mjs';
    window.runTest = async function() {
      const root = document.getElementById('root');
      const out = [];
      for (const { name, source } of ${JSON.stringify(cases)}) {
        try {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'default' });
          const result = await mermaid.render('m-' + name, source);
          out.push({ name, threw: false, svgStart: result.svg.slice(0, 200), hasErrorText: result.svg.includes('Syntax error in text') });
        } catch (e) {
          out.push({ name, threw: true, message: e.message });
        }
      }
      root.textContent = JSON.stringify(out, null, 2);
      return out;
    };
  </script>
</body>
</html>`;

async function startServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const filePath = path.join(__dirname, url.pathname === '/' ? 'dist/test-mermaid-render-inv.html' : url.pathname);
    try {
      const data = await readFile(filePath);
      const ext = path.extname(filePath);
      const ct = ext === '.mjs' ? 'application/javascript' : ext === '.html' ? 'text/html' : 'text/plain';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(data);
    } catch (e) {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

async function main() {
  await fs.mkdir(path.join(__dirname, 'dist'), { recursive: true });
  await fs.writeFile(path.join(__dirname, 'dist/test-mermaid-render-inv.html'), html);
  const port = 3460;
  const server = await startServer(port);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => typeof window.runTest === 'function');
  const logs = await page.evaluate(() => window.runTest());
  console.log(JSON.stringify(logs, null, 2));
  await browser.close();
  server.close();
}

main().catch(e => { console.error(e); process.exit(1); });
