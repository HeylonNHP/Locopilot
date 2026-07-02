'use client';
import React from 'react';

export class MarkdownErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state: { hasError: boolean } = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          className="bubble-ai-msg"
          style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}
        >
          Failed to render markdown
        </div>
      );
    }
    return this.props.children;
  }
}
