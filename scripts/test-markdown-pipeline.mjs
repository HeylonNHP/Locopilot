/**
 * Verify the exact HTML produced by marked + DOMPurify for a mermaid block,
 * and the source recovered via textContent.
 */
 
import DOMPurify from 'isomorphic-dompurify';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';

const source = `Here is a diagram:\n\n\`\`\`mermaid\ngraph TD\n  A[User] --> B[Locopilot]\n  B --> C[Render Mermaid]\n  C --> D[Validated Chart]\n\`\`\`\n\nDoes it render?`;

const rawHtml = marked.parse(source, { breaks: true, gfm: true });
const sanitized = DOMPurify.sanitize(rawHtml, {
  ALLOWED_TAGS: [
    'a',
    'abbr',
    'b',
    'blockquote',
    'br',
    'caption',
    'code',
    'col',
    'colgroup',
    'dd',
    'del',
    'details',
    'div',
    'dl',
    'dt',
    'em',
    'figcaption',
    'figure',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'ins',
    'kbd',
    'li',
    'mark',
    'ol',
    'p',
    'pre',
    'q',
    's',
    'samp',
    'small',
    'span',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
  ],
  ALLOWED_ATTR: [
    'href',
    'target',
    'rel',
    'src',
    'alt',
    'title',
    'width',
    'height',
    'colspan',
    'rowspan',
    'scope',
    'align',
    'class',
    'id',
  ],
  ALLOW_DATA_ATTR: false,
});

console.log('Raw marked HTML:');
console.log(rawHtml);
console.log('\nSanitized HTML:');
console.log(sanitized);

const dom = new JSDOM(`<!DOCTYPE html><html><body>${sanitized}</body></html>`);
const code = dom.window.document.querySelector('code.language-mermaid');
console.log('\nRecovered source via textContent:');
console.log(JSON.stringify(code?.textContent ?? null));
