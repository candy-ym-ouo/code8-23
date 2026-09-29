import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // 所有测试文件共享同一个 PostgreSQL，单 fork 串行执行，避免相互清库
    setupFiles: ['./tests/helpers/env.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true }
    },
    hookTimeout: 30_000,
    testTimeout: 30_000
  }
});
