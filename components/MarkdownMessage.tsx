'use client';

import DOMPurify from 'isomorphic-dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

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
      'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
      'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
      'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span',
      'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
      'th', 'thead', 'tr', 'u', 'ul',
    ],
    ALLOWED_ATTR: [
      'href', 'target', 'rel', 'src', 'alt', 'title', 'width', 'height',
      'colspan', 'rowspan', 'scope', 'align', 'class', 'id',
    ],
    ALLOW_DATA_ATTR: false,
  });
}

export default function MarkdownMessage({ source, className }: Props) {
  const html = useMemo(() => renderMarkdownHtml(source), [source]);

  if (!html) {
    return null;
  }

  return (
    <div
      className={className ? `markdown-message ${className}` : 'markdown-message'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}