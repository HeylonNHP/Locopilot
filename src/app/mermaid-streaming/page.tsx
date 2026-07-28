'use client';

import { useEffect, useState } from 'react';
import MarkdownMessage from '@/components/MarkdownMessage/MarkdownMessage';

const full = `Here is a diagram:\n\n\`\`\`mermaid\ngraph TD\n  A[User] --> B[Locopilot]\n  B --> C[Render Mermaid]\n  C --> D[Validated Chart]\n\`\`\`\n\nDone.`;

export default function MermaidStreamingPage() {
  const [source, setSource] = useState('Here is a diagram:\n\n```mermaid\n');

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      i += 4;
      setSource(full.slice(0, i));
      if (i >= full.length) clearInterval(interval);
    }, 50);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ padding: 40, maxWidth: 800 }}>
      <h1>Streaming mermaid test</h1>
      <MarkdownMessage source={source} />
    </div>
  );
}
