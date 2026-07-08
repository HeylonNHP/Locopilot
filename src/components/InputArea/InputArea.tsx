'use client';

import ChatInput, { type Attachment } from '@/components/ChatInput';

import { useChat } from '@/app/lib/chatStore';

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
  // visionState is read from the chat store so the ChatInput
  // composer can render the inline warning when the active model
  // is known to reject image input. See
  // `src/services/visionCache.ts` and the `vision_unsupported`
  // SSE event for how this state transitions.
  const { state } = useChat();
  const visionState = state.visionState;
  const provider = state.provider;

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

  return <ChatInput onSend={onSend} disabled={false} visionState={visionState} provider={provider} />;
}
