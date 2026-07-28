'use client';
import DOMPurify from 'isomorphic-dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useRef } from 'react';

import { renderMermaidInPre } from './mermaidRenderer';

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
    ALLOWED_TAGS: [
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
    ],
    ALLOWED_ATTR: [
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
    ],
    ALLOW_DATA_ATTR: false,
  });
}

export default function MarkdownMessage({ source, className }: Props) {
  const html = useMemo(() => renderMarkdownHtml(source), [source]);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const attachButtons = () => {
      if (!containerRef.current) return;
      const preBlocks = containerRef.current.querySelectorAll('pre');
      preBlocks.forEach((pre) => {
        const code = pre.querySelector('code');
        if (!code) return;

        // Skip if this pre already has a copy button
        if (pre.querySelector('.code-copy-btn')) return;

        // Ensure pre is positioned so the absolute button anchors correctly
        const computedPosition = globalThis.getComputedStyle(pre).position;
        if (computedPosition === 'static') {
          (pre as HTMLElement).style.position = 'relative';
        }

        const btn = document.createElement('button');
        btn.className = 'code-copy-btn';
        btn.textContent = 'Copy';
        btn.setAttribute('aria-label', 'Copy code to clipboard');
        btn.type = 'button';

        // Inline styles ensure visibility even if SCSS fails to load
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

    requestAnimationFrame(attachButtons);

    // ── Mermaid rendering pass ─────────────────────────────────
    // We scan for `<pre><code class="language-mermaid">` blocks after
    // the copy-code pass so the user sees the raw code briefly while
    // the renderer warms up. The renderer is idempotent — re-running
    // this on a re-render is harmless.
    const renderMermaidDiagrams = () => {
      if (!containerRef.current) return;
      const mermaidBlocks = containerRef.current.querySelectorAll<HTMLElement>(
        'pre > code.language-mermaid'
      );
      mermaidBlocks.forEach((codeEl) => {
        const pre = codeEl.parentElement;
        if (!(pre instanceof HTMLPreElement)) return;
        // `void` discards the returned promise so we satisfy the
        // `no-misused-promises` lint rule without an async wrapper.
        void renderMermaidInPre(pre);
      });
    };

    requestAnimationFrame(renderMermaidDiagrams);
  }, [source]);

  if (!html) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={className ? `markdown-message ${className}` : 'markdown-message'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
