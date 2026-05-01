'use client';

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';

interface Props {
  onSend: (message: string) => void;
  disabled?: boolean;
}

const MIN_TEXTAREA_HEIGHT = 44;
const MAX_TEXTAREA_HEIGHT = 200;

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const COMMANDS = [
  { command: '/clear', description: 'Clear conversation' },
  { command: '/compact', description: 'Summarise conversation history' },
  { command: '/ctx', description: 'Set context size' },
  { command: '/delete', description: 'Delete a session' },
  { command: '/dump', description: 'Export conversation to markdown' },
  { command: '/exit', description: 'Reload page' },
  { command: '/help', description: 'Show all commands' },
  { command: '/model', description: 'Switch model' },
  { command: '/new', description: 'Start fresh conversation' },
  { command: '/nudge', description: 'Remind AI to use tools' },
  { command: '/sessions', description: 'List sessions' },
  { command: '/settings', description: 'Open settings' },
  { command: '/title', description: 'Generate session title' },
];

export default function ChatInput({ onSend, disabled }: Props) {
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = '0px';
    const nextHeight = Math.min(
      Math.max(textarea.scrollHeight, MIN_TEXTAREA_HEIGHT),
      MAX_TEXTAREA_HEIGHT,
    );
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, []);

  useIsomorphicLayoutEffect(() => {
    resizeTextarea();
  }, [input, disabled, resizeTextarea]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const container = textarea?.parentElement;

    if (!container || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      resizeTextarea();
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  const filtered = input.startsWith('/')
    ? COMMANDS.filter((c) => c.command.toLowerCase().startsWith(input.toLowerCase()))
    : [];

  useEffect(() => {
    if (filtered.length > 0) {
      setShowSuggestions(true);
      setSelectedIndex(0);
    } else {
      setShowSuggestions(false);
    }
  }, [input]);

  const handleSubmit = () => {
    const text = input.trim();
    if (text && !disabled) {
      onSend(text);
      setInput('');
      setShowSuggestions(false);
    }
  };

  const applySuggestion = (suggestion: string) => {
    setInput(suggestion + ' ');
    setShowSuggestions(false);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSuggestions && filtered.length > 0) {
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const suggestion = filtered[selectedIndex];
        if (suggestion) {
          applySuggestion(suggestion.command);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Escape') {
        setShowSuggestions(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="chat-input-wrap">
      <div className="chat-input-field-wrap">
        {showSuggestions && (
          <div className="chat-input-suggestions">
            {filtered.map((s, i) => (
              <div
                key={s.command}
                onClick={() => applySuggestion(s.command)}
                onMouseEnter={() => setSelectedIndex(i)}
                className={
                  'chat-input-suggestion-item' +
                  (i === selectedIndex ? ' chat-input-suggestion-active' : '')
                }
              >
                <span className="chat-input-suggestion-cmd">{s.command}</span>
                <span className="chat-input-suggestion-desc">{s.description}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? 'Waiting for response...' : 'Type a message...'}
          rows={1}
          disabled={disabled}
          className="chat-input-textarea"
        />
      </div>
      <button
        onClick={handleSubmit}
        disabled={disabled || !input.trim()}
        className={
          'chat-input-send' +
          (disabled || !input.trim() ? ' chat-input-send-disabled' : ' chat-input-send-active')
        }
      >
        Send
      </button>
    </div>
  );
}
