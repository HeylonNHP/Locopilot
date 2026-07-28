import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { readFile } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const html = `<!DOCTYPE html>
<html data-theme="light">
<head>
  <meta charset="utf-8">
  <style>:root{--bg-primary:#fff;--accent:#00a8e8;--text-primary:#000;--bg-secondary:#f0f0f0;--text-secondary:#666;--font-sans:sans-serif}</style>
</head>
<body>
  <div id="target"></div>
  <script type="module">
    import mermaid from './node_modules/mermaid/dist/mermaid.esm.mjs';
    window.__run = async () => {
      const before = document.body.children.length;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = 'graph TD\n  A[User] --&gt; B[Locopilot]'; // invalid HTML entity source
      pre.append(code);
      document.getElementById('target').append(pre);

      mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'default' });
      try {
        await mermaid.render('pollution-test', code.textContent);
      } catch (e) {
        // ignored, like the renderer does
      }

      const after = document.body.children.length;
      const svgsInBody = Array.from(document.querySelectorAll('body > svg')).map(s => s.textContent.slice(0, 80));
      const tempDivs = Array.from(document.body.children).filter(c => c.tagName === 'DIV' && c.id !== 'target' && !document.getElementById('target').contains(c)).map(d => ({ id: d.id, cls: d.className, html: d.innerHTML.slice(0, 80) }));
      return { before, after, svgsInBody, tempDivs, bodyText: document.body.innerText.slice(0, 200) };
    };
  </script>
</body>
</html>`;

async function startServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const filePath = path.join(__dirname, url.pathname === '/' ? 'dist/test-mermaid-pollution.html' : url.pathname);
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
  await fs.writeFile(path.join(__dirname, 'dist/test-mermaid-pollution.html'), html);
  const port = 3462;
  const server = await startServer(port);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => typeof window.__run === 'function');
  const result = await page.evaluate(() => window.__run());
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  server.close();
}

main().catch(e => { console.error(e); process.exit(1); });
