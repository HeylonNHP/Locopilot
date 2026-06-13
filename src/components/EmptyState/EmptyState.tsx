'use client';

interface EmptyStateProps {
  modelCount: number;
}

export function EmptyState({ modelCount }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <h1 className="font-24 font-normal m-0">Locopilot</h1>
      <p className="m-0">Local, Private, Safe AI Assistant</p>
      {modelCount > 0 && (
        <p className="font-13 m-0">
          {modelCount} model{modelCount === 1 ? '' : 's'} available
        </p>
      )}
    </div>
  );
}
