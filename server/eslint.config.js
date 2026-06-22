import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'tests/**',
      'scripts/**',
      'temp_output/**',
      'diagnostics.db',
      'BoundaryQCDiagnostics.db',
      // Ignore one-off dev/diagnostic/test files at root level
      'check_failures.js',
      'check_failures_detail.js',
      'list_files_sorted.js',
      'list_gemini_models.js',
      'list_models.js',
      'render_jax_heights.js',
      'render_tract13.js',
      'render_user_deed.js',
      'run_all_headless_batches.js',
      'run_query.js',
      'scratch_test_extraction.js',
      'seed_drive_download_cache.js',
      'seed_sqlite_cache.js',
      'tag_files.js',
      'tail_deed_logs.js',
      'test_user_deed_sketch.js',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
      'no-console': 'off',
      'prefer-const': 'warn',
      'no-var': 'warn',
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
      // Custom overrides to prevent lint failures on existing legacy styles
      'no-empty': 'warn',
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
    },
  },
];
