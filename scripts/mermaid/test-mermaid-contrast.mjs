#!/usr/bin/env node
// ================================================================
//  Mermaid label contrast regression test
// ---------------------------------------------------------------
//  Bundles the real `ensureReadableText` module together with mermaid,
//  renders diagrams in headless Chromium under token sets that
//  reproduce the reported failure (a light `classDef` fill inheriting a
//  light theme text colour), and asserts the resulting label contrast.
//
//  Run: node scripts/mermaid/test-mermaid-contrast.mjs
//
//  The contrast maths below is deliberately a second, independent
//  implementation of WCAG 2.1 - it does not import the module under
//  test, so a bug in the module cannot mask itself here.
// ================================================================

import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(__dirname, 'dist', 'contrast');

const MIN_RATIO = 4.5;

// Token sets mirroring the app's two themes.
// See src/app/styles/_theme-colors.scss
const LIGHT_TOKENS = {
  bgPrimary: '#f0f8ff',
  bgSecondary: 'rgba(255,255,255,0.15)',
  textPrimary: '#1a3a5c',
  textSecondary: '#5a7a9a',
  accent: '#00a8e8',
  fontSans: 'sans-serif',
};

const DARK_TOKENS = {
  bgPrimary: '#0c1422',
  bgSecondary: 'rgba(255,255,255,0.07)',
  textPrimary: '#e6edf6',
  textSecondary: '#9fb0c6',
  accent: '#38bdf8',
  fontSans: 'sans-serif',
};

/** Mirrors collectThemeVariables() in mermaidRenderer.ts. */
function themeVariables(tokens) {
  return {
    background: tokens.bgPrimary,
    primaryColor: tokens.accent,
    primaryTextColor: tokens.textPrimary,
    primaryBorderColor: tokens.accent,
    secondaryColor: tokens.bgSecondary,
    tertiaryColor: tokens.bgSecondary,
    textColor: tokens.textPrimary,
    lineColor: tokens.textSecondary,
    fontFamily: tokens.fontSans,
  };
}

const CASES = [
  {
    name: 'pale fill, no label colour (reported bug)',
    // Dark tokens => near-white primaryTextColor. The pale fill has no
    // `color:`, so the label used to inherit near-white text.
    tokens: DARK_TOKENS,
    baselineShouldFail: true,
    source: [
      'flowchart TD',
      '  A["Pale fill, no label colour"]',
      '  classDef pale fill:#e8f1ff,stroke:#e8f1ff,stroke-width:2px',
      '  class A pale',
    ].join('\n'),
    check: (entry) => {
      const label = parseColour(entry.labelFill);
      return {
        ok: label !== null && relativeLuminance(label) < 0.5,
        detail: `label darkened to ${entry.labelFill}`,
      };
    },
  },
  {
    name: 'dark fill + explicit white label (intent preserved)',
    tokens: LIGHT_TOKENS,
    source: [
      'flowchart TD',
      '  A["Dark fill, explicit white label"]',
      '  classDef dark fill:#1e3a5f,stroke:#1e3a5f,stroke-width:2px,color:#ffffff',
      '  class A dark',
    ].join('\n'),
    check: (entry) => ({
      ok: /rgb\(255,\s*255,\s*255\)/.test(entry.labelFill),
      detail: `label left untouched at ${entry.labelFill}`,
    }),
  },
  {
    name: 'mid-tone fill gets a contrasting outline',
    tokens: LIGHT_TOKENS,
    baselineShouldFail: true,
    source: [
      'flowchart TD',
      '  A["Mid-tone fill"]',
      '  classDef mid fill:#808080,stroke:#808080,stroke-width:2px,color:#808080',
      '  class A mid',
    ].join('\n'),
    check: (entry) => ({
      ok: hasVisibleOutline(entry),
      detail: `outline ${entry.outlineWidth} ${entry.outlineColour}, paint-order=${entry.outlinePaintOrder}`,
    }),
  },
  {
    name: 'user-chosen readable colours are not overridden',
    tokens: LIGHT_TOKENS,
    source: [
      'flowchart TD',
      '  A["Keep my colours"]',
      '  classDef mine fill:#065f46,stroke:#065f46,stroke-width:2px,color:#d1fae5',
      '  class A mine',
    ].join('\n'),
    check: (entry) => ({
      ok: /rgb\(209,\s*250,\s*229\)/.test(entry.labelFill) && !hasVisibleOutline(entry),
      detail: `label left untouched at ${entry.labelFill}`,
    }),
  },
  {
    name: 'fill:none is skipped without error',
    tokens: DARK_TOKENS,
    source: [
      'flowchart TD',
      '  A["Transparent fill"]',
      '  classDef blank fill:none,stroke:#333333',
      '  class A blank',
    ].join('\n'),
    check: (entry) => ({
      ok: entry.labelFill.length > 0,
      detail: `no error, label unchanged at ${entry.labelFill}`,
    }),
  },
];

// ── Independent WCAG 2.1 maths ───────────────────────────────

function parseColour(value) {
  const trimmed = String(value).trim();

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(trimmed);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };

  const hex = /^#([\da-f]{6})$/i.exec(trimmed);
  if (hex) {
    const digits = hex[1];
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
    };
  }

  return null;
}

