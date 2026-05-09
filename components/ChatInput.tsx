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

function extractPaths(e: React.DragEvent): string[] {
  const paths: string[] = [];

  // Method 1: text/plain — on Windows Explorer→Edge/Chrome this sometimes contains the full path.
  const plain = e.dataTransfer.getData('text/plain');
  if (plain) {
    const lines = plain.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.length > 0 &&
        (trimmed.includes('\\') || trimmed.includes('/') || /^[A-Za-z]:[\\\/]/.test(trimmed))
      ) {
        paths.push(trimmed);
      }
    }
  }

  if (paths.length > 0) {
    return paths;
  }

  // Method 2: text/uri-list — may contain file:///C:/... URLs.
  const uriList = e.dataTransfer.getData('text/uri-list');
  if (uriList) {
    const lines = uriList.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('file:///')) {
        let path = trimmed.slice('file:///'.length);
        try {
          path = decodeURIComponent(path);
        } catch {
          // leave as-is
        }
        // Convert forward slashes to backslashes on Windows-like paths
        if (/^[A-Za-z]:\//.test(path)) {
          path = path.replace(/\//g, '\\');
        }
        paths.push(path);
      }
    }
  }

  if (paths.length > 0) {
    return paths;
  }

  // Method 3: (file as any).path — works in Electron/WebView2.
  // Method 4: fallback to file.name.
  const files = e.dataTransfer.files;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    const path = (file as any).path ?? file.name;
    if (path) {
      paths.push(path);
    }
  }

  return paths;
}

export default function ChatInput({ onSend, disabled }: Props) {
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const nextHeight = Math.min(
      Math.max(textarea.scrollHeight, MIN_TEXTAREA_HEIGHT),
      MAX_TEXTAREA_HEIGHT,
    );
    const nextHeightPx = `${nextHeight}px`;

    // Guard: skip DOM mutation if already at target height.
    // Prevents a feedback loop when the ResizeObserver fires in
    // response to our own height change.
    if (textarea.style.height === nextHeightPx) return;

    textarea.style.height = nextHeightPx;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, []);

  useIsomorphicLayoutEffect(() => {
    resizeTextarea();
  }, [input, disabled, resizeTextarea]);

  useEffect(() => {
    const textarea = textareaRef.current;

    if (!textarea || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      resizeTextarea();
    });

    // Observe the textarea itself rather than its parent so we only react
    // to changes in the textarea's own bounding box (width changes from
    // window resize, etc.), avoiding spurious triggers from sibling layout.
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  // Prevent browser from navigating to dropped files when the drop misses the textarea.
  useEffect(() => {
    const handleWindowDragOver = (e: DragEvent) => {
      if (
        e.dataTransfer &&
        (e.dataTransfer.types.includes('Files') || (e.dataTransfer.items && Array.from(e.dataTransfer.items).some((item) => item.kind === 'file')))
      ) {
        e.preventDefault();
      }
    };

    const handleWindowDrop = (e: DragEvent) => {
      if (
        e.dataTransfer &&
        (e.dataTransfer.types.includes('Files') || (e.dataTransfer.items && Array.from(e.dataTransfer.items).some((item) => item.kind === 'file')))
      ) {
        e.preventDefault();
      }
    };

    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('drop', handleWindowDrop);

    return () => {
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, []);

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

  const handleDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    setIsDragging(false);

    const paths = extractPaths(e);
    if (paths.length === 0) {
      return;
    }

    const joined = paths.join('\n');
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const before = input.slice(0, start);
    const after = input.slice(end);

    let insert = joined;
    if (before.length > 0 && !/\s$/.test(before)) {
      insert = ' ' + insert;
    }
    if (after.length > 0 && !/^\s/.test(after)) {
      insert = insert + ' ';
    }

    const newValue = before + insert + after;
    setInput(newValue);

    // Focus and place cursor after the inserted text.
    requestAnimationFrame(() => {
      textarea.focus();
      const newCursor = start + insert.length;
      textarea.setSelectionRange(newCursor, newCursor);
    });
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
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          placeholder={disabled ? 'Waiting for response...' : 'Type a message...'}
          rows={1}
          disabled={disabled}
          className={
            'chat-input-textarea' + (isDragging ? ' chat-input-drag-active' : '')
          }
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
