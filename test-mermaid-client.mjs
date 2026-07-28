/**
 * Standalone reproduction of the client-side Mermaid renderer failure.
 * Simulates a browser environment via JSDOM and invokes renderMermaidInPre
 * exactly as MarkdownMessage.tsx does.
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  runScripts: 'outside-only',
  url: 'http://localhost',
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLPreElement = dom.window.HTMLPreElement;
globalThis.Element = dom.window.Element;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// Polyfill getComputedStyle with sensible defaults so collectThemeVariables()
// sees real values (some JSDOM versions return empty for everything).
const originalGetComputedStyle = dom.window.getComputedStyle;
dom.window.getComputedStyle = (elt, pseudoElt) => {
  const real = originalGetComputedStyle(elt, pseudoElt);
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'getPropertyValue') {
        return (name) => {
          const cssVars = {
            '--bg-primary': '#ffffff',
            '--accent': '#0066cc',
            '--text-primary': '#111111',
            '--bg-secondary': '#f5f5f5',
            '--text-secondary': '#666666',
            '--font-sans': 'sans-serif',
          };
          return cssVars[name] ?? target.getPropertyValue(name);
        };
      }
      return target[prop];
    },
  });
};

const source = `graph TD
  A[User] --> B[Locopilot]
  B --> C[Render Mermaid]
  C --> D[Validated Chart]`;

const pre = document.createElement('pre');
const code = document.createElement('code');
code.className = 'language-mermaid';
code.textContent = source;
pre.appendChild(code);
document.getElementById('root').appendChild(pre);

const { renderMermaidInPre } = await import(
  './src/components/MarkdownMessage/mermaidRenderer.ts'
);

console.log('renderMermaidInPre loaded');
console.log('pre.dataset before:', pre.dataset.mermaidRendered);

try {
  await renderMermaidInPre(pre, { mermaidIdBase: 'test' });
  console.log('renderMermaidInPre completed');
  console.log('pre.dataset after:', pre.dataset.mermaidRendered);
  console.log('pre.innerHTML length:', pre.innerHTML.length);
  console.log('pre.innerHTML first 500 chars:', pre.innerHTML.slice(0, 500));
  if (pre.dataset.mermaidRendered === 'error' || pre.querySelector('.mermaid-error-panel')) {
    console.error('ERROR: Mermaid failed to render');
    console.error(pre.innerHTML);
    process.exit(1);
  }
} catch (err) {
  console.error('renderMermaidInPre threw:', err);
  process.exit(1);
}
