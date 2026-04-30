'use client';

import { marked } from 'marked';
import { useMemo } from 'react';

interface Props {
  source: string;
  className?: string;
}

function renderMarkdownHtml(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return '';
  }

  const html = marked.parse(trimmed, { breaks: true, gfm: true }) as string;
  return html.replace(/<a\s+/g, '<a target="_blank" rel="noreferrer noopener" ');
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