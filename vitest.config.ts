import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Minimal config: the ONLY job here is to teach vitest the `@/` alias that
// tsconfig.json already defines for the app.
//
// Without it, any test importing an app module that uses `@/` fails with
// "Cannot find package '@/lib/...'". That forced earlier test files into
// relative imports, which is fine for scripts but wrong for app code — a
// module should not change its import style to suit the test runner.
//
// Test discovery is left at vitest's default (**/*.test.ts) so the existing
// suites are picked up exactly as before.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
