'use client';

import { useId, useState } from 'react';

import './ErrorBanner.scss';

interface ErrorBannerProps {
  error: string;
  /**
   * Returns a promise so the banner can show its own in-flight state.
   * Optional: when it is absent there is nothing to retry (the turn's
   * session was deleted, for instance), so the banner offers no Retry
   * button rather than one that fails the same way every time.
   */
  onRetry?: (() => Promise<void> | void) | undefined;
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
    if (isRetrying || !onRetry) return;
    setIsRetrying(true);
    void Promise.resolve(onRetry()).finally(() => setIsRetrying(false));
  };

  // The banner is handed the real, specific error ("Connection lost. The
  // stream was interrupted…", "Please select a model first"). Showing a
  // generic "Something went wrong." hid that behind a Details toggle, so the
  // headline now carries the first line of the error and the full text stays
  // in the expandable details.
  const headline = (error.split('\n')[0] ?? '').trim() || 'Something went wrong.';
  const displayHeadline = headline.length > 160 ? `${headline.slice(0, 159)}…` : headline;

  return (
    <div className="error-banner" role="alert" aria-atomic="true" aria-busy={isRetrying}>
      <div className="error-header">
        <span className="error-message">{displayHeadline}</span>
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
        {onRetry && (
          <button
            type="button"
            onClick={handleRetry}
            className="error-retry-btn"
            aria-disabled={isRetrying}
          >
            {isRetrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
        <button type="button" onClick={onDismiss} className="error-dismiss-btn">
          Dismiss
        </button>
      </div>
    </div>
  );
}
