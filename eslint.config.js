import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Architecture boundaries (CLAUDE.md §3.1). `core/` is pure; `ui/` may only reach
// the document through commands and read-only selectors; nothing below `ui/`
// may depend on React.
const reactImports = [
  {
    group: ['react', 'react-dom', 'react-dom/*', 'zustand', 'zustand/*'],
    message: 'Only src/ui and src/app may use React/Zustand.',
  },
];
const uiImports = [{ group: ['**/ui/**', '@/ui/**'], message: 'Lower layers must not import from src/ui.' }];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'tests/golden/__output__/**',
      'src/wasm/pkg/**',
      'src/wasm/target/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}', 'src/app/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...reactImports,
            ...uiImports,
            {
              group: ['**/engine/**', '**/io/**', '**/tools/**', '**/workers/**', '**/app/**'],
              message: 'src/core must stay pure and self-contained.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/engine/**/*.ts', 'src/io/**/*.ts', 'src/tools/**/*.ts', 'src/workers/**/*.ts', 'src/ai/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...reactImports, ...uiImports] }],
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}', '*.config.ts', 'scripts/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  prettier,
);
