import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// config/env.ts 在模块加载时读取 EXPORT_MAX_ROWS，必须在导入应用模块前收紧阈值。
process.env.EXPORT_MAX_ROWS = '20';

const { createTestClient, registerUser, resetDatabase, seedBook } = await import('./helpers/client.js');
const { prisma } = await import('../src/lib/prisma.js');
type TestClient = Awaited<ReturnType<typeof createTestClient>>;

const previousExportLimit = process.env.EXPORT_MAX_ROWS;

let client: TestClient;
let cookie: string;
let userId: string;

beforeAll(async () => {
  client = await createTestClient();
});

beforeEach(async () => {
  await resetDatabase();
  ({ id: userId, cookie } = await registerUser(client));
});

afterAll(async () => {
  process.env.EXPORT_MAX_ROWS = previousExportLimit;
  await client.close();
});

describe('导出限制 GET /api/v1/exports/me', () => {
  it('未认证请求返回 401', async () => {
    const response = await client.request('/api/v1/exports/me');
    expect(response.status).toBe(401);
  });

  it('行数不超过限制时返回完整 JSON 导出（含附件头与 schemaVersion）', async () => {
    const book = await seedBook(client, userId);
    await prisma.dogEar.create({ data: { userId, bookId: book.id, pageNumber: 10 } });

    const response = await client.request('/api/v1/exports/me', { cookies: [cookie] });
    expect(response.status).toBe(200);
    expect(String(response.headers['content-type'])).toContain('application/json');
    expect(String(response.headers['content-disposition'])).toMatch(
      /^attachment; filename="paper-book-traces-\d{4}-\d{2}-\d{2}\.json"$/
    );

    const payload = response.body as {
      schemaVersion: number;
      includeDeleted: boolean;
      user: { email: string };
      books: unknown[];
      dogEars: unknown[];
      annotations: unknown[];
      rereadMarks: unknown[];
      reflections: unknown[];
      activityEvents: unknown[];
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.includeDeleted).toBe(false);
    expect(payload.user.email).toContain('@example.com');
    expect(payload.books).toHaveLength(1);
    expect(payload.dogEars).toHaveLength(1);
  });

  it('总行数超过 20 行限制时返回 413 EXPORT_TOO_LARGE 且不返回导出体', async () => {
    const book = await seedBook(client, userId);
    // 1 本书 + 25 条折角 = 26 行，超过 20 行限制。
    await prisma.dogEar.createMany({
      data: Array.from({ length: 25 }, (_, index) => ({
        userId,
        bookId: book.id,
        pageNumber: index + 1
      }))
    });

    const response = await client.request('/api/v1/exports/me', { cookies: [cookie] });
    expect(response.status).toBe(413);
    const body = response.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('EXPORT_TOO_LARGE');
    expect(body.error.message).toContain('20');
    expect(String(response.headers['content-disposition'] ?? '')).toBe('');
  });

  it('includeDeleted=true 会把软删行计入限额；默认导出隐藏软删行', async () => {
    const book = await seedBook(client, userId);
    const pages = Array.from({ length: 19 }, (_, index) => index + 1);
    const activePage = pages[0];
    const deletedPages = pages.slice(1);
    expect(activePage).toBeDefined();
    await prisma.dogEar.create({ data: { userId, bookId: book.id, pageNumber: activePage! } });
    await prisma.dogEar.createMany({
      data: deletedPages.map((pageNumber) => ({
        userId,
        bookId: book.id,
        pageNumber,
        deletedAt: new Date()
      }))
    });
    // 此时：1 本书 + 19 条折角 = 20 行（含已删除时）。

    const withoutDeleted = await client.request('/api/v1/exports/me', { cookies: [cookie] });
    expect(withoutDeleted.status).toBe(200);
    expect((withoutDeleted.body as { dogEars: unknown[] }).dogEars).toHaveLength(1);

    const includeDeleted = await client.request('/api/v1/exports/me?includeDeleted=true', {
      cookies: [cookie]
    });
    expect(includeDeleted.status).toBe(200);
    const payload = includeDeleted.body as { includeDeleted: boolean; dogEars: unknown[] };
    expect(payload.includeDeleted).toBe(true);
    expect(payload.dogEars).toHaveLength(19);

    // 再加 1 条已删除折角：含删除时共 21 行，超过限制；不含删除时仍只有 2 行。
    await prisma.dogEar.create({
      data: { userId, bookId: book.id, pageNumber: 20, deletedAt: new Date() }
    });
    const [stillOk, rejected] = await Promise.all([
      client.request('/api/v1/exports/me', { cookies: [cookie] }),
      client.request('/api/v1/exports/me?includeDeleted=true', { cookies: [cookie] })
    ]);
    expect(stillOk.status).toBe(200);
    expect(rejected.status).toBe(413);
    expect((rejected.body as { error: { code: string } }).error.code).toBe('EXPORT_TOO_LARGE');
  });

  it('活动事件始终计入限额，即使其他实体很少', async () => {
    // 建书写 1 条 CREATED 事件；直接补到超出限制。
    const book = await seedBook(client, userId);
    await prisma.activityEvent.createMany({
      data: Array.from({ length: 25 }, (_, index) => ({
        userId,
        bookId: book.id,
        entityType: 'DOG_EAR',
        entityId: null,
        action: 'CREATED',
        payloadJson: { index }
      }))
    });
    const response = await client.request('/api/v1/exports/me', { cookies: [cookie] });
    expect(response.status).toBe(413);
  });
});
