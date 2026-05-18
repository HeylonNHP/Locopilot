import CopyPlugin from 'copy-webpack-plugin';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['better-sqlite3', 'playwright', 'isomorphic-dompurify', 'jsdom'],
  webpack: (config, { isServer, webpack }) => {
    // Allow loading WASM files required by @dqbd/tiktoken
    config.experiments = { ...config.experiments, asyncWebAssembly: true, layers: true };

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }

    // The bundled tiktoken code does readFileSync(__dirname + './tiktoken_bg.wasm')
    // The to path is relative to webpack's output directory.
    // For server build, output dir is .next/server, so to must be 'app/api/chat/...'
    // For client, output dir is .next, so to is 'static/...'
    config.plugins.push(
      new CopyPlugin({
        patterns: [
          {
            from: path.resolve(__dirname, 'node_modules/@dqbd/tiktoken/tiktoken_bg.wasm'),
            to: isServer ? 'app/api/chat/tiktoken_bg.wasm' : 'static/tiktoken_bg.wasm',
          },
        ],
      }),
    );

    return config;
  },
};

export default nextConfig;
