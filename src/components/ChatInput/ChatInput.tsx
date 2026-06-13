'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import './ChatInput.scss';

const SIZE_WARNING_BYTES = 25 * 1024 * 1024; // 25 MB — show warning badge above this
const TEXT_INLINE_LIMIT = 50_000; // chars — inject inline below this, upload above

/** Language hint derived from file extension for fenced code blocks. */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  xml: 'xml',
  txt: '',
};

function langFromFilename(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext] ?? '';
}

export type AttachmentType = 'image' | 'text' | 'pdf';

export interface Attachment {
  /** Stable per-attachment UI id — generated at attach time so repeated pastes
   *  of identically-named images (e.g. "image.png" from clipboard) are
   *  treated as distinct entries. */
  id: string;
  type: AttachmentType;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Raw base64 (no data URI prefix) — populated for images. */
  base64?: string;
  /** Full UTF-8 content — populated for text/code files. */
  textContent?: string;
  /** Raw File object — kept for PDFs that need server-side extraction. */
  file?: File;
}

const ACCEPTED_MIME_PREFIXES = ['image/', 'text/'];
const ACCEPTED_EXTENSIONS = new Set([
  'pdf',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'rb',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'cs',
  'sh',
  'zsh',
  'json',
  'yaml',
  'yml',
  'toml',
  'md',
  'html',
  'css',
  'scss',
  'sql',
  'xml',
  'txt',
]);

function isAccepted(file: File): boolean {
  if (ACCEPTED_MIME_PREFIXES.some((p) => file.type.startsWith(p))) return true;
  if (file.type === 'application/pdf') return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return ACCEPTED_EXTENSIONS.has(ext);
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result as string));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const result = reader.result as string;
      // Strip the "data:...;base64," prefix — Ollama expects raw base64
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface Props {
  onSend: (message: string, attachments: Attachment[]) => void;
  disabled?: boolean;
}

const MIN_TEXTAREA_HEIGHT = 44;
const MAX_TEXTAREA_HEIGHT = 200;

const useIsomorphicLayoutEffect = typeof globalThis.window === 'undefined' ? useEffect : useLayoutEffect;

