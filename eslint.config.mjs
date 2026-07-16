// @ts-check
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import perfectionist from 'eslint-plugin-perfectionist';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Ignore build/runtime directories
  {
    ignores: ['.next/', 'dist/', 'node_modules/', 'coverage/', '*.db*', '*.wasm', 'next-env.d.ts'],
  },

  // Base JavaScript recommended rules
  js.configs.recommended,

  // TypeScript recommended rules (not strict — manageable defaults)
  ...tseslint.configs.recommended,

  // Next.js plugin
  {
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },

  // Perfectionist — import and member sorting (auto-fixable)
  {
    plugins: { perfectionist },
    rules: {
      'perfectionist/sort-imports': [
        'error',
        {
          type: 'natural',
          order: 'asc',
          internalPattern: ['^@/'],
          newlinesBetween: 'always',
          groups: [
            'type-import',
            ['builtin', 'external'],
            'internal-type',
            'internal',
            ['parent-type', 'sibling-type', 'index-type'],
            ['parent', 'sibling', 'index'],
            'side-effect',
            'style',
          ],
        },
      ],
      'perfectionist/sort-named-imports': ['error', { type: 'natural', order: 'asc' }],
      'perfectionist/sort-named-exports': ['error', { type: 'natural', order: 'asc' }],
      'perfectionist/sort-exports': ['error', { type: 'natural', order: 'asc' }],
    },
  },

  // Unicorn — code quality and best-practice rules
  {
    plugins: { unicorn: eslintPluginUnicorn },
    rules: {
      ...eslintPluginUnicorn.configs.recommended.rules,

      // Opt out of noisy / project-inappropriate rules
      'unicorn/no-null': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/filename-case': 'off',
      'unicorn/no-array-for-each': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/no-array-method-this-argument': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'unicorn/no-anonymous-default-export': 'off',
      'unicorn/no-typeof-undefined': 'off',
      'unicorn/numeric-separators-style': 'off',
      'unicorn/no-thenable': 'off',

      // Keep these on — they catch real issues
      'unicorn/catch-error-name': ['error', { name: 'err' }],
      'unicorn/error-message': 'error',
      'unicorn/throw-new-error': 'error',
      'unicorn/no-useless-undefined': ['error', { checkArguments: false }],
      'unicorn/prefer-at': 'error',
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/prefer-module': 'error',
      'unicorn/no-await-in-promise-methods': 'error',
      'unicorn/no-unnecessary-await': 'error',
      'unicorn/consistent-destructuring': 'error',
      'unicorn/no-console-spaces': 'error',
      'unicorn/better-regex': 'error',
    },
  },

  // Additional sensible defaults
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-template': 'error',
      'object-shorthand': ['error', 'always'],
      'no-duplicate-imports': 'error',

      // TypeScript-specific
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'error',
    },
  },

  // Node scripts in scripts/ need browser globals disabled and Node
  // globals enabled. The default ESLint environment is the browser,
  // so process/console/etc. are flagged as no-undef without this.
  // `no-console` is also relaxed here because the wrapper scripts
  // need to print progress messages to the terminal. This block
  // must come AFTER the "Additional sensible defaults" block so
  // the `no-console: off` override actually wins.
  {
    files: ['scripts/**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },

  // Prettier compatibility — MUST be last to turn off conflicting rules
  eslintConfigPrettier
);
