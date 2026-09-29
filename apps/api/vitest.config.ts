import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL =
  'postgresql://app:app@localhost:55432/paper_book_traces_test?schema=public';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    fileParallelism: false,
    teardownTimeout: 15_000,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      SESSION_SECRET: 'integration-test-session-secret-at-least-32-chars',
      COOKIE_SECURE: 'false',
      WEB_ORIGIN: 'http://localhost:5173'
    }
  }
});