const COMMANDS = [
  { command: '/clear', description: 'Clear conversation' },
  { command: '/clear-images', description: 'Remove image attachments to free context' },
  { command: '/compact', description: 'Summarise conversation history' },
  { command: '/ctx', description: 'Set context size' },
  { command: '/delete', description: 'Delete a session' },
  { command: '/dump', description: 'Export conversation to markdown' },
  { command: '/help', description: 'Show all commands' },
  { command: '/mcp', description: 'List MCP servers (or /mcp reload)' },
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
        (trimmed.includes('\\') || trimmed.includes('/') || /^[A-Za-z]:[/\\]/.test(trimmed))
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
          path = path.replaceAll('/', '\\');
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
  for (const file of files) {
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addAttachments = useCallback(async (files: File[]) => {
    const accepted = files.filter(isAccepted);
    if (accepted.length === 0) return;

    const next: Attachment[] = [];
    for (const file of accepted) {
      const id = crypto.randomUUID();
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const isImage = file.type.startsWith('image/');

      if (isPdf) {
        next.push({
          id,
          type: 'pdf',
          name: file.name,
          mimeType: file.type || 'application/pdf',
          sizeBytes: file.size,
          file,
        });
      } else if (isImage) {
        try {
          const base64 = await readFileAsBase64(file);
          next.push({
            id,
            type: 'image',
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            base64,
          });
        } catch {
          // Skip unreadable images
        }
      } else {
        // Text / code file
        try {
          const textContent = await readFileAsText(file);
          next.push({
            id,
            type: 'text',
            name: file.name,
            mimeType: file.type || 'text/plain',
            sizeBytes: file.size,
            textContent,
          });
        } catch {
          // Skip unreadable files
        }
      }
    }

    if (next.length > 0) {
      setAttachments((prev) => [...prev, ...next]);
    }
  }, []);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const nextHeight = Math.min(
      Math.max(textarea.scrollHeight, MIN_TEXTAREA_HEIGHT),
      MAX_TEXTAREA_HEIGHT
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
        (e.dataTransfer.types.includes('Files') ||
          (e.dataTransfer.items &&
            [...e.dataTransfer.items].some((item) => item.kind === 'file')))
      ) {
        e.preventDefault();
      }
    };

    const handleWindowDrop = (e: DragEvent) => {
      if (
        e.dataTransfer &&
        (e.dataTransfer.types.includes('Files') ||
          (e.dataTransfer.items &&
            [...e.dataTransfer.items].some((item) => item.kind === 'file')))
      ) {
        e.preventDefault();
      }
    };

    globalThis.addEventListener('dragover', handleWindowDragOver);
    globalThis.addEventListener('drop', handleWindowDrop);

    return () => {
      globalThis.removeEventListener('dragover', handleWindowDragOver);
      globalThis.removeEventListener('drop', handleWindowDrop);
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
    if ((text || attachments.length > 0) && !disabled) {
      onSend(text, attachments);
      setInput('');
      setAttachments([]);
      setShowSuggestions(false);
    }
  };

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const fileItems: File[] = [];
      for (const item of items) {
        if (item?.kind === 'file') {
          const f = item.getAsFile();
          if (f) fileItems.push(f);
        }
      }
      if (fileItems.length > 0) {
        e.preventDefault();
        void addAttachments(fileItems);
      }
      // Otherwise let the browser handle the paste normally (text)
    },
    [addAttachments]
  );

  const applySuggestion = (suggestion: string) => {
    setInput(`${suggestion  } `);
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

    // Prefer actual File objects (drag from file manager)
    const droppedFiles = [...e.dataTransfer.files];
    const acceptedFiles = droppedFiles.filter(isAccepted);
    if (acceptedFiles.length > 0) {
      void addAttachments(acceptedFiles);
      return;
    }

    // Fall back to path-string extraction (drag from terminal / path text)
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
      insert = ` ${  insert}`;
    }
    if (after.length > 0 && !/^\s/.test(after)) {
      insert = `${insert  } `;
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
      {/* Hidden native file picker */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,application/pdf,text/plain,text/markdown,text/html,text/css,.ts,.tsx,.js,.jsx,.py,.rb,.rs,.go,.java,.c,.cpp,.cs,.sh,.zsh,.json,.yaml,.yml,.toml,.md,.scss,.sql,.xml"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...e.target.files ?? []];
          if (files.length > 0) void addAttachments(files);
          // Reset so the same file can be re-added if removed
          e.target.value = '';
        }}
      />

      <div className={`chat-input-field-wrap${isDragging ? ' chat-input-drag-active' : ''}`}>
        {showSuggestions && (
          <div className="chat-input-suggestions">
            {filtered.map((s, i) => (
              <div
                key={s.command}
                onClick={() => applySuggestion(s.command)}
                onMouseEnter={() => setSelectedIndex(i)}
                className={
                  `chat-input-suggestion-item${ 
                  i === selectedIndex ? ' chat-input-suggestion-active' : ''}`
                }
              >
                <span className="chat-input-suggestion-cmd">{s.command}</span>
                <span className="chat-input-suggestion-desc">{s.description}</span>
              </div>
            ))}
          </div>
        )}

        {/* Attachment preview strip */}
        {attachments.length > 0 && (
          <div className="chat-input-attachments">
            {attachments.map((att, _idx) => {
              const removeBtn = (
                <button
                  type="button"
                  className="chat-input-attachment-remove"
                  onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                  aria-label={`Remove ${att.name}`}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              );
              if (att.type === 'image' && att.base64) {
                return (
                  <div key={att.id} className="chat-input-attachment-img-card" title={att.name}>
                    <img
                      src={`data:${att.mimeType};base64,${att.base64}`}
                      alt={att.name}
                      className="chat-input-attachment-thumb"
                    />
                    {att.sizeBytes > SIZE_WARNING_BYTES && (
                      <span
                        className="chat-input-attachment-warn"
                        title="Large file — will upload to server"
                      >
                        ⚠
                      </span>
                    )}
                    {removeBtn}
                  </div>
                );
              }
              return (
                <div
                  key={att.id}
                  className={`chat-input-attachment-chip chat-input-attachment-chip--${att.type}`}
                >
                  <span className="chat-input-attachment-icon">
                    {att.type === 'pdf' ? (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="9" y1="13" x2="15" y2="13" />
                        <line x1="9" y1="17" x2="15" y2="17" />
                      </svg>
                    ) : (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="16 18 22 12 16 6" />
                        <polyline points="8 6 2 12 8 18" />
                      </svg>
                    )}
                  </span>
                  <span className="chat-input-attachment-name" title={att.name}>
                    {att.name}
                  </span>
                  {att.sizeBytes > SIZE_WARNING_BYTES && (
                    <span
                      className="chat-input-attachment-warn"
                      title="Large file — will upload to server"
                    >
                      ⚠
                    </span>
                  )}
                  {removeBtn}
                </div>
              );
            })}
          </div>
        )}

        <div className="chat-input-textarea-wrap">
          <textarea
            ref={textareaRef}
            className="chat-input-textarea"
            placeholder="Type a message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            rows={1}
            disabled={disabled}
          />
          {/* Paperclip button — inside the textarea, bottom-left */}
          <button
            type="button"
            className="chat-input-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            title="Attach file or image"
            aria-label="Attach file or image"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
        </div>
      </div>

      <button
        className={`chat-input-send chat-input-send-${disabled ? 'disabled' : 'active'}`}
        onClick={handleSubmit}
        disabled={disabled}
      >
        Send
      </button>
    </div>
  );
}

export { langFromFilename, TEXT_INLINE_LIMIT };
