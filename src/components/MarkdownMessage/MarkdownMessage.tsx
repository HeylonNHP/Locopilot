'use client';
import DOMPurify from 'isomorphic-dompurify';
import { marked } from 'marked';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatSourceWithLineNumbers, renderMermaidInPre } from './mermaidRenderer';

import './MarkdownMessage.scss';

interface Props {
  source: string;
  className?: string;
}

// Ensure all anchor tags open safely in a new tab.
// Guard against SSR environments where DOMPurify initialization may not be complete.
let hookRegistered = false;
function registerHook() {
  if (hookRegistered || typeof DOMPurify.addHook !== 'function') return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noreferrer noopener');
    }
  });
  hookRegistered = true;
}

// Allowed tags / attributes for sanitized markdown HTML.
const ALLOWED_TAGS = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];

const ALLOWED_ATTR = [
  'href',
  'target',
  'rel',
  'src',
  'alt',
  'title',
  'width',
  'height',
  'colspan',
  'rowspan',
  'scope',
  'align',
  'class',
  'id',
];

function renderMarkdownHtml(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return '';
  }

  // Register the anchor hook once (lazy, SSR-safe).
  registerHook();

  const rawHtml = marked.parse(trimmed, { breaks: true, gfm: true }) as string;

  // Sanitize to allow safe HTML (links, code blocks, tables, etc.)
  // while stripping <script>, event handlers, and other XSS vectors.
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}

// ────────────────────────────────────────────────────────────────
//  Streaming-aware split
// ────────────────────────────────────────────────────────────────
//
// The markdown message is being streamed token-by-token. The model
// often emits 50–200+ tokens of trailing prose AFTER a closed
// ```mermaid``` fence.
//
// If we re-apply `dangerouslySetInnerHTML` to the whole container on
// every token, we *destroy* anything injected imperatively into the
// DOM after the initial render — most importantly, the Mermaid SVG
// that replaced each `pre > code.language-mermaid`.
//
// The fix is to:
//   1. Split the source into a "frozen" prefix (everything up to
//      the first *unclosed* code fence) and a "streaming tail"
//      (everything from that opening fence onward). The frozen
//      prefix only changes when a new code block closes; the tail
//      updates per token without touching the frozen DOM.
//   2. Within the frozen prefix, further split out each closed
//      Mermaid block and render it as its own React-managed
//      `<MermaidBlock source={...} />` element keyed by the Mermaid
//      source string. That element owns its own Mermaid render
//      lifecycle and is never replaced by `dangerouslySetInnerHTML`
//      in the surrounding prose.
//
// This means the SVG only ever mounts once per Mermaid block (when
// its closing fence arrives), and from that point on it is
// completely immune to subsequent streaming tokens.
//
// The pattern is the same one used by production streaming markdown
// renderers (react-markdown + streamdown, etc.).

/**
 * Find the index in `source` where the *streaming tail* starts.
 *
 * The streaming tail is everything from the first *unclosed* code
 * fence onward. Everything before that is "frozen" — it is safe to
 * render as HTML because no token will ever append into it.
 *
 * Returns `source.length` if there is no unclosed fence (i.e. the
 * entire message is "frozen" and there is no tail) and `0` if the
 * very first character of the message is the start of an unclosed
 * fence (i.e. there is no frozen prefix).
 *
 * Recognises ` ``` ` (3+ backticks) and ` ~~~ ` fences, with optional
 * leading language word such as `mermaid`, `js`, etc. The opening
 * fence is ` ``` ` and the matching closing fence is the next ` ``` `
 * on its own line with the same length.
 */
