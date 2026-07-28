import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { readFile } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const diagram = `graph TD
  A[User] --> B[Locopilot]
  B --> C[Render Mermaid]
  C --> D[Validated Chart]`;

const html = `<!DOCTYPE html>
<html data-theme="light">
<head>
  <meta charset="utf-8">
  <style>
    :root {
      --bg-primary: #ffffff;
      --bg-secondary: #f1f5f9;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --accent: #00a8e8;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    [data-theme="dark"] {
      --bg-primary: #111827;
      --bg-secondary: #1f2937;
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --accent: #38bdf8;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    body { font-family: var(--font-sans); padding: 20px; background: var(--bg-primary); color: var(--text-primary); }
  </style>
</head>
<body>
  <pre id="target"><code class="language-mermaid"></code></pre>
  <div id="log"></div>
  <script type="module">
    import mermaid from './node_modules/mermaid/dist/mermaid.esm.mjs';
    window.mermaid = mermaid;
    window.runTest = async function(source) {
      const code = document.querySelector('#target code');
      code.textContent = source;
      const themeVars = collectThemeVariables();
      const log = [];
      log.push('themeVars=' + JSON.stringify(themeVars));
      
      try {
        await mermaid.parse(source);
        log.push('parse default: OK');
      } catch (e) {
        log.push('parse default: ' + e.message);
      }
      
      try {
        await mermaid.parse(source, { themeVariables: themeVars, securityLevel: 'loose' });
        log.push('parse client: OK');
      } catch (e) {
        log.push('parse client: ' + e.message);
      }
      
      mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'default', themeVariables: themeVars, fontFamily: 'inherit' });
      try {
        const { svg } = await mermaid.render('m-1', source);
        log.push('render client: OK, svg length=' + svg.length);
      } catch (e) {
        log.push('render client: ' + e.message);
      }
      
      mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'default' });
      try {
        const { svg } = await mermaid.render('m-2', source);
        log.push('render minimal: OK, svg length=' + svg.length);
      } catch (e) {
        log.push('render minimal: ' + e.message);
      }
      
      document.getElementById('log').innerHTML = log.map(l => '\u003cdiv\u003e' + l + '\u003c/div\u003e').join('');
      return log;
    };
    
    function readCssVar(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }
    function collectThemeVariables() {
      const vars = {};
      const pick = (key, cssVar) => { const v = readCssVar(cssVar); if (v) vars[key] = v; };
      pick('background', '--bg-primary');
      pick('primaryColor', '--accent');
      pick('primaryTextColor', '--text-primary');
      pick('primaryBorderColor', '--accent');
      pick('secondaryColor', '--bg-secondary');
      pick('tertiaryColor', '--bg-secondary');
      pick('textColor', '--text-primary');
      pick('noteTextColor', '--text-primary');
      pick('noteBkgColor', '--bg-secondary');
      pick('lineColor', '--text-secondary');
      pick('fontFamily', '--font-sans');
      return vars;
    }
  </script>
</body>
</html>`;

async function startServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const filePath = path.join(__dirname, url.pathname === '/' ? 'dist/test-mermaid-config.html' : url.pathname);
    try {
      const data = await readFile(filePath);
      const ext = path.extname(filePath);
      const ct = ext === '.mjs' ? 'application/javascript' : ext === '.html' ? 'text/html' : 'text/plain';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(data);
    } catch (e) {
      res.writeHead(404);
      res.end('Not found: ' + filePath + '\n' + e.message);
    }
  });
  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

async function main() {
  await fs.mkdir(path.join(__dirname, 'dist'), { recursive: true });
  await fs.writeFile(path.join(__dirname, 'dist/test-mermaid-config.html'), html);
  const port = 3457;
  const server = await startServer(port);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => typeof window.runTest === 'function');
  const logs = await page.evaluate(async (src) => window.runTest(src), diagram);
  console.log(logs.join('\n'));
  await browser.close();
  server.close();
}

main().catch(e => { console.error(e); process.exit(1); });
