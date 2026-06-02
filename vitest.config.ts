import { defineConfig } from 'vitest/config';

// Root Vitest configuration. Tests are co-located with sources as
// `*.test.ts` across packages/*, services/*, and apps/*.
// Property-based tests use `fast-check` and run a minimum of 100 iterations.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/**/*.{test,spec}.ts',
      'services/**/*.{test,spec}.ts',
      'apps/**/src/**/*.{test,spec}.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.turbo/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.config.*', '**/*.test.ts'],
    },
  },
});
