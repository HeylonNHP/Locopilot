/**
 * Jest configuration.
 *
 * The project is native ESM (`"type": "module"`), so Jest runs in its native
 * ESM mode. That needs Node's `--experimental-vm-modules` flag, which the
 * npm scripts and the shared WebStorm run configurations in `.run/` set.
 * Test files are `*.test.mjs` under `tests/`; sources are TypeScript and are
 * compiled on the fly by SWC (no type checking: `npm run type-check` does that).
 */

/** @type {import('jest').Config} */
const config = {
  // Node's environment, with `instanceof Error` accepting errors from Node's own
  // modules too (see the file for why).
  testEnvironment: '<rootDir>/tests/helpers/sameRealmErrorsEnvironment.mjs',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.mjs'],

  // `.mjs` is always ESM; `.ts`/`.tsx` have to be declared.
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, sourceMaps: 'inline' },
    ],
    '^.+\\.tsx$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', tsx: true },
          transform: { react: { runtime: 'automatic' } },
          target: 'es2022',
        },
        sourceMaps: 'inline',
      },
    ],
  },

  // The `@/*` alias from tsconfig.json.
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },

  // The bundles the Chromium tests build are large and are not tests.
  modulePathIgnorePatterns: ['<rootDir>/tests/mermaid/dist'],

  // Coverage is measured by V8 itself: with native ESM and SWC there is no
  // Babel step to instrument the sources.
  coverageProvider: 'v8',
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts'],

  // The suite is a mix of pure-function tests and tests that start servers,
  // spawn processes and write to temporary directories.
  testTimeout: 30_000,
};

export default config;
