'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
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
            Something went wrong!
          </h1>
          <p style={{ fontSize: '0.875rem', color: '#999', margin: '0 0 1.5rem' }}>
            {error.digest
              ? `Error digest: ${error.digest}`
              : error.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={() => reset()}
            style={{
              padding: '0.5rem 1rem',
              fontSize: '0.875rem',
              borderRadius: '6px',
              border: '1px solid #333',
              backgroundColor: '#1a1a1a',
              color: '#e0e0e0',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
