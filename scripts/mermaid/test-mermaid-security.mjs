#!/usr/bin/env node
// ================================================================
//  Mermaid security-level regression test
// ---------------------------------------------------------------
//  Guards the fix for "a ```mermaid fence is an arbitrary-JS sink".
//
//  Root cause: mermaid's `securityLevel` gates its OWN final
//  DOMPurify pass over the serialised SVG —
//    `else if (!isLooseSecurityLevel) code = DOMPurify.sanitize(code, {…})`
//  so `loose` was the only level under which hostile markup survived
//  into the DOM. Under `loose`, `click B href "javascript:…"` left a
//  live href that executed on a real user click, and `click … call fn()`
//  bound a live handler. The renderer now ships `strict`.
//
//  What this test does:
//   1. Bundles the REAL `mermaidRenderer` (not a copy) and drives its
//      public entry point `renderMermaidInPre`, so the shipped config —
//      the securityLevel, themeVariables, htmlLabels:false, the contrast
//      pass and bindFunctions — is what actually gets exercised.
//   2. Asserts hostile payloads do not survive into the DOM, including a
//      real (trusted) mouse click on any anchor that was emitted.
//   3. Asserts the diagram capability that `strict` must NOT cost us:
//      ordinary https:// links are still emitted, and a battery of
//      diagram types still renders.
//
//  Run: npm run test:mermaid-security
// ================================================================

import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const rendererPath = path.join(repoRoot, 'src/components/MarkdownMessage/mermaidRenderer.ts');
const outDir = path.join(__dirname, 'dist', 'security');

// ── Payloads that MUST NOT survive a render ──────────────────

const HOSTILE_CASES = [
  {
    name: 'click directive with a javascript: href',
    source: 'flowchart LR\n  A --> B\n  click B href "javascript:void(window.__pwned=1)"\n',
    forbidden: [/javascript:/i],
  },
  {
    name: 'script tag in a node label',
    source: 'flowchart LR\n  A["<script>window.__pwned=1</script>"] --> B\n',
    forbidden: [/<script/i],
  },
  {
    name: 'img onerror in a node label',
    source: 'flowchart LR\n  A["<img src=x onerror=window.__pwned=1>"] --> B\n',
    forbidden: [/onerror\s*=/i],
  },
  {
    name: 'svg onload in a node label',
    source: 'flowchart LR\n  A["<svg onload=window.__pwned=1>"] --> B\n',
    forbidden: [/onload\s*=/i],
  },
  {
    name: 'iframe srcdoc in a node label',
    source: 'flowchart LR\n  A["<iframe srcdoc=\'<script>window.__pwned=1</script>\'>"] --> B\n',
    forbidden: [/<iframe/i, /srcdoc/i],
  },
  {
    name: 'click directive with a JS callback',
    source: 'flowchart LR\n  A --> B\n  click A call window.__cbFn()\n',
    forbidden: [/onclick\s*=/i],
  },
];

/** Every dangerous construct, checked on every case's output. */
const ALWAYS_FORBIDDEN = [
  { pattern: /javascript:/i, label: 'javascript: URL' },
  { pattern: /<script/i, label: '<script>' },
  {
    pattern: /\son(?:error|load|mouseover|click|focus|mouseenter)\s*=/i,
    label: 'inline event handler',
  },
  { pattern: /srcdoc\s*=/i, label: 'iframe srcdoc' },
];

// ── Diagrams that MUST still render (capability parity) ──────

const PARITY_CASES = {
  'flowchart (subgraph + classDef + linkStyle)': `flowchart TD
    subgraph S1 [Group one]
      A[Start] --> B{Decision}
      B -->|yes| C[(Database)]
      B -->|no| D[[Subroutine]]
    end
    C --> E([End])
    classDef warn fill:#f9a,stroke:#333,stroke-width:2px,color:#000
    class B warn
    linkStyle 1 stroke:#f66,stroke-width:2px`,
  sequence: `sequenceDiagram
    participant A as Alice
    participant B as Bob
    A->>B: Hello
    B-->>A: Hi
    Note over A,B: a note`,
  classDiagram: `classDiagram
    User <|-- Person
    Person : +String name`,
  stateDiagram: `stateDiagram-v2
    [*] --> Still
    Still --> [*]`,
  erDiagram: `erDiagram
    CUSTOMER ||--o{ ORDER : places
    CUSTOMER { string name }`,
  gantt: `gantt
    title A Gantt Diagram
    dateFormat YYYY-MM-DD
    section Section
    A task :a1, 2024-01-01, 30d`,
  pie: `pie title NETFLIX
    "Time spent looking" : 90
    "Time watching" : 10`,
  gitGraph: `gitGraph
    commit
    branch develop
    commit
    checkout main
    commit`,
  mindmap: `mindmap
  root((mindmap))
    Origins
      Long history`,
  timeline: `timeline
    title Timeline
    2020 : Event A`,
  journey: `journey
    title My day
    section Morning
      Wake: 5: Me`,
  'entity escaping in labels': `flowchart LR
    A["a &amp; b <not-a-tag>"] --> B["<b>bold?</b>"]`,
};

