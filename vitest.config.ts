import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration suites share one Postgres database and truncate tables in
    // beforeEach. Running them in parallel means one suite wipes another's
    // fixtures mid-test, so files run sequentially.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/api/server.ts'],
      /**
       * Thresholds are per-directory, not global.
       *
       * A single global number lets well-covered UI helpers mask a gap in the
       * pricing engine. These are the paths where a regression costs money,
       * breaks the law, or exposes customer data.
       */
      thresholds: {
        'src/engine/**': { statements: 90, branches: 80, functions: 90, lines: 90 },
        'src/payments/**': { statements: 70, branches: 60, functions: 70, lines: 70 },
        'src/auth/**': { statements: 80, branches: 70, functions: 80, lines: 80 },
        'src/scheduling/**': { statements: 80, branches: 70, functions: 80, lines: 80 },
        'src/promotions/**': { statements: 80, branches: 70, functions: 80, lines: 80 },
      },
    },
  },
});
