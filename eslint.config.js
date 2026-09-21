// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // stdout é o canal do protocolo MCP: nenhum console.* é permitido
      'no-console': 'error',
    },
  },

  // Dashboard frontend: plain browser JS served as-is.
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: globals.browser },
  },

  prettierConfig
);
