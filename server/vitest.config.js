// vitest.config.js — Boundary.IQ server test configuration
//
// New tests should be written as .test.js files alongside the modules they test,
// or placed in tests/ with a .test.js suffix.
// Existing standalone test scripts (tests/test_*.js) continue to work via:
//   node tests/test_headless_riddle.js
//   node tests/test_server_headless.js
//
// Run Vitest tests:
//   npm run test:unit       — runs all *.test.js files
//   npm run test:unit:watch — watch mode during development

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use Node.js environment (no jsdom — server-side tests only)
    environment: 'node',

    // Match *.test.js files in tests/ or alongside source files
    include: ['tests/**/*.test.js', 'services/**/*.test.js', 'routes/**/*.test.js'],

    // Exclude the legacy standalone scripts (not Vitest-compatible)
    exclude: ['tests/test_*.js', 'node_modules/**'],

    // Useful globals: describe, it, expect, beforeEach, afterEach
    globals: true,

    // Print full error stack traces
    reporters: ['verbose'],
  },
});
