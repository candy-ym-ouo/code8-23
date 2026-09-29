import type { FastifyInstance } from 'fastify';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { ApiClient, getApp, registerUser, resetDatabase } from './helpers/harness.js';

interface ExportPayload {
  schemaVersion: number;
  exportedAt: string;
  includeDeleted: boolean;
  user: { id: string; email: string; createdAt: string; updatedAt: string };
  books: unknown[];
  dogEars: unknown[];
  annotations: unknown[];
  rereadMarks: unknown[];
  reflections: unknown[];
  activityEvents: unknown[];
}

/** 直接用 prisma 准备数据的用例没有会话 cookie，通过登录取得该用户的客户端。 */
class OwnerClient {
  private client?: ApiClient;
  private ipOctet = 1;

  constructor(
    private readonly app: FastifyInstance,
    private readonly userId: string
  ) {}

  private async ensure(): Promise<ApiClient> {
    if (this.client) return this.client;
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: this.userId } })).email;
    const client = new ApiClient(this.app, `10.55.12.${this.ipOctet++}`);
    const login = await client.request('POST', '/api/v1/auth/login', {
      email,
      password: 'correct horse battery staple'
    });
    expect(login.status).toBe(200);
    this.client = client;
    return client;
  }

  async fetchExports(includeDeleted?: boolean) {
    const client = await this.ensure();
    const suffix = includeDeleted === undefined ? '' : `?includeDeleted=${includeDeleted}`;
    return client.request('GET', `/api/v1/exports/me${suffix}`);
  }
}

describe('导出限制', () => {
  beforeAll(async () => {
    await getApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('未认证请求不能导出档案', async () => {
    const app = await getApp();
    const { client } = await registerUser(app, 'export-anon');
    const response = await client.request('GET', '/api/v1/exports/me', undefined, { withCookie: false });
    expect(response.status).toBe(401);
    expect(response.body).not.toHaveProperty('books');
  });

  it('正常导出包含档案结构、不含密码与会话字段，并作为附件下载', async () => {
    const app = await getApp();
    const { client, userId } = await registerUser(app, 'export-happy');

    const book = await client.post<{ book: { id: string } }>('/api/v1/books', {
      title: '可导出的书',
      pageCount: 200
    });
    expect(book.status).toBe(201);
    const dogEar = await client.post(`/api/v1/books/${book.body.book.id}/dog-ears`, {
      pageNumber: 8,
      reason: '折角原因'
    });
    expect(dogEar.status).toBe(201);

    const response = await client.request('GET', '/api/v1/exports/me');
    expect(response.status).toBe(200);
    expect(String(response.headers['content-type'])).toContain('application/json');
    expect(String(response.headers['content-disposition'])).toMatch(
      /^attachment; filename="paper-book-traces-\d{4}-\d{2}-\d{2}\.json"$/
    );

    const payload = response.body as ExportPayload;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.includeDeleted).toBe(false);
    expect(new Date(payload.exportedAt).toString()).not.toBe('Invalid Date');
    expect(payload.user.id).toBe(userId);
    expect(payload.user).not.toHaveProperty('passwordHash');
    expect(payload).not.toHaveProperty('sessions');
    expect(payload.books).toHaveLength(1);
    expect(payload.dogEars).toHaveLength(1);
    expect(payload.activityEvents.length).toBeGreaterThan(0);

    const raw = JSON.stringify(payload);
    expect(raw).not.toMatch(/passwordHash|token_hash|tokenHash/i);
  });

  it('总行数超过 EXPORT_MAX_ROWS 时返回 413 EXPORT_TOO_LARGE 且不返回数据', async () => {
    const app = await getApp();
    const { userId } = await registerUser(app, 'export-too-large');
    const book = await prisma.book.create({ data: { userId, title: '超限之书' } });

    // 1 本书 + 16 条折角 + 16 个事件 = 33 行，超过上限 20
    await prisma.dogEar.createMany({
      data: Array.from({ length: 16 }, (_, index) => ({
        userId,
        bookId: book.id,
        pageNumber: index + 1
      }))
    });
    await prisma.activityEvent.createMany({
      data: Array.from({ length: 16 }, (_, index) => ({
        userId,
        bookId: book.id,
        entityType: 'DOG_EAR' as const,
        entityId: null,
        action: 'CREATED' as const,
        payloadJson: { seeded: true, index }
      }))
    });

    const owner = new OwnerClient(app, userId);
    const response = await owner.fetchExports();
    expect(response.status).toBe(413);
    expect((response.body as { error: { code: string; message: string } }).error.code).toBe(
      'EXPORT_TOO_LARGE'
    );
    expect((response.body as { error: { message: string } }).error.message).toContain('20');
    expect(response.body).not.toHaveProperty('books');
  });

  it('默认导出排除已删除行，includeDeleted=true 会把已删除行计入上限', async () => {
    const app = await getApp();
    const { userId } = await registerUser(app, 'export-deleted');
    const book = await prisma.book.create({ data: { userId, title: '部分删除' } });
    const owner = new OwnerClient(app, userId);

    // 1 本书 + 9 条有效折角 + 9 个事件 = 19 行（未超限）
    await prisma.dogEar.createMany({
      data: Array.from({ length: 9 }, (_, index) => ({
        userId,
        bookId: book.id,
        pageNumber: index + 1
      }))
    });
    await prisma.activityEvent.createMany({
      data: Array.from({ length: 9 }, (_, index) => ({
        userId,
        bookId: book.id,
        entityType: 'DOG_EAR' as const,
        entityId: null,
        action: 'CREATED' as const,
        payloadJson: { index }
      }))
    });

    const withinLimit = await owner.fetchExports(false);
    expect(withinLimit.status).toBe(200);
    expect((withinLimit.body as ExportPayload).includeDeleted).toBe(false);

    // 追加 2 条已删除折角（不增加事件）：含删除总行数变为 21，触发 413；默认仍为 19
    await prisma.dogEar.createMany({
      data: [
        { userId, bookId: book.id, pageNumber: 201, deletedAt: new Date() },
        { userId, bookId: book.id, pageNumber: 202, deletedAt: new Date() }
      ]
    });
    const includingDeleted = await owner.fetchExports(true);
    expect(includingDeleted.status).toBe(413);
    expect((includingDeleted.body as { error: { code: string } }).error.code).toBe('EXPORT_TOO_LARGE');

    const stillDefault = await owner.fetchExports(false);
    expect(stillDefault.status).toBe(200);
    expect((stillDefault.body as ExportPayload).dogEars).toHaveLength(9);
  });

  it('导出严格按 userId 隔离，不包含其他用户的数据', async () => {
    const app = await getApp();
    const { client } = await registerUser(app, 'export-isolation-a');
    const other = await registerUser(app, 'export-isolation-b');

    await other.client.post('/api/v1/books', { title: '别人的书' });
    await client.post('/api/v1/books', { title: '我的书' });

    const response = await client.request('GET', '/api/v1/exports/me');
    expect(response.status).toBe(200);
    const payload = response.body as ExportPayload;
    expect(payload.books).toHaveLength(1);
    expect((payload.books[0] as { title: string }).title).toBe('我的书');
    expect(payload.user.email).not.toContain('isolation-b');
  });
});