function findStreamingTailStart(source: string): number {
  const fence = /^[\t ]*(`{3,}|~{3,})[^\n]*$/gm;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(source)) !== null) {
    const opener = match[1] ?? '';
    const openerChar = opener[0];
    const openerLen = opener.length;
    // [^\n]*$ matches the line up to (but not including) the newline,
    // so the next line starts at match.index + match[0].length + 1.
    const afterOpenLine = match.index + match[0].length + 1;
    const closeRe = new RegExp(
      `^[ \\t]*${openerChar === '`' ? '`' : '~'}{${openerLen},}[ \\t]*$`,
      'gm'
    );
    closeRe.lastIndex = afterOpenLine;
    const close = closeRe.exec(source);
    if (!close) {
      // Unclosed fence — this is where the streaming tail begins.
      return match.index;
    }
    // Skip the closing fence line as well so we don't re-match it.
    fence.lastIndex = close.index + close[0].length + 1;
  }

  // No unclosed fence — the whole message is frozen.
  return source.length;
}

function splitSource(source: string): { frozen: string; tail: string } {
  const cut = findStreamingTailStart(source);
  if (cut >= source.length) {
    return { frozen: source, tail: '' };
  }
  return { frozen: source.slice(0, cut), tail: source.slice(cut) };
}

// ── Mermaid block extraction ─────────────────────────────────
//
// Walk the frozen source and extract every *closed* ```mermaid```
// block. For each one, capture the source text and the byte range
// it occupies. The remainder is "prose" that we render via
// `dangerouslySetInnerHTML`.

type FrozenBlock =
  | { kind: 'prose'; html: string; key: string }
  | { kind: 'mermaid'; source: string; key: string };

function extractFrozenBlocks(frozen: string): FrozenBlock[] {
  const blocks: FrozenBlock[] = [];

  // Walk the frozen source and slice at the boundaries of every
  // *closed* fenced block. Mermaid blocks become their own React
  // element (so their SVG is never overwritten by React's
  // dangerouslySetInnerHTML rewrite). Everything else — including
  // non-mermaid fenced code blocks like ```python``` — becomes a
  // prose block that we render via `marked` + `dangerouslySetInnerHTML`.
  //
  // For each fence we encounter:
  //   - Mermaid: emit the prose immediately before it, then emit
  //     the Mermaid block as its own element.
  //   - Anything else: emit the prose slice that *includes* the
  //     full fenced block (opening fence + body + closing fence).
  //     marked will render it as <pre><code class="language-...">
  //     inside the prose block.
  //
  // This guarantees that every byte of `frozen` ends up in some
  // emitted block — no content is silently dropped.
  const fence = /^[\t ]*(`{3,}|~{3,})[^\n]*$/gm;
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  let mermaidIndex = 0;
  let proseIndex = 0;

  const emitProse = (slice: string) => {
    if (!slice.trim()) return;
    const html = renderMarkdownHtml(slice);
    if (html) {
      blocks.push({
        kind: 'prose',
        html,
        key: `prose-${proseIndex++}-${slice.length}`,
      });
    }
  };

  while ((match = fence.exec(frozen)) !== null) {
    const opener = match[1] ?? '';
    const openerChar = opener[0];
    const openerLen = opener.length;
    const openLineStart = match.index;
    const openLineEnd = match.index + match[0].length + 1; // past the newline
    const language = match[0].slice(openerLen).trim().toLowerCase();

    const closeRe = new RegExp(
      `^[ \\t]*${openerChar === '`' ? '`' : '~'}{${openerLen},}[ \\t]*$`,
      'gm'
    );
    closeRe.lastIndex = openLineEnd;
    const close = closeRe.exec(frozen);
    if (!close) {
      // Unclosed fence — we shouldn't be here because the frozen
      // prefix excludes unclosed fences, but bail out safely.
      break;
    }

    const closeLineEnd = close.index + close[0].length + 1;
    const isMermaid = language === 'mermaid';

    if (isMermaid) {
      // Emit any prose that comes before this Mermaid block,
      // *including* any non-mermaid fenced blocks that lie in the
      // gap (they'll be rendered correctly by marked).
      emitProse(frozen.slice(lastEnd, openLineStart));
      // Emit the Mermaid block as its own element.
      const mermaidSource = frozen.slice(openLineEnd, close.index).replace(/\n$/, '');
      blocks.push({
        kind: 'mermaid',
        source: mermaidSource,
        key: `mermaid-${mermaidIndex++}-${mermaidSource.length}`,
      });
    } else {
      // Non-mermaid fence. The slice [lastEnd, closeLineEnd]
      // includes both the leading prose AND the full fenced block
      // (opening fence, body, closing fence). Emit it as a single
      // prose block so marked can render the fence as <pre><code>.
      emitProse(frozen.slice(lastEnd, closeLineEnd));
    }

    // Skip past the closing fence.
    fence.lastIndex = closeLineEnd;
    lastEnd = closeLineEnd;
  }

  // Trailing prose (includes anything after the last fenced block).
  emitProse(frozen.slice(lastEnd));

  return blocks;
}

// ────────────────────────────────────────────────────────────────
//  MermaidBlock — renders a single Mermaid diagram into a stable
//  React-managed element. Its key is the Mermaid source string,
//  so once the source stabilises (i.e. the closing fence has
//  streamed in) the element is mounted exactly once and never
//  re-rendered by the parent.
// ────────────────────────────────────────────────────────────────

