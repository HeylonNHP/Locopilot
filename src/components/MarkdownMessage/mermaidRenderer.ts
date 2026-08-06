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

export interface MermaidRenderSuccess {
  success: true;
}

export interface MermaidRenderFailure {
  success: false;
  error: string;
}

export type MermaidRenderResult = MermaidRenderSuccess | MermaidRenderFailure;

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
    markdownAutoWrap: true,
    htmlLabels: false,
    flowchart: {
      wrappingWidth: 140,
    },
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

// ── Error helpers ────────────────────────────────────────────

const ERROR_SVG_MARKERS = [
  'syntax error in text',
  'class="error"',
  "class='error'",
  'id="error"',
  "id='error'",
];

function looksLikeErrorSvg(svg: string): boolean {
  const lowerSvg = svg.toLowerCase();
  return ERROR_SVG_MARKERS.some((marker) => lowerSvg.includes(marker));
}

/**
 * Escape HTML-special characters so raw source can be safely injected into
 * the DOM.
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/**
 * Prefix each source line with a right-aligned line number and a `│` separator.
 * The source is HTML-escaped before numbering so the result is safe to insert
 * as innerHTML. Line numbers and the separator are wrapped in spans so they
 * can be styled with a muted colour.
 */
export function formatSourceWithLineNumbers(source: string): string {
  const lines = source.split('\n');
  const lastLine = lines.at(-1);
  const hasTrailingEmpty = lines.length > 1 && lastLine === '';
  const numberedLineCount = hasTrailingEmpty ? lines.length - 1 : lines.length;
  const numberWidth = String(numberedLineCount).length;

  return lines
    .map((line, index) => {
      // Preserve a trailing empty line caused by a final newline, but don't
      // assign it a line number.
      if (hasTrailingEmpty && index === lines.length - 1) {
        return escapeHtml(line);
      }
      const number = String(index + 1).padStart(numberWidth, ' ');
      const numberSpan = `<span class="mermaid-error-line-number">${number}</span>`;
      const separatorSpan = `<span class="mermaid-error-line-separator">│</span>`;
      return `${numberSpan}${separatorSpan} ${escapeHtml(line)}`;
    })
    .join('\n');
}

// ── Public API ───────────────────────────────────────────────

/**
 * Replaces the contents of a `<pre>` element containing a Mermaid
 * code block with an interactive SVG. Safe to call multiple times
 * for the same element — subsequent calls are no-ops.
 *
 * Returns a structured result so callers can decide whether to render
 * their own fallback UI for syntax/render errors.
 */
export async function renderMermaidInPre(
  preElement: HTMLPreElement,
  options?: RenderOptions
): Promise<MermaidRenderResult> {
  // Idempotency guard — markers also act as a render-state flag so we
  // can render an error panel without infinity-looping on re-scans.
  if (preElement.dataset['mermaidRendered'] === 'true') {
    return { success: true };
  }

  const codeEl = preElement.querySelector('code.language-mermaid');
  if (!codeEl) return { success: true };

  const source = codeEl.textContent;
  if (!source || !source.trim()) return { success: true };

  const theme = resolveTheme(options?.theme);
  const idBase = options?.mermaidIdBase ?? 'mermaid';
  const id = `${idBase}-${++idCounter}`;

  if (!preElement.isConnected) return { success: true };

  try {
    const mermaidEngine = await ensureInitialised(theme);

    // Mermaid v11 returns `false` instead of throwing when suppressErrors is
    // true. Detect bad syntax up front so we never draw the generic
    // "Syntax error in text" placeholder SVG.
    const parseResult = await mermaidEngine.parse(source, { suppressErrors: true });
    if (parseResult === false) {
      let detailMessage = 'Mermaid syntax error: the diagram source could not be parsed.';
      try {
        await mermaidEngine.parse(source);
      } catch (parseErr) {
        detailMessage = parseErr instanceof Error ? parseErr.message : String(parseErr);
      }
      if (preElement.isConnected) {
        installErrorPanel(preElement, source, detailMessage);
      }
      return {
        success: false,
        error: 'Mermaid syntax error: the diagram source could not be parsed.',
      };
    }

    const { svg, bindFunctions } = await mermaidEngine.render(id, source);

    // The component could have unmounted (or a new message could have
    // replaced this DOM) while we were awaiting the render. If so, drop
    // the result — the next render will receive fresh code.
    if (!preElement.isConnected) return { success: true };

    if (looksLikeErrorSvg(svg)) {
      installErrorPanel(preElement, source, 'Mermaid rendered an error SVG.');
      return { success: false, error: 'Mermaid rendered an error SVG.' };
    }

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

    return { success: true };
  } catch (err) {
    if (!preElement.isConnected) return { success: true };
    const message = err instanceof Error ? err.message : String(err);
    installErrorPanel(preElement, source, message);
    return { success: false, error: message };
  }
}

// ── Error panel ──────────────────────────────────────────────

function installErrorPanel(preElement: HTMLPreElement, source: string, errMessage: string): void {
  preElement.dataset['mermaidRendered'] = 'error';
  preElement.classList.add('mermaid-error');
  preElement.innerHTML = `
    <div class="mermaid-error-panel">
      <div class="mermaid-error-header">
        <span class="mermaid-error-icon" aria-hidden="true">⚠</span>
        <span class="mermaid-error-title">Unable to render diagram</span>
        <button class="mermaid-error-copy-btn" type="button" aria-label="Copy diagram source">Copy</button>
      </div>
      <div class="mermaid-error-body">
        <p class="mermaid-error-summary">The Mermaid source contains a syntax or rendering error.</p>
        <div class="mermaid-error-source-wrapper">
          <pre class="mermaid-error-source"><code>${formatSourceWithLineNumbers(source)}</code></pre>
        </div>
        <details class="mermaid-error-details">
          <summary>Technical details</summary>
          <pre>${escapeHtml(errMessage)}</pre>
        </details>
      </div>
    </div>
  `;

  const panel = preElement.querySelector('.mermaid-error-panel');
  if (panel) attachCopyButton(panel, source);
}

function attachCopyButton(panel: Element, source: string): void {
  const button = panel.querySelector('.mermaid-error-copy-btn');
  if (!button || !(button instanceof HTMLButtonElement)) return;

  button.addEventListener('click', () => {
    const fallbackCopy = () => {
      const textarea = document.createElement('textarea');
      textarea.value = source;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } catch {
        // silently fail
      }
      textarea.remove();
    };

    if (navigator.clipboard) {
      navigator.clipboard.writeText(source).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }

    button.textContent = 'Copied!';
    button.classList.add('mermaid-error-copy-btn--copied');
    setTimeout(() => {
      button.textContent = 'Copy';
      button.classList.remove('mermaid-error-copy-btn--copied');
    }, 1500);
  });
}
