import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { ApiClient, getApp, registerUser, resetDatabase } from './helpers/harness.js';

function expectUniqueViolation(error: unknown): void {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    expect(error.code).toBe('P2002');
    return;
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    expect(String(error.message)).toMatch(/23505/);
    return;
  }
  throw new Error(`期望唯一约束错误，实际得到: ${String(error)}`);
}

async function createBook(client: ApiClient, title: string, pageCount: number | null = 100): Promise<string> {
  const created = await client.post<{ book: { id: string } }>('/api/v1/books', { title, pageCount });
  expect(created.status).toBe(201);
  return created.body.book.id;
}

describe('部分唯一索引', () => {
  beforeAll(async () => {
    await getApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('数据库中存在只约束未删除行的部分唯一索引', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename IN ('dog_ears', 'completion_reflections')
        AND indexdef ILIKE '%UNIQUE%'
        AND indexdef ILIKE '%WHERE%deleted_at%IS NULL%'
    `;
    const names = indexes.map((row) => row.indexname).sort();
    expect(names).toEqual([
      'completion_reflections_book_round_active_key',
      'dog_ears_book_page_active_key'
    ]);
  });

  it('同书同页两条有效折角在数据库层直接冲突', async () => {
    const app = await getApp();
    const { userId } = await registerUser(app, 'pui-direct-conflict');
    const book = await prisma.book.create({ data: { userId, title: '直接插入' } });

    await prisma.dogEar.create({ data: { userId, bookId: book.id, pageNumber: 1 } });
    const insertSecond = prisma.dogEar.create({ data: { userId, bookId: book.id, pageNumber: 1 } });
    await expect(insertSecond).rejects.toMatchObject({ code: 'P2002' });
  });

  it('删除后同书同页可再次插入，软删除行不参与唯一性约束', async () => {
    const app = await getApp();
    const { userId } = await registerUser(app, 'pui-soft-deleted');
    const book = await prisma.book.create({ data: { userId, title: '删除后重建' } });

    const first = await prisma.dogEar.create({ data: { userId, bookId: book.id, pageNumber: 5 } });
    await prisma.dogEar.update({ where: { id: first.id }, data: { deletedAt: new Date() } });

    const second = await prisma.dogEar.create({ data: { userId, bookId: book.id, pageNumber: 5 } });
    expect(second.id).not.toBe(first.id);

    // 再多放几条已删除行，同样不冲突
    await prisma.dogEar.update({ where: { id: second.id }, data: { deletedAt: new Date() } });
    await prisma.dogEar.create({ data: { userId, bookId: book.id, pageNumber: 5 } });
    const rows = await prisma.dogEar.findMany({ where: { bookId: book.id, pageNumber: 5 } });
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.deletedAt === null)).toHaveLength(1);
  });

  it('不同书目之间相同页码互不影响', async () => {
    const app = await getApp();
    const { userId } = await registerUser(app, 'pui-multi-book');
    const bookA = await prisma.book.create({ data: { userId, title: '甲书' } });
    const bookB = await prisma.book.create({ data: { userId, title: '乙书' } });

    const [a, b] = await Promise.all([
      prisma.dogEar.create({ data: { userId, bookId: bookA.id, pageNumber: 99 } }),
      prisma.dogEar.create({ data: { userId, bookId: bookB.id, pageNumber: 99 } })
    ]);
    expect(a.bookId).not.toBe(b.bookId);
  });

  it('两条已删除折角并发恢复到同一页时，部分唯一索引保证只有一条恢复成功', async () => {
    const app = await getApp();
    const { userId } = await registerUser(app, 'pui-restore-race');
    const book = await prisma.book.create({ data: { userId, title: '恢复竞争' } });
    const deletedAt = new Date();
    const [rowA, rowB] = await Promise.all([
      prisma.dogEar.create({ data: { userId, bookId: book.id, pageNumber: 77, deletedAt } }),
      prisma.dogEar.create({ data: { userId, bookId: book.id, pageNumber: 77, deletedAt } })
    ]);

    const restore = (id: string): Promise<unknown> =>
      prisma.$transaction(async (tx) => {
        // pg_sleep 返回 void，Prisma 反序列化需要显式转换
        await tx.$queryRaw`SELECT pg_sleep(0.2)::text`;
        return tx.dogEar.update({ where: { id }, data: { deletedAt: null } });
      });

    const results = await Promise.allSettled([restore(rowA.id), restore(rowB.id)]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<unknown> => result.status === 'fulfilled'
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectUniqueViolation(rejected[0]!.reason);

    const active = await prisma.dogEar.findMany({
      where: { bookId: book.id, pageNumber: 77, deletedAt: null }
    });
    expect(active).toHaveLength(1);
  });

  it('完成感受的 (book, completion_round) 部分唯一索引只约束未删除行', async () => {
    const app = await getApp();
    const { userId } = await registerUser(app, 'pui-reflection-round');
    const book = await prisma.book.create({ data: { userId, title: '多轮读完' } });
    const base = {
      userId,
      bookId: book.id,
      completionRound: 1,
      moodTags: ['MOVED'] as ['MOVED'],
      completedAt: new Date(),
      editableUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    };

    const first = await prisma.completionReflection.create({ data: { ...base } });
    const secondInsert = prisma.completionReflection.create({ data: { ...base } });
    await expect(secondInsert).rejects.toMatchObject({ code: 'P2002' });

    await prisma.completionReflection.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    const recreated = await prisma.completionReflection.create({ data: { ...base } });
    expect(recreated.completionRound).toBe(1);
  });

  it('HTTP 层删除折角后同页重建成功，重建前的重复请求得到 409', async () => {
    const app = await getApp();
    const { client } = await registerUser(app, 'pui-http');
    const bookId = await createBook(client, 'HTTP 部分唯一');

    const first = await client.post<{ dogEar: { id: string } }>(`/api/v1/books/${bookId}/dog-ears`, {
      pageNumber: 23,
      reason: '第一次的原因'
    });
    expect(first.status).toBe(201);

    // 同页不同原因 -> 409；同页同原因则按幂等返回 200（不重复建行）
    const conflicting = await client.post(`/api/v1/books/${bookId}/dog-ears`, {
      pageNumber: 23,
      reason: '另一个原因'
    });
    expect(conflicting.status).toBe(409);
    const idempotent = await client.post(`/api/v1/books/${bookId}/dog-ears`, {
      pageNumber: 23,
      reason: '第一次的原因'
    });
    expect(idempotent.status).toBe(200);
    expect((idempotent.body as { idempotent: boolean }).idempotent).toBe(true);
    expect(await prisma.dogEar.count({ where: { bookId, pageNumber: 23 } })).toBe(1);

    expect((await client.delete(`/api/v1/dog-ears/${first.body.dogEar.id}`)).status).toBe(204);
    const recreated = await client.post(`/api/v1/books/${bookId}/dog-ears`, {
      pageNumber: 23,
      reason: '另一个原因'
    });
    expect(recreated.status).toBe(201);

    expect(
      await prisma.dogEar.count({ where: { bookId, pageNumber: 23, deletedAt: null } })
    ).toBe(1);
  });
});
