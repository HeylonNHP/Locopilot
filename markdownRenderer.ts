import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import chalk from 'chalk';

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
  return marked.parse(text) as string;
}
