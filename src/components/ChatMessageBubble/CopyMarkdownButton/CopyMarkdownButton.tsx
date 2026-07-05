'use client';
import React, { useCallback, useEffect, useState } from 'react';

import './CopyMarkdownButton.scss';

interface Props {
  content: string;
  disabled?: boolean;
}

export function CopyMarkdownButton({ content, disabled }: Props) {
  const [copied, setCopied] = useState(false);

  // Clear the "Copied!" feedback if the bubble unmounts mid-flash.
  useEffect(() => {
    if (!copied) return;
    const id = globalThis.setTimeout(() => setCopied(false), 1500);
    return () => globalThis.clearTimeout(id);
  }, [copied]);

  const handleCopyMarkdown = useCallback(() => {
    const text = content;
    if (!text) return;

    const fallbackCopy = (): boolean => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      try {
        return document.execCommand('copy');
      } catch {
        return false;
      } finally {
        textarea.remove();
      }
    };

    let succeeded = false;
    if (navigator.clipboard) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
        })
        .catch(() => {
          succeeded = fallbackCopy();
          if (succeeded) setCopied(true);
        });
    } else {
      succeeded = fallbackCopy();
      if (succeeded) setCopied(true);
    }
  }, [content]);

  return (
    <button
      type="button"
      onClick={handleCopyMarkdown}
      disabled={disabled}
      aria-label={copied ? 'Markdown copied to clipboard' : 'Copy message as markdown'}
      className={`bubble-copy-md${copied ? ' bubble-copy-md--copied' : ''}`}
    >
      {copied ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="3 8.5 6.5 12 13 4.5" />
        </svg>
      ) : (
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="5" y="5" width="8.5" height="9" rx="1.5" />
          <path d="M2.5 11V3a1.5 1.5 0 0 1 1.5-1.5H10" />
        </svg>
      )}
      <span>{copied ? 'Copied!' : 'Copy markdown'}</span>
    </button>
  );
}
