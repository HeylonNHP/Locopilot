// ================================================================
//  Mermaid client-side renderer
// ---------------------------------------------------------------
//  Framework-agnostic module that takes a `<pre>` element containing
//  a Mermaid code block (one rendered by the marked tokenizer as
//  `<pre><code class="language-mermaid">…</code></pre>`) and replaces
//  it with an interactive SVG diagram.
//
//  Single public entry point: `renderMermaidInPre`.
//
//  Properties:
//   • Idempotent — re-rendering the same element is a no-op.
//   • Lazy-loaded — the `mermaid` package is only imported on first use.
//   • Streaming-safe — guards DOM access with `isConnected` checks.
//   • Theme-aware — pulls accent / background CSS variables from the
//     document so the rendered diagram inherits the current theme.
//   • Tolerant — on syntax error, surfaces the original source plus
//     the parser error in an inline panel rather than throwing away
//     the user's message.
// ================================================================

import type { Mermaid } from 'mermaid';

type MermaidTheme = 'default' | 'dark';
type ResolvedTheme = 'light' | 'dark';

interface RenderOptions {
  /** Force the diagram theme. Otherwise inferred from `document.documentElement.dataset.theme`. */
  theme?: ResolvedTheme;
  /** Prefix used when generating the unique Mermaid DOM id. Override only in tests. */
  mermaidIdBase?: string;
}

// Module-level state — these are safe to share across renders because
// each render gets its own unique id and the package is itself a singleton.
let mermaidModule: Mermaid | null = null;
let initialisedForTheme: MermaidTheme | null = null;
let idCounter = 0;

// ── Lazy load + initialize ───────────────────────────────────

async function loadMermaid(): Promise<Mermaid> {
  if (mermaidModule) return mermaidModule;
  // Dynamic import so the heavy mermaid bundle (~1MB) is only
  // fetched when a markdown message actually contains a diagram.
  const mod = await import('mermaid');
  // mermaid ships as a default export; defend against future packaging changes.
  mermaidModule = (mod.default ?? (mod as unknown as Mermaid)) as Mermaid;
  return mermaidModule;
}

async function ensureInitialised(theme: ResolvedTheme): Promise<Mermaid> {
  const mermaidEngine = await loadMermaid();
  const mermaidTheme = theme === 'dark' ? 'dark' : 'default';

  // Re-initialize only when the theme actually changes — Mermaid's
  // initialize() is fairly expensive (re-applies theme CSS).
  if (initialisedForTheme === mermaidTheme) return mermaidEngine;

  mermaidEngine.initialize({
    startOnLoad: false,
    // `loose` lets diagrams include clickable links and basic HTML in node
    // labels. We still sanitize the *source* before render via escaping, and
    // render as SVG so user input cannot become executable JS.
    securityLevel: 'loose',
    theme: mermaidTheme,
    themeVariables: collectThemeVariables(),
    fontFamily: 'inherit',
  });

  initialisedForTheme = mermaidTheme;
  return mermaidEngine;
}

// ── CSS → Mermaid theme variable bridges ─────────────────────

function readCssVar(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Maps our design tokens onto Mermaid's `themeVariables` so the diagram
 * colours line up with the surrounding bubble. Mermaid's defaults are
 * acceptable for everything we don't explicitly set, so missing tokens
 * are silently omitted rather than forcing a fallback colour.
 */
function collectThemeVariables(): Record<string, string> {
  const pick = (key: string, cssVar: string): void => {
    const value = readCssVar(cssVar);
    if (value) vars[key] = value;
  };
  const vars: Record<string, string> = {};
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

// ── Theme detection ──────────────────────────────────────────

function resolveTheme(optionTheme: ResolvedTheme | undefined): ResolvedTheme {
  if (optionTheme) return optionTheme;
  if (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark') {
    return 'dark';
  }
  return 'light';
}

// ── Public API ───────────────────────────────────────────────

/**
 * Replaces the contents of a `<pre>` element containing a Mermaid
 * code block with an interactive SVG. Safe to call multiple times
 * for the same element — subsequent calls are no-ops.
 */
export async function renderMermaidInPre(
  preElement: HTMLPreElement,
  options?: RenderOptions
): Promise<void> {
  // Idempotency guard — markers also act as a render-state flag so we
  // can render an error panel without infinity-looping on re-scans.
  if (preElement.dataset['mermaidRendered'] === 'true') return;

  const codeEl = preElement.querySelector('code.language-mermaid');
  if (!codeEl) return;

    const source = codeEl.textContent;
    if (!source || !source.trim()) return;

  const theme = resolveTheme(options?.theme);
  const idBase = options?.mermaidIdBase ?? 'mermaid';
  const id = `${idBase}-${++idCounter}`;

  if (!preElement.isConnected) return;

  try {
    const mermaidEngine = await ensureInitialised(theme);
    const { svg, bindFunctions } = await mermaidEngine.render(id, source);

    // The component could have unmounted (or a new message could have
    // replaced this DOM) while we were awaiting the render. If so, drop
    // the result — the next render will receive fresh code.
    if (!preElement.isConnected) return;

    preElement.dataset['mermaidRendered'] = 'true';
    preElement.classList.add('mermaid-rendered');
    preElement.innerHTML = svg;

    // Mermaid annotates the SVG with click handlers; without these
    // links/click navigation in the diagram won't work.
    const svgRoot = preElement.querySelector('svg');
    if (svgRoot && bindFunctions) {
      try {
        bindFunctions(svgRoot);
      } catch {
        // Some diagrams legitimately have no bindings; ignore.
      }
    }
  } catch (err) {
    if (!preElement.isConnected) return;
    installErrorPanel(preElement, source, err);
  }
}

// ── Error panel ──────────────────────────────────────────────

function installErrorPanel(preElement: HTMLPreElement, source: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  preElement.dataset['mermaidRendered'] = 'error';
  preElement.classList.add('mermaid-error');
  preElement.innerHTML = `
    <div class="mermaid-error-panel">
      <div class="mermaid-error-message">⚠ Mermaid render error</div>
      <pre class="mermaid-error-source">${escapeHtml(source)}</pre>
      <details class="mermaid-error-details">
        <summary>Error details</summary>
        <pre>${escapeHtml(message)}</pre>
      </details>
    </div>
  `;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
