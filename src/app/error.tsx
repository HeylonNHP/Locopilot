'use client';

import { useEffect } from 'react';

interface ErrorBoundaryProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorBoundary({ error, reset }: ErrorBoundaryProps) {
  useEffect(() => {
    console.error('App-level error boundary caught:', error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '2rem',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            backgroundColor: '#0d0d0d',
            color: '#e0e0e0',
            textAlign: 'center',
          }}
        >
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: '0 0 0.5rem' }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: '0.9rem', color: '#888', margin: '0 0 1.5rem', maxWidth: '480px' }}>
            An unexpected error occurred. You can try recovering, or reload the page.
          </p>

          {error.message && (
            <pre
              style={{
                maxWidth: '540px',
                overflowX: 'auto',
                fontSize: '0.8rem',
                color: '#f87171',
                backgroundColor: '#1a1a1a',
                padding: '0.75rem 1rem',
                borderRadius: '8px',
                margin: '0 0 1.5rem',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {error.message}
            </pre>
          )}

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              onClick={reset}
              style={{
                padding: '0.5rem 1.25rem',
                fontSize: '0.9rem',
                borderRadius: '6px',
                border: 'none',
                cursor: 'pointer',
                backgroundColor: '#3b82f6',
                color: '#fff',
              }}
            >
              Try again
            </button>
            <button
              onClick={() => globalThis.location.reload()}
              style={{
                padding: '0.5rem 1.25rem',
                fontSize: '0.9rem',
                borderRadius: '6px',
                border: '1px solid #444',
                cursor: 'pointer',
                backgroundColor: 'transparent',
                color: '#e0e0e0',
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
