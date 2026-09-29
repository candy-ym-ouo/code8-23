/**
 * 集成测试环境变量。必须在应用模块加载之前生效：
 * src/config/env.ts 在模块首次导入时读取 process.env。
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??=
  'postgresql://app:app@127.0.0.1:5432/paper_book_traces?schema=public';
process.env.SESSION_SECRET ??= 'integration-test-session-secret-32+chars';
process.env.SESSION_TTL_DAYS ??= '30';
process.env.COOKIE_SECURE ??= 'false';
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
// 刻意压小上限，便于集成测试真实触发行数限制
process.env.EXPORT_MAX_ROWS ??= '20';
