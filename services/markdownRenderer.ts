import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import Table from 'cli-table3';
import chalk from 'chalk';
import stringWidth from 'string-width';
import type { Token, Tokens } from 'marked';
import { getTerminalWidth } from '../terminalWidth.js';

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

function visibleWidth(text: string): number {
  return text
    .split('\n')
    .reduce((maxWidth, line) => Math.max(maxWidth, stringWidth(line)), 0);
}

function renderInlineTokens(renderer: any, tokens: Token[] | undefined, fallbackText = ''): string {
  if (!tokens || tokens.length === 0 || !renderer.parser) return fallbackText;
  return renderer.parser.parseInline(tokens);
}

function renderTableCell(renderer: any, cell: Tokens.TableCell): string {
  return renderInlineTokens(renderer, cell.tokens, cell.text ?? '');
}

function sumWidths(widths: number[]): number {
  return widths.reduce((sum, width) => sum + width, 0);
}

function shrinkWidths(widths: number[], availableWidth: number, minimumWidth: number): number[] {
  const result = widths.slice();
  let totalWidth = sumWidths(result);

  while (totalWidth > availableWidth) {
    let widestIndex = -1;
    let widestSlack = 0;

    for (let index = 0; index < result.length; index += 1) {
      const currentWidth = result[index] ?? 0;
      const slack = currentWidth - minimumWidth;
      if (slack > widestSlack) {
        widestSlack = slack;
        widestIndex = index;
      }
    }

    if (widestIndex < 0) break;

    result[widestIndex] = (result[widestIndex] ?? 0) - 1;
    totalWidth -= 1;
  }

  return result;
}

function buildTableLayout(renderer: any, token: Tokens.Table, terminalWidth: number): { colWidths: number[]; padding: 0 | 1 } | null {
  const columnCount = token.header.length;
  if (columnCount === 0) return null;

  const availableCellWidth = terminalWidth - (columnCount + 1);
  if (availableCellWidth < columnCount) return null;

  const usePadding = availableCellWidth >= columnCount * 3;
  const padding: 0 | 1 = usePadding ? 1 : 0;
  const minimumWidth = usePadding ? 3 : 1;
  const desiredContentWidths = new Array<number>(columnCount).fill(0);

  const rows = [token.header, ...token.rows];
  for (const row of rows) {
    row.forEach((cell, index) => {
      const renderedCell = renderTableCell(renderer, cell);
      desiredContentWidths[index] = Math.max(desiredContentWidths[index] ?? 0, visibleWidth(renderedCell));
    });
  }

  const desiredWidths = desiredContentWidths.map(width => Math.max(minimumWidth, width + padding * 2));
  const totalDesired = sumWidths(desiredWidths);
  const fittedWidths = totalDesired > availableCellWidth
    ? shrinkWidths(desiredWidths, availableCellWidth, minimumWidth)
    : desiredWidths;

  if (sumWidths(fittedWidths) > availableCellWidth) return null;

  return { colWidths: fittedWidths, padding };
}

function renderStackedTable(renderer: any, token: Tokens.Table): string {
  const headers = token.header.map((cell, index) => renderTableCell(renderer, cell) || `Column ${index + 1}`);

  const rows = token.rows.map(row => row
    .map((cell, index) => `${headers[index] ?? `Column ${index + 1}`}: ${renderTableCell(renderer, cell)}`)
    .join('\n'));

  return `${rows.join('\n\n')}\n\n`;
}

function renderWidthAwareTable(renderer: any, token: Tokens.Table, terminalWidth: number): string {
  const layout = buildTableLayout(renderer, token, terminalWidth);
  if (!layout) return renderStackedTable(renderer, token);

  const table = new Table({
    head: token.header.map(cell => renderTableCell(renderer, cell)),
    colWidths: layout.colWidths,
    colAligns: token.align.map(align => align ?? 'left'),
    wordWrap: true,
    wrapOnWordBoundary: false,
    style: {
      'padding-left': layout.padding,
      'padding-right': layout.padding,
    },
  });

  for (const row of token.rows) {
    table.push(row.map(cell => renderTableCell(renderer, cell)));
  }

  return `${renderer.o.table(table.toString())}\n\n`;
}

function createTerminalRenderer(terminalWidth: number): any {
  const renderer = new TerminalRenderer({
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
  }) as any;

  marked.parse('', { renderer });

  const originalText = renderer.text.bind(renderer);
  renderer.text = function (token: any): string {
    if (typeof token === 'object' && token !== null && token.tokens && renderer.parser) {
      return renderer.parser.parseInline(token.tokens);
    }
    return originalText(token);
  };

  renderer.table = function (token: Tokens.Table): string {
    return renderWidthAwareTable(renderer, token, terminalWidth);
  };

  return renderer;
}

// Fix for marked-terminal 7.x: the `text` renderer discards inline token children
// and returns the raw markdown string (e.g. "**Bold**") instead of calling
// parseInline on the child tokens, so strong/em/codespan renderers are never
// reached for text nodes inside list items.
//
// The correct fix is to intercept the `text` renderer and delegate to
// parseInline when a token object with children is provided.  We also prime the
// renderer with an empty parse so that `renderer.parser` is initialised before
// the patch runs.

/**
 * Renders markdown text to terminal-friendly ANSI sequences.
 * @param text Raw markdown text
 * @param terminalWidth Optional terminal width override for table fitting.
 * @returns Formatted ANSI string
 */
export function renderMarkdown(text: string, terminalWidth = getTerminalWidth()): string {
  // Use synchronous marked conversion
  const normalized = normalizeMarkdownIndentation(text);
  const renderer = createTerminalRenderer(terminalWidth);
  return marked.parse(normalized, { renderer }) as string;
}
