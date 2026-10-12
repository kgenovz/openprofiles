import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/', 'data-dev/', 'data-dev-pre-m6/', 'data-backups/', 'art-preview/', '.claude/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['src/web/static/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
];
