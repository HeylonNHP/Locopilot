/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    'better-sqlite3',
    'playwright',
    'isomorphic-dompurify',
    'jsdom',
    'pdf-parse',
    'mermaid',
    'dompurify',
  ],
  images: {
    // The Image Optimization API refuses SVG unless this is turned on
    // (GHSA-2464-fhr4-w9xw: an SVG reaching the optimiser is parsed by
    // librsvg, which had a use-after-free). `false` is Next's default,
    // but stating it makes the invariant explicit: turning this on would
    // put an RCE back on the table, and nothing in Locopilot needs it —
    // every image is a `data:` URI with `unoptimized`, so the optimiser
    // never runs for our own images anyway.
    dangerouslyAllowSVG: false,
  },
  turbopack: {
    resolveAlias: {
      fs: { browser: './src/lib/empty.ts' },
      path: { browser: './src/lib/empty.ts' },
    },
  },
};

export default nextConfig;
