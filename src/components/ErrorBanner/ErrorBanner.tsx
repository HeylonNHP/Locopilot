'use client';

import { useState } from 'react';

interface ErrorBannerProps {
  error: string;
  isRetrying: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}

export function ErrorBanner({ error, isRetrying, onRetry, onDismiss }: ErrorBannerProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="error-banner">
      <div className="error-header">
        <span className="error-message">Something went wrong.</span>
        <button className="error-details-toggle" onClick={() => setShowDetails((v) => !v)}>
          {showDetails ? 'Hide details ▲' : 'Details ▼'}
        </button>
      </div>
      {showDetails && <pre className="error-details">{error}</pre>}
      <div className="error-actions">
        <button onClick={onRetry} className="error-retry-btn" disabled={isRetrying}>
          Retry
        </button>
        <button onClick={onDismiss} className="error-dismiss-btn">
          Dismiss
        </button>
      </div>
    </div>
  );
}