function channelLuminance(channel) {
  const scaled = channel / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }) {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function contrastRatio(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function hasVisibleOutline(entry) {
  const width = Number.parseFloat(entry.outlineWidth ?? '0');
  return width > 0 && entry.outlinePaintOrder === 'stroke' && entry.outlineColour !== 'none';
}

/**
 * The contract: the glyphs read against whatever is immediately behind them.
 *
 * - Solid text: the backdrop is the shape fill.
 * - Outlined text: the halo is the immediate backdrop, so what matters is the
 *   glyph against the halo, not the halo against the shape. This is what makes
 *   genuinely mid-tone fills (where neither white nor black reaches 4.5:1)
 *   legible.
 */
function isReadable(entry, shapeFill) {
  const shape = parseColour(shapeFill);
  // Unmeasurable backdrop (`fill: none`, a gradient) - we cannot judge it.
  if (!shape) return { ok: true, ratio: null, mode: 'unmeasured' };

  const label = parseColour(entry.labelFill);
  const textRatio = label ? contrastRatio(label, shape) : 0;
  if (textRatio >= MIN_RATIO) return { ok: true, ratio: textRatio, mode: 'text' };

  if (hasVisibleOutline(entry)) {
    const outline = parseColour(entry.outlineColour);
    const haloRatio = outline && label ? contrastRatio(label, outline) : 0;
    if (haloRatio >= MIN_RATIO) return { ok: true, ratio: haloRatio, mode: 'outline' };
  }

  return { ok: false, ratio: textRatio, mode: 'none' };
}

// ── Harness ──────────────────────────────────────────────────

// Written to disk then bundled so the test exercises the REAL module,
// including its real import graph, rather than a copy.
const HARNESS_ENTRY = `
import mermaid from 'mermaid';
import { ensureReadableText } from '../../../../src/components/MarkdownMessage/mermaidContrast';

let counter = 0;

window.runContrastTest = async function (source, themeVars, applyFix) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'default',
    themeVariables: themeVars,
    fontFamily: 'inherit',
    markdownAutoWrap: true,
    htmlLabels: false,
    flowchart: { wrappingWidth: 140 }
  });

  counter += 1;
  const rendered = await mermaid.render('contrast-' + counter, source);

  const pre = document.getElementById('target');
  pre.innerHTML = rendered.svg;
  const svgRoot = pre.querySelector('svg');

  if (applyFix) ensureReadableText(svgRoot);

  const report = [];
  const nodes = svgRoot.querySelectorAll('g.node');
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const shape = node.querySelector(':scope > .label-container')
      || node.querySelector('rect, polygon, path, circle, ellipse');
    const label = node.querySelector('text');
    if (!shape || !label) continue;

    const labelStyle = getComputedStyle(label);
    report.push({
      nodeId: node.id,
      shapeFill: getComputedStyle(shape).fill,
      labelFill: labelStyle.fill,
      outlineWidth: labelStyle.strokeWidth,
      outlineColour: labelStyle.stroke,
      outlinePaintOrder: labelStyle.paintOrder
    });
  }

  return report;
};
`;

const HARNESS_HTML = `<!DOCTYPE html>
<html data-theme="light">
<head>
  <meta charset="utf-8">
  <title>mermaid contrast harness</title>
  <style>
    body { font-family: sans-serif; padding: 20px; background: #ffffff; color: #111827; }
    svg { max-width: 100%; }
  </style>
</head>
<body>
  <pre id="target"></pre>
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
  console.log('Building harness (bundling mermaid + mermaidContrast)...');
  await buildHarness();

  const { server, port } = await serveStatic(outDir);
  const browser = await chromium.launch({ headless: true });

  const failures = [];

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForFunction(() => typeof globalThis.runContrastTest === 'function', null, {
      timeout: 30_000,
    });

    for (const testCase of CASES) {
      const vars = themeVariables(testCase.tokens);

      if (testCase.baselineShouldFail) {
        const baseline = await page.evaluate(
          ([source, themeVars]) => globalThis.runContrastTest(source, themeVars, false),
          [testCase.source, vars]
        );
        const entry = baseline[0];
        const result = isReadable(entry, entry?.shapeFill ?? 'none');

        if (result.ok) {
          console.log(`  ! ${testCase.name}`);
          console.log('    baseline was already readable - this case no longer reproduces');
        } else {
          console.log(`  ~ ${testCase.name}`);
          console.log(
            `    baseline contrast ${result.ratio?.toFixed(2)}:1 (below ${MIN_RATIO}:1) - bug reproduced`
          );
        }
      }

      const report = await page.evaluate(
        ([source, themeVars]) => globalThis.runContrastTest(source, themeVars, true),
        [testCase.source, vars]
      );

      const entry = report[0];
      if (!entry) {
        failures.push(`${testCase.name}: no node was rendered`);
        console.log(`  x ${testCase.name}\n    no node was rendered`);
        continue;
      }

      const readability = isReadable(entry, entry.shapeFill);
      const specific = testCase.check(entry);
      const ok = readability.ok && specific.ok;

      if (!ok) {
        failures.push(`${testCase.name}: ${specific.detail}`);
      }

      const ratioLabel = readability.ratio === null ? 'n/a' : `${readability.ratio.toFixed(2)}:1`;
      console.log(`  ${ok ? 'v' : 'x'} ${testCase.name}`);
      console.log(`    contrast ${ratioLabel} via ${readability.mode} - ${specific.detail}`);
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

  console.log(`All ${CASES.length} contrast cases passed.`);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
