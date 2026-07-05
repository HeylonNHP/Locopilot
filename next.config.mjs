/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    'better-sqlite3',
    'playwright',
    'isomorphic-dompurify',
    'jsdom',
    'pdf-parse',
  ],
  turbopack: {
    resolveAlias: {
      fs: { browser: './src/lib/empty.ts' },
      path: { browser: './src/lib/empty.ts' },
    },
  },
};

export default nextConfig;
