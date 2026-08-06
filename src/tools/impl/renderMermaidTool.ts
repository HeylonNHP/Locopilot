import type { ToolCallResult } from '@/tools/toolRegistry';
import type { ToolSchema } from '@/tools/tools';

import { ServerMermaidEnvironmentError, withServerMermaidEnvironment } from '@/lib/serverMermaid';

/**
 * Locopilot-side `render_mermaid` tool.
 *
 * IMPORTANT: This is a *validation* tool, not a renderer. The actual
 * interactive rendering happens client-side in the React frontend,
 * which loads the `mermaid` npm package and renders any fenced
 * ```mermaid ... ``` blocks the model emits.
 *
 * The server-side job is narrower: confirm the diagram parses cleanly
 * before the model commits to it, so the user does not see a broken
 * "Unable to render" placeholder in the chat. The model is told
 * (via the tool description in the system prompt) to include the
 * validated diagram in its response wrapped in a ```mermaid fenced
 * block.
 *
 * The implementation dynamically imports the `mermaid` package so
 * the server cold start is not penalised for a browser-oriented
 * library that will only be used on validate-tool calls. The
 * frontend installer is the one that adds the package to
 * package.json — this file only consumes it.
 *
 * Because `mermaid` transitively imports `dompurify`, which requires a
 * browser `window`, the load is wrapped by `withServerMermaidEnvironment()`
 * (see `src/lib/serverMermaid.ts`). The wrapper creates a temporary JSDOM
 * window, installs it as `globalThis.window`/`document` only long enough to
 * load and use mermaid, then restores the originals.
 */
export const renderMermaidToolSchema: ToolSchema = {
  name: 'render_mermaid',
  description:
    'Validates a Mermaid diagram for syntax correctness before output. The tool does NOT render the diagram itself — it only validates syntax. To show the diagram to the user, include the (validated) diagram in your response wrapped in a ```mermaid code block. The frontend will render it interactively.',
  parameters: {
    type: 'object',
    properties: {
      diagram: {
        type: 'string',
        description:
          'The raw Mermaid diagram source code (NOT wrapped in markdown code fences — just the diagram itself, e.g. starting with "graph TD", "sequenceDiagram", "classDiagram", "stateDiagram-v2", "erDiagram", "gantt", "pie", "gitGraph", "mindmap", "timeline", "journey", etc.).',
      },
    },
    required: ['diagram'],
  },
};

export interface RenderMermaidToolArgs {
  diagram?: string | undefined;
}

export interface RenderMermaidToolOptions {
  onProgress?: (message: string) => void;
}

export class RenderMermaidTool {
  private readonly onProgress: ((message: string) => void) | undefined;

  constructor(options: RenderMermaidToolOptions = {}) {
    this.onProgress = options.onProgress;
  }

  async run(args: RenderMermaidToolArgs, _signal?: AbortSignal): Promise<ToolCallResult> {
    const diagram = (args.diagram ?? '').trim();

    if (!diagram) {
      return { content: 'render_mermaid: missing or empty "diagram" argument' };
    }

    this.progress('render_mermaid: validating syntax...');

    try {
      // Validate inside a temporary JSDOM-backed window so DOMPurify,
      // which mermaid imports, resolves to a bound instance instead of
      // the Node.js factory function.
      let rawError: string | undefined;
      await withServerMermaidEnvironment(async (mermaid) => {
        // Mermaid v11 returns `false` from `parse(..., { suppressErrors: true })`
        // for invalid syntax instead of throwing. We use that form to avoid an
        // exception on the happy-invalid path, then fall back to an unsuppressed
        // parse to capture the human-readable error message for diagnostics.
        const parseResult = await mermaid.parse(diagram, { suppressErrors: true });
        if (parseResult === false) {
          try {
            await mermaid.parse(diagram);
          } catch (parseErr) {
            rawError = parseErr instanceof Error ? parseErr.message : String(parseErr);
          }
        }
      });

      if (rawError !== undefined) {
        this.progress('render_mermaid: syntax error.');
        return {
          content:
            `✗ Invalid Mermaid syntax: ${rawError}\n\n` +
            `Raw diagram:\n\`\`\`\n${diagram}\n\`\`\`\n\n` +
            `Fix the syntax and try again. Common issues: missing semicolons for classDiagram, ` +
            `unmatched brackets in flowcharts, unsupported diagram type, or invalid arrow syntax.`,
        };
      }

      this.progress('render_mermaid: syntax OK.');
      return {
        content:
          `✓ Valid Mermaid diagram — include it in your response in a \`\`\`mermaid fenced code block so the user can see it rendered:\n\n` +
          `\`\`\`mermaid\n${diagram}\n\`\`\``,
      };
    } catch (err) {
      if (err instanceof ServerMermaidEnvironmentError) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          content:
            `render_mermaid: failed to load the Mermaid environment — ${reason}. ` +
            `Make sure "mermaid" and "jsdom" are installed and listed as dependencies.`,
        };
      }

      const reason = err instanceof Error ? err.message : String(err);
      return {
        content:
          `✗ Invalid Mermaid syntax: ${reason}\n\n` +
          `Raw diagram:\n\`\`\`\n${diagram}\n\`\`\`\n\n` +
          `Fix the syntax and try again. Common issues: missing semicolons for classDiagram, ` +
          `unmatched brackets in flowcharts, unsupported diagram type, or invalid arrow syntax.`,
      };
    }
  }

  private progress(message: string): void {
    this.onProgress?.(message);
  }
}

export function getToolPrompt(): string {
  const s = renderMermaidToolSchema;
  const p = s.parameters.properties;
  return (
    `15. ${s.name}(diagram)\n` +
    `   ${s.description}\n\n` +
    `   - diagram: ${p.diagram!.description}\n`
  );
}
