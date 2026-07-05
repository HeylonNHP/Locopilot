'use client';

import ChatInput, { type Attachment } from '@/components/ChatInput';

interface InputAreaProps {
  isStreaming: boolean;
  isCompacting: boolean;
  isGeneratingTitle: boolean;
  compactingPhases: string[];
  onStop: () => void;
  onSend: (message: string, attachments: Attachment[]) => void;
}

/**
 * Renders the bottom input zone in one of three states:
 *  - Streaming: phase label + Stop button
 *  - Compacting / generating title: phase label only
 *  - Idle: the ChatInput composer
 */
export function InputArea({
  isStreaming,
  isCompacting,
  isGeneratingTitle,
  compactingPhases,
  onStop,
  onSend,
}: InputAreaProps) {
  if (isStreaming) {
    const phase =
      compactingPhases.length > 0 ? compactingPhases.at(-1) : 'Streaming...';
    return (
      <div className="streaming-indicator">
        <span className="text-accent font-14">● {phase}</span>
        <button onClick={onStop} className="stop-btn">
          Stop
        </button>
      </div>
    );
  }

  if (isCompacting) {
    const phase =
      compactingPhases.length > 0
        ? compactingPhases.at(-1)
        : 'Compacting conversation...';
    return (
      <div className="streaming-indicator">
        <span className="text-accent font-14">● {phase}</span>
      </div>
    );
  }

  if (isGeneratingTitle) {
    return (
      <div className="streaming-indicator">
        <span className="text-accent font-14">● Generating session title...</span>
      </div>
    );
  }

  return <ChatInput onSend={onSend} disabled={false} />;
}
