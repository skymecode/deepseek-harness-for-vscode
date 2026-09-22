import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.dsh-worktrees/**'],
  },
  {
    files: ['esbuild.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      // Soft size guardrails (warn only): files and functions are split by
      // responsibility first — a large cohesive module is acceptable — but a
      // warning flags modules worth a second look.
      'max-lines': ['warn', 800],
      'max-lines-per-function': ['warn', 200],
    },
  },
)
