'use client';
import './ChatMessageBubble.scss';

import dynamic from 'next/dynamic';
import { type ChatMessage } from '@/app/lib/chatStore';
import React, { useCallback, useEffect, useRef, useState } from 'react';

const MarkdownMessage = dynamic(() => import('../MarkdownMessage'), {
  ssr: false,
  loading: () => null,
});

class MarkdownErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state: { hasError: boolean } = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return <div className="bubble-ai-msg" style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>Failed to render markdown</div>;
    }
    return this.props.children;
  }
}

interface Props {
  message: ChatMessage;
}

/** Detect MIME type from the first bytes of a raw base64 string (no data-URI prefix). */
function detectImageMimeType(base64: string): string {
  // Decode the first 4 bytes to check magic bytes
  try {
    const bytes = atob(base64.slice(0, 8));
    const b = (i: number) => bytes.charCodeAt(i);
    if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
    if (b(0) === 0xff && b(1) === 0xd8) return 'image/jpeg';
    if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'image/gif';
    if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46) return 'image/webp';
  } catch {
    // Invalid base64 or insufficient bytes — return opaque type so the
    // browser won't attempt to decode it as a specific format
    return 'application/octet-stream';
  }
  // Unknown magic bytes but valid base64 — JPEG is the most common fallback
  return 'image/jpeg';
}

/** Renders the images array attached to a message as a flex thumbnail strip. */
function AttachmentImages({ images }: { images: string[] }) {
  if (images.length === 0) return null;
  return (
    <div className="bubble-attachment-images">
      {images.map((base64, i) => {
        const mime = detectImageMimeType(base64);
        // Stable key: use a short content prefix so React doesn't mix up siblings
        const key = `img-${i}-${base64.slice(0, 16)}`;
        return (
          <img
            key={key}
            src={`data:${mime};base64,${base64}`}
            alt={`Attached image ${i + 1}`}
            className="bubble-attachment-image"
          />
        );
      })}
    </div>
  );
}

export default function ChatMessageBubble({ message }: Props) {
  const [showThinking, setShowThinking] = useState(false);
  const [subagentCollapsed, setSubagentCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const subagentLogRef = useRef<HTMLPreElement>(null);
  const hasThinking = Boolean(message.thinking?.trim());
  const hasContent = Boolean(message.content?.trim());

  useEffect(() => {
    if (hasThinking && !hasContent) {
      setShowThinking(true);
    }
  }, [hasThinking, hasContent]);

  // Auto-scroll the subagent log to the bottom as new lines arrive.
  useEffect(() => {
    if (!subagentCollapsed && subagentLogRef.current) {
      subagentLogRef.current.scrollTop = subagentLogRef.current.scrollHeight;
    }
  }, [message.content, subagentCollapsed]);

  // Clear the "Copied!" feedback if the bubble unmounts mid-flash.
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  // Two-pass rendering: server and initial client render both output the
  // same placeholder (null), so React hydration never sees a mismatch.
  // After mount the client swaps in the real MarkdownMessage.
  const [markdownMounted, setMarkdownMounted] = useState(false);
  useEffect(() => {
    setMarkdownMounted(true);
  }, []);

  const handleCopyMarkdown = useCallback(() => {
    const text = message.content ?? '';
    if (!text) return;

    const fallbackCopy = (): boolean => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        return document.execCommand('copy');
      } catch {
        return false;
      } finally {
        document.body.removeChild(textarea);
      }
    };

    let succeeded = false;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text)
        .then(() => { setCopied(true); })
        .catch(() => {
          succeeded = fallbackCopy();
          if (succeeded) setCopied(true);
        });
    } else {
      succeeded = fallbackCopy();
      if (succeeded) setCopied(true);
    }
  }, [message.content]);

  if (message.role === 'user') {
    return (
      <div className="bubble-user-wrap">
        <div className="bubble-user">
          {message.images && message.images.length > 0 && (
            <AttachmentImages images={message.images} />
          )}
          {message.content}
        </div>
      </div>
    );
  }
  
  if (message.role === 'tool') {
    return (
      <div className="bubble-tool-wrap">
        <div className="bubble-tool">
          <div className="bubble-tool-content">
            {message.content}
          </div>
        </div>
      </div>
    );
  }
  
  if (message.role === 'system') {
    return (
      <div className="bubble-system-wrap">
        <div className="bubble-system">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === 'subagent_log') {
    return (
      <div className="bubble-subagent-wrap">
        <div className="bubble-subagent">
          <button
            onClick={() => setSubagentCollapsed((c) => !c)}
            className={
              subagentCollapsed
                ? 'bubble-subagent-toggle'
                : 'bubble-subagent-toggle bubble-subagent-toggle-open'
            }
          >
            <span>{subagentCollapsed ? '\u25b6' : '\u25bc'}</span>
            <span>🤖 Sub-agent: {message.subagentId ?? 'unknown'}</span>
          </button>
          {!subagentCollapsed && (
            <pre
              ref={subagentLogRef}
              className="bubble-subagent-log"
            >
              {message.content || 'Waiting...'}
            </pre>
          )}
        </div>
      </div>
    );
  }

  // AI message
  return (
    <div className="bubble-ai-wrap">
      <button
        type="button"
        onClick={handleCopyMarkdown}
        disabled={!hasContent}
        aria-label={copied ? 'Markdown copied to clipboard' : 'Copy message as markdown'}
        className={
          'bubble-copy-md' + (copied ? ' bubble-copy-md--copied' : '')
        }
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
      {hasThinking && (
        <div className="mb-4">
          <button
            onClick={() => setShowThinking(!showThinking)}
            className="bubble-thinking-btn"
          >
            {showThinking ? 'Hide' : 'Show'} reasoning ({message.thinking?.length ?? 0} chars)
          </button>
          {showThinking && (
            <div className="bubble-thinking-box">
              {markdownMounted ? (
                <MarkdownErrorBoundary><MarkdownMessage source={message.thinking ?? ''} className="markdown-message--thinking" /></MarkdownErrorBoundary>
              ) : (
                <div className="markdown-message--thinking" style={{ minHeight: '1.5em' }} />
              )}
            </div>
          )}
        </div>
      )}
      {hasContent || !hasThinking || !showThinking ? (
        <div
          onClick={hasThinking && !hasContent ? () => setShowThinking((prev) => !prev) : undefined}
          onKeyDown={
            hasThinking && !hasContent
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setShowThinking((prev) => !prev);
                  }
                }
              : undefined
          }
          role={hasThinking && !hasContent ? 'button' : undefined}
          tabIndex={hasThinking && !hasContent ? 0 : undefined}
          title={hasThinking && !hasContent ? (showThinking ? 'Hide reasoning' : 'Show reasoning') : undefined}
          className={`bubble-ai-msg${hasThinking && !hasContent ? ' cursor-pointer' : ''}`}
        >
          {hasContent || message.role !== 'assistant' ? (
            markdownMounted ? (
              <MarkdownErrorBoundary><MarkdownMessage source={message.content} /></MarkdownErrorBoundary>
            ) : (
              <div style={{ minHeight: '1.5em' }} />
            )
          ) : (
            '...'
          )}
        </div>
      ) : null}
    </div>
  );
}
