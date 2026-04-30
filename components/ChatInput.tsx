'use client';

import { useState, useRef, useEffect } from 'react';

interface Props {
  onSend: (message: string) => void;
  disabled?: boolean;
}

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
    <div style={{ display: 'flex', gap: '8px' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        {showSuggestions && (
          <div
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 8px)',
              left: 0,
              right: 0,
              background: 'var(--bg-secondary)',
              border: '1px solid #444',
              borderRadius: '8px',
              zIndex: 10,
              overflow: 'hidden',
            }}
          >
            {filtered.map((s, i) => (
              <div
                key={s.command}
                onClick={() => applySuggestion(s.command)}
                onMouseEnter={() => setSelectedIndex(i)}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  background: i === selectedIndex ? 'var(--bg-tertiary)' : 'transparent',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontFamily: 'monospace' }}>{s.command}</span>
                <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                  {s.description}
                </span>
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
          style={{
            width: '100%',
            padding: '12px',
            borderRadius: '8px',
            border: '1px solid #444',
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            fontSize: '14px',
            resize: 'none',
            fontFamily: 'inherit',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      </div>
      <button
        onClick={handleSubmit}
        disabled={disabled || !input.trim()}
        style={{
          padding: '12px 24px',
          borderRadius: '8px',
          border: 'none',
          background: disabled || !input.trim() ? '#555' : 'var(--accent)',
          color: 'white',
          cursor: disabled || !input.trim() ? 'not-allowed' : 'pointer',
          fontSize: '14px',
          fontWeight: 'bold',
        }}
      >
        Send
      </button>
    </div>
  );
}
