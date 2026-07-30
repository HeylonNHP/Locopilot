'use client';

import MarkdownMessage from '@/components/MarkdownMessage/MarkdownMessage';
import { renderMermaidInPre } from '@/components/MarkdownMessage/mermaidRenderer';

if (typeof globalThis.window !== 'undefined') {
  (globalThis as unknown as Record<string, unknown>).__renderMermaidInPre = renderMermaidInPre;
}

const diagram = `graph TD
  A[User] --> B[Locopilot]
  B --> C[Render Mermaid]
  C --> D[Validated Chart]`;

const source = `Here is a diagram:\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\nDoes it render?`;

export default function MermaidTestPage() {
  return (
    <div style={{ padding: 40, maxWidth: 800 }}>
      <h1>Mermaid render test</h1>
      <MarkdownMessage source={source} />
    </div>
  );
}