/** The feature `loose` was originally chosen for — must keep working. */
const LINK_CASE = {
  source: 'flowchart LR\n  A --> B\n  click B href "https://example.com/docs"\n',
  expected: /https:\/\/example\.com\/docs/,
};

// ── Harness ──────────────────────────────────────────────────

// Imports the REAL renderer so the shipped `mermaid.initialize({...})`
// options are what the assertions run against. A future flip back to
// `loose` therefore turns the hostile-payload cases red immediately.
const HARNESS_ENTRY = `
import { renderMermaidInPre } from '../../../../src/components/MarkdownMessage/mermaidRenderer';

window.__pwned = 0;

window.__runCase = async function (source, id) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.append(code);
  document.body.append(pre);

  let success = false;
  let error = null;
  let threw = null;
  try {
    const result = await renderMermaidInPre(pre, { mermaidIdBase: id });
    success = result.success;
    error = result.success ? null : result.error;
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }

  const anchor = pre.querySelector('a');
  const box = anchor ? anchor.getBoundingClientRect() : null;

  return {
    threw,
    success,
    error,
    html: pre.innerHTML,
    hasSvg: pre.querySelector('svg') !== null,
    anchors: Array.from(pre.querySelectorAll('a')).map(
      (a) => a.getAttribute('href') ?? a.getAttribute('xlink:href')
    ),
    anchorBox:
      box && box.width > 0 && box.height > 0
        ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        : null
  };
};
`;

const HARNESS_HTML = `<!DOCTYPE html>
<html data-theme="light">
<head>
  <meta charset="utf-8">
  <title>mermaid security harness</title>
  <style>
    :root {
      --bg-primary: #f0f8ff;
      --bg-secondary: rgba(255, 255, 255, 0.15);
      --text-primary: #1a3a5c;
      --text-secondary: #5a7a9a;
      --accent: #00a8e8;
      --font-sans: sans-serif;
    }
    body { font-family: sans-serif; padding: 20px; background: #ffffff; color: #111827; }
    svg { max-width: 100%; }
  </style>
</head>
<body>
  <script type="module" src="./harness.mjs"></script>
</body>
</html>`;

