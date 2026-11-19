import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'packages/db/migrations/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    files: ['apps/web/public/**/*.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        URL: 'readonly',
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
      },
    },
  },
  {
    files: ['scripts/e2e.mjs'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        EventSource: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    files: ['scripts/m6c/**/*.mjs'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        Notification: 'readonly',
        MessageEvent: 'readonly',
        localStorage: 'readonly',
      },
    },
  },
  {
    files: ['scripts/m4ux/e2e.mjs', 'scripts/m4ux/runtime-evidence.mjs'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  prettier,
);
