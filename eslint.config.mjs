import js from '@eslint/js';
import globals from 'globals';

const legacyRules = {
  // Record existing debt without forcing unrelated application changes.
  'no-unused-vars': 'warn',
  'no-case-declarations': 'warn',
  'no-empty': ['error', { allowEmptyCatch: true }],
};

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      '.vitest/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['server.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: legacyRules,
  },
  {
    files: ['public/game.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
    rules: legacyRules,
  },
];