function MermaidBlock({ source }: { source: string }) {
  const containerRef = useRef<HTMLPreElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // The renderer needs a real `<pre>` to target. We give it the
    // container itself, but with a child `<code class="language-mermaid">`
    // that contains the source text (this is what marked would have
    // produced). The renderer will replace the container's innerHTML
    // with the rendered SVG or, on error, an error panel.
    container.innerHTML = `<code class="language-mermaid">${escapeHtml(source)}</code>`;
    setError(null);

    let cancelled = false;
    const rafId = requestAnimationFrame(async () => {
      if (cancelled) return;
      try {
        const result = await renderMermaidInPre(container);
        if (!cancelled && !result.success) {
          setError(result.error);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [source]);

  const handleCopy = useCallback(async () => {
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
  }, [source]);

  if (error) {
    return (
      <div className="mermaid-error-panel">
        <div className="mermaid-error-header">
          <span className="mermaid-error-icon" aria-hidden="true">
            ⚠
          </span>
          <span className="mermaid-error-title">Unable to render diagram</span>
          <button
            className="mermaid-error-copy-btn"
            type="button"
            aria-label="Copy diagram source"
            onClick={handleCopy}
          >
            Copy
          </button>
        </div>
        <div className="mermaid-error-body">
          <p className="mermaid-error-summary">
            The Mermaid source contains a syntax or rendering error.
          </p>
          <div className="mermaid-error-source-wrapper">
            <pre className="mermaid-error-source">
              <code dangerouslySetInnerHTML={{ __html: formatSourceWithLineNumbers(source) }} />
            </pre>
          </div>
          <details className="mermaid-error-details">
            <summary>Technical details</summary>
            <pre>{error}</pre>
          </details>
        </div>
      </div>
    );
  }

  return <pre ref={containerRef} className="mermaid-rendered mermaid-pending" />;
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// ────────────────────────────────────────────────────────────────
//  MarkdownProse — renders a chunk of sanitized HTML via
//  `dangerouslySetInnerHTML` and attaches the copy-button UI to
//  any code blocks. Because the `html` prop is keyed by the
//  block's source slice, once a block's content stabilises the
//  React element is preserved and the SVG / copy button is not
//  destroyed by subsequent re-renders.
// ────────────────────────────────────────────────────────────────

function MarkdownProse({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const attachButtons = () => {
      const preBlocks = container.querySelectorAll('pre');
      preBlocks.forEach((pre) => {
        const code = pre.querySelector('code');
        if (!code) return;
        if (pre.querySelector('.code-copy-btn')) return;

        const computedPosition = globalThis.getComputedStyle(pre).position;
        if (computedPosition === 'static') {
          (pre as HTMLElement).style.position = 'relative';
        }

        const btn = document.createElement('button');
        btn.className = 'code-copy-btn';
        btn.textContent = 'Copy';
        btn.setAttribute('aria-label', 'Copy code to clipboard');
        btn.type = 'button';

        btn.style.cssText = `
          position: absolute;
          top: 8px;
          right: 8px;
          padding: 4px 10px;
          border-radius: 6px;
          border: 1px solid var(--glass-border-soft);
          background: rgba(255,255,255,0.8);
          color: var(--text-secondary);
          font-size: 11px;
          font-family: inherit;
          cursor: pointer;
          z-index: 10;
          line-height: 1.4;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        `;

        btn.addEventListener('click', () => {
          const text = code.textContent || '';
          const fallbackCopy = () => {
            const textarea = document.createElement('textarea');
            textarea.value = text;
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
            navigator.clipboard.writeText(text).catch(fallbackCopy);
          } else {
            fallbackCopy();
          }
          btn.textContent = 'Copied!';
          btn.style.background = 'rgba(0,168,232,0.15)';
          btn.style.color = 'var(--accent)';
          setTimeout(() => {
            btn.textContent = 'Copy';
            btn.style.background = 'rgba(255,255,255,0.8)';
            btn.style.color = 'var(--text-secondary)';
          }, 1500);
        });

        pre.append(btn);
      });
    };

    const rafId = requestAnimationFrame(attachButtons);
    return () => cancelAnimationFrame(rafId);
  }, [html]);

  return (
    <div ref={ref} className="markdown-message-prose" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

// ────────────────────────────────────────────────────────────────
//  Main component
// ────────────────────────────────────────────────────────────────

export default function MarkdownMessage({ source, className }: Props) {
  const { frozen, tail } = useMemo(() => splitSource(source), [source]);

  // The frozen prefix only changes when a new code block is closed.
  // Token-by-token updates inside an unclosed tail do NOT change it.
  const frozenBlocks = useMemo(() => extractFrozenBlocks(frozen), [frozen]);

  const containerClass = className ? `markdown-message ${className}` : 'markdown-message';

  if (frozenBlocks.length === 0 && !tail) {
    return null;
  }

  return (
    <div className={containerClass}>
      {frozenBlocks.map((block) => {
        if (block.kind === 'mermaid') {
          return <MermaidBlock key={block.key} source={block.source} />;
        }
        return <MarkdownProse key={block.key} html={block.html} />;
      })}
      {tail ? <div data-markdown-streaming-tail="true">{tail}</div> : null}
    </div>
  );
}
