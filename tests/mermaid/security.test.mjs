/**
 * Mermaid security-level regression test.
 *
 * Guards the fix for "a ```mermaid fence is an arbitrary-JS sink".
 *
 * Root cause: mermaid's `securityLevel` gates its OWN final DOMPurify pass over
 * the serialised SVG —
 *   `else if (!isLooseSecurityLevel) code = DOMPurify.sanitize(code, {…})`
 * so `loose` was the only level under which hostile markup survived into the
 * DOM. Under `loose`, `click B href "javascript:…"` left a live href that
 * executed on a real user click, and `click … call fn()` bound a live handler.
 * The renderer now ships `strict`.
 *
 * What this test does:
 *  1. Bundles the REAL `mermaidRenderer` (not a copy) and drives its public
 *     entry point `renderMermaidInPre`, so the shipped config — the
 *     securityLevel, themeVariables, htmlLabels:false, the contrast pass and
 *     bindFunctions — is what actually gets exercised.
 *  2. Asserts hostile payloads do not survive into the DOM, including a real
 *     (trusted) mouse click on any anchor that was emitted.
 *  3. Asserts the diagram capability that `strict` must NOT cost us: ordinary
 *     https:// links are still emitted, and a battery of diagram types still
 *     renders.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { buildHarness, repoRoot, serveStatic } from '../helpers/browserHarness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererPath = path.join(repoRoot, 'src/components/MarkdownMessage/mermaidRenderer.ts');
const outDir = path.join(here, 'dist', 'security');

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

describe('the shipped security level', () => {
  test("is one that sanitises (mermaid only skips its final DOMPurify pass at 'loose')", async () => {
    const rendererSource = await fs.readFile(rendererPath, 'utf8');
    const shippedLevel = /securityLevel:\s*'([a-z]+)'/.exec(rendererSource)?.[1] ?? null;
    // `loose` would re-open the arbitrary-JS sink
    expect(['strict', 'antiscript']).toContain(shippedLevel);
  });
});

describe('the real mermaid renderer (in Chromium)', () => {
  let server;
  let browser;
  let page;
  const pageErrors = [];

  beforeAll(async () => {
    await buildHarness({ outDir, entry: HARNESS_ENTRY, html: HARNESS_HTML });
    let port;
    ({ server, port } = await serveStatic(outDir));
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err.message).slice(0, 160)));
    await page.addInitScript(() => {
      globalThis.__cbFn = () => {
        globalThis.__pwned = 1;
      };
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => typeof globalThis.__runCase === 'function');
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  /** Renders `source` through the real renderer, in the page. */
  const runCase = (source, id) =>
    page.evaluate(([src, caseId]) => globalThis.__runCase(src, caseId), [source, id]);

  describe('hostile payloads must not survive', () => {
    test.each(HOSTILE_CASES.map((testCase, index) => ({ ...testCase, index })))(
      '$name',
      async ({ source, forbidden, index }) => {
        const result = await runCase(source, `hostile-${index}`);

        const problems = [];
        if (result.threw) problems.push(`renderer threw: ${result.threw}`);
        for (const { pattern, label } of ALWAYS_FORBIDDEN) {
          if (pattern.test(result.html)) problems.push(`output contains ${label}`);
        }
        for (const pattern of forbidden) {
          if (pattern.test(result.html)) problems.push(`output matches ${pattern}`);
        }
        for (const href of result.anchors) {
          if (href && /javascript:/i.test(href)) problems.push(`live anchor href ${href}`);
        }

        // A real, trusted click on whatever anchor the render emitted.
        if (result.anchorBox) {
          await page.evaluate(() => {
            globalThis.__pwned = 0;
          });
          await page.mouse.click(result.anchorBox.x, result.anchorBox.y);
          await page.waitForTimeout(120);
          const pwned = await page.evaluate(() => globalThis.__pwned);
          if (pwned !== 0) problems.push('clicking the emitted anchor executed attacker JS');
        }

        expect(problems).toStrictEqual([]);
      }
    );
  });

  describe('capability parity (what `strict` must not cost us)', () => {
    test('an https:// link is still emitted', async () => {
      const result = await runCase(LINK_CASE.source, 'link-case');
      // the link support has not regressed
      expect(result.html).toMatch(LINK_CASE.expected);
    });

    test.each(Object.entries(PARITY_CASES))('renders a %s', async (name, source) => {
      const result = await runCase(source, `parity-${name.replaceAll(/[^\da-z]+/gi, '-')}`);
      expect({ threw: result.threw, success: result.success, hasSvg: result.hasSvg }).toStrictEqual(
        {
          threw: null,
          success: true,
          hasSvg: true,
        }
      );
    });
  });

  test('raised no page errors', () => {
    expect(pageErrors).toStrictEqual([]);
  });
});
