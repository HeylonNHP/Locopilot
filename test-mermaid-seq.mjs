import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { readFile } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sources = [
  { name: 'sequence', source: `sequenceDiagram\n    A-\u003e\u003e+B : Hello\n    B--\u003e\u003e-A : Hi` },
  { name: 'class', source: `classDiagram\n    User \u003c|-- Person\n    Person : +String name` },
  { name: 'state', source: `stateDiagram-v2\n    [*] --\u003e Still\n    Still --\u003e [*]` },
  { name: 'er', source: `erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    CUSTOMER {\n        string name\n    }` },
  { name: 'gantt', source: `gantt\n    title A Gantt Diagram\n    dateFormat YYYY-MM-DD\n    section Section\n    A task :a1, 2024-01-01, 30d` },
  { name: 'pie', source: `pie title NETFLIX\n    \"Time spent looking\" : 90\n    \"Time watching\" : 10` },
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
      const out = [];
      for (const { name, source } of ${JSON.stringify(sources)}) {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'language-mermaid';
        code.textContent = source;
        pre.append(code);
        document.getElementById('root').append(pre);
        mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'default', themeVariables: { background: '#fff', primaryColor: '#00a8e8', primaryTextColor: '#000', primaryBorderColor: '#00a8e8', secondaryColor: '#f0f0f0', tertiaryColor: '#f0f0f0', textColor: '#000', noteTextColor: '#000', noteBkgColor: '#f0f0f0', lineColor: '#666', fontFamily: 'sans-serif' }, fontFamily: 'inherit' });
        try {
          const { svg } = await mermaid.render('m-' + name, source);
          out.push({ name, ok: true, svgLen: svg.length, hasErrorText: svg.includes('Syntax error in text') });
        } catch (e) {
          out.push({ name, ok: false, message: e.message });
        }
        pre.remove();
      }
      return out;
    };
  </script>
</body>
</html>`;

async function startServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const filePath = path.join(__dirname, url.pathname === '/' ? 'dist/test-mermaid-seq.html' : url.pathname);
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
  await fs.writeFile(path.join(__dirname, 'dist/test-mermaid-seq.html'), html);
  const port = 3461;
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