async function buildHarness() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'harness.entry.ts'), HARNESS_ENTRY, 'utf8');
  await fs.writeFile(path.join(outDir, 'index.html'), HARNESS_HTML, 'utf8');

  await esbuild.build({
    entryPoints: [path.join(outDir, 'harness.entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: path.join(outDir, 'harness.mjs'),
    absWorkingDir: repoRoot,
    logLevel: 'warning',
  });
}

/** Tiny static server - ES modules cannot be loaded over file:// URLs. */
function serveStatic(directory) {
  return new Promise((resolve) => {
    const server = http.createServer(async (request, response) => {
      const urlPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
      const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const filePath = path.resolve(directory, relative);

      if (!filePath.startsWith(path.resolve(directory))) {
        response.writeHead(403).end('forbidden');
        return;
      }

      try {
        const body = await fs.readFile(filePath);
        const type = filePath.endsWith('.mjs')
          ? 'text/javascript'
          : filePath.endsWith('.html')
            ? 'text/html'
            : 'application/octet-stream';
        response.writeHead(200, { 'content-type': type });
        response.end(body);
      } catch {
        response.writeHead(404).end('not found');
      }
    });

    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ── Runner ───────────────────────────────────────────────────

async function main() {
  const failures = [];

  // 1. Drift guard — the shipped level must be a sanitising one.
  console.log('Checking the shipped security level...');
  const rendererSource = await fs.readFile(rendererPath, 'utf8');
  const shippedLevel = /securityLevel:\s*'([a-z]+)'/.exec(rendererSource)?.[1] ?? null;
  console.log(`  renderer ships securityLevel: '${shippedLevel}'`);
  if (shippedLevel !== 'strict' && shippedLevel !== 'antiscript') {
    failures.push(
      `mermaidRenderer.ts ships securityLevel '${shippedLevel}' — mermaid only skips its ` +
        `final DOMPurify pass at 'loose', so this re-opens the arbitrary-JS sink`
    );
    console.log(`  x expected 'strict' (or 'antiscript'), got '${shippedLevel}'`);
  } else {
    console.log(`  v securityLevel is '${shippedLevel}' (mermaid's final DOMPurify pass runs)`);
  }

  console.log('\nBuilding harness (bundling mermaid + the real mermaidRenderer)...');
  await buildHarness();

  const { server, port } = await serveStatic(outDir);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err.message).slice(0, 160)));

  try {
    await page.addInitScript(() => {
      globalThis.__cbFn = () => {
        globalThis.__pwned = 1;
      };
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => typeof globalThis.__runCase === 'function');

    // 2. Hostile payloads must not survive.
    console.log('\nHostile payloads (must not survive):');
    for (const [index, testCase] of HOSTILE_CASES.entries()) {
      const result = await page.evaluate(
        ([source, id]) => globalThis.__runCase(source, id),
        [testCase.source, `hostile-${index}`]
      );

      const problems = [];
      if (result.threw) problems.push(`renderer threw: ${result.threw}`);
      for (const { pattern, label } of ALWAYS_FORBIDDEN) {
        if (pattern.test(result.html)) problems.push(`output contains ${label}`);
      }
      for (const pattern of testCase.forbidden) {
        if (pattern.test(result.html)) problems.push(`output matches ${pattern}`);
      }
      for (const href of result.anchors) {
        if (href && /javascript:/i.test(href)) problems.push(`live anchor href ${href}`);
      }

      // Real, trusted click on whatever anchor the render emitted.
      let clicked = 'no anchor';
      if (result.anchorBox) {
        await page.evaluate(() => {
          globalThis.__pwned = 0;
        });
        await page.mouse.click(result.anchorBox.x, result.anchorBox.y);
        await page.waitForTimeout(120);
        const pwned = await page.evaluate(() => globalThis.__pwned);
        clicked = `anchor clicked, __pwned=${pwned}`;
        if (pwned !== 0) problems.push('clicking the emitted anchor executed attacker JS');
      }

      if (problems.length > 0) failures.push(`${testCase.name}: ${problems.join('; ')}`);
      console.log(`  ${problems.length === 0 ? 'v' : 'x'} ${testCase.name}`);
      console.log(`    ${clicked}${problems.length > 0 ? ` — ${problems.join('; ')}` : ''}`);
    }

    // 3a. https links must survive (the capability `loose` was chosen for).
    console.log('\nCapability parity:');
    const linkResult = await page.evaluate(
      ([source]) => globalThis.__runCase(source, 'link-case'),
      [LINK_CASE.source]
    );
    const linkKept = LINK_CASE.expected.test(linkResult.html);
    if (!linkKept) failures.push('https:// link was stripped — link support regressed');
    console.log(`  ${linkKept ? 'v' : 'x'} https:// link still emitted`);
    console.log(`    anchors=${JSON.stringify(linkResult.anchors)}`);

    // 3b. Every diagram type must still render.
    let parityOk = 0;
    for (const [name, source] of Object.entries(PARITY_CASES)) {
      const result = await page.evaluate(
        ([src, id]) => globalThis.__runCase(src, id),
        [source, `parity-${name.replaceAll(/[^\da-z]+/gi, '-')}`]
      );
      const ok = !result.threw && result.success && result.hasSvg;
      if (ok) parityOk += 1;
      else {
        failures.push(
          `${name} did not render: threw=${result.threw ?? 'no'} success=${result.success} svg=${result.hasSvg}`
        );
      }
      console.log(
        `  ${ok ? 'v' : 'x'} ${name}${ok ? '' : ` — threw=${result.threw ?? 'no'} success=${result.success} svg=${result.hasSvg}`}`
      );
    }
    console.log(`  ${parityOk}/${Object.keys(PARITY_CASES).length} diagrams rendered`);

    if (pageErrors.length > 0) {
      failures.push(`page errors: ${pageErrors.join(' | ')}`);
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `All ${HOSTILE_CASES.length} hostile-payload cases, the link check and ` +
      `${Object.keys(PARITY_CASES).length} diagram types passed.`
  );
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
