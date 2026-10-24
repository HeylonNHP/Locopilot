'use client';

import { useId, useState } from 'react';

import './ErrorBanner.scss';

interface ErrorBannerProps {
  error: string;
  /** Returns a promise so the banner can show its own in-flight state. */
  onRetry: () => Promise<void> | void;
  onDismiss: () => void;
}

export function ErrorBanner({ error, onRetry, onDismiss }: ErrorBannerProps) {
  const [showDetails, setShowDetails] = useState(false);
  // Local, not derived from global streaming state: "Retrying" must describe
  // THIS banner's retry. Deriving it from `streamingSessions` meant the button
  // reflected an unrelated turn in the same session.
  const [isRetrying, setIsRetrying] = useState(false);
  const detailsId = useId();

  const handleRetry = () => {
    if (isRetrying) return;
    setIsRetrying(true);
    void Promise.resolve(onRetry()).finally(() => setIsRetrying(false));
  };

  return (
    <div className="error-banner" role="alert" aria-atomic="true" aria-busy={isRetrying}>
      <div className="error-header">
        <span className="error-message">Something went wrong.</span>
        <button
          type="button"
          className="error-details-toggle"
          onClick={() => setShowDetails((v) => !v)}
          aria-expanded={showDetails}
          aria-controls={detailsId}
        >
          {showDetails ? 'Hide details ▲' : 'Details ▼'}
        </button>
      </div>
      {showDetails && (
        <pre id={detailsId} className="error-details" tabIndex={0} aria-label="Error details">
          {error}
        </pre>
      )}
      <div className="error-actions">
        <button
          type="button"
          onClick={handleRetry}
          className="error-retry-btn"
          aria-disabled={isRetrying}
        >
          {isRetrying ? 'Retrying…' : 'Retry'}
        </button>
        <button type="button" onClick={onDismiss} className="error-dismiss-btn">
          Dismiss
        </button>
      </div>
    </div>
  );
}
