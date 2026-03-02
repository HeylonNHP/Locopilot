import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import chalk from 'chalk';

const TAB_WIDTH = 4;

function countLeadingIndentColumns(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === ' ') {
      columns += 1;
    } else if (char === '\t') {
      columns += TAB_WIDTH;
    } else {
      break;
    }
  }
  return columns;
}

function stripLeadingIndentColumns(line: string, columnsToStrip: number): string {
  if (columnsToStrip <= 0) return line;

  let remaining = columnsToStrip;
  let index = 0;
  while (index < line.length && remaining > 0) {
    const char = line[index];
    if (char === ' ') {
      remaining -= 1;
      index += 1;
      continue;
    }
    if (char === '\t') {
      remaining -= TAB_WIDTH;
      index += 1;
      continue;
    }
    break;
  }

  return line.slice(index);
}

function looksLikeMarkdownSyntax(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return false;
  return /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|~~~|\[.+\]\(.+\)|\|.+\|)/.test(trimmed);
}

function normalizeMarkdownIndentation(text: string): string {
  const lines = text.split('\n');
  if (lines.length < 3) return text;

  const nonEmptyIndices = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ index }) => index);

  if (nonEmptyIndices.length < 2) return text;

  const firstContentIndex = nonEmptyIndices[0] ?? 0;
  const candidateIndices = nonEmptyIndices.filter(index => index !== firstContentIndex);
  if (candidateIndices.length < 2) return text;

  const syntaxCandidates = candidateIndices
    .map(index => ({
      index,
      line: lines[index] ?? '',
    }))
    .filter(({ line }) => looksLikeMarkdownSyntax(line));

  if (syntaxCandidates.length < 2) return text;

  const syntaxIndentColumns = syntaxCandidates.map(({ line }) => countLeadingIndentColumns(line));
  const positiveSyntaxIndentColumns = syntaxIndentColumns.filter(indent => indent > 0);
  if (positiveSyntaxIndentColumns.length < 2) return text;

  const minIndent = Math.min(...positiveSyntaxIndentColumns);
  if (minIndent < 4) return text;

  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trimStart();

    if (/^(```|~~~)/.test(trimmed)) {
      if (countLeadingIndentColumns(line) >= minIndent) {
        lines[i] = stripLeadingIndentColumns(line, minIndent);
      }
      inFence = !inFence;
      continue;
    }

    if (i !== firstContentIndex && !inFence && line.trim().length > 0 && countLeadingIndentColumns(line) >= minIndent) {
      lines[i] = stripLeadingIndentColumns(line, minIndent);
    }
  }

  return lines.join('\n');
}

// Configure marked to use a terminal renderer
marked.setOptions({
  renderer: new TerminalRenderer({
    code: chalk.yellow,
    blockquote: chalk.gray.italic,
    html: chalk.gray,
    heading: chalk.green.bold,
    firstHeading: chalk.magenta.underline.bold,
    hr: chalk.reset,
    listitem: chalk.reset,
    table: chalk.reset,
    paragraph: chalk.reset,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.yellow,
    del: chalk.dim.strikethrough,
    link: chalk.blue,
    href: chalk.blue.underline,
  }) as any
});

/**
 * Renders markdown text to terminal-friendly ANSI sequences.
 * @param text Raw markdown text
 * @returns Formatted ANSI string
 */
export function renderMarkdown(text: string): string {
  // Use synchronous marked conversion
  const normalized = normalizeMarkdownIndentation(text);
  return marked.parse(normalized) as string;
}
