import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestClient, registerUser, resetDatabase, seedBook, type TestClient } from './helpers/client.js';
import { prisma } from '../src/lib/prisma.js';

let client: TestClient;
let userId: string;
let cookie: string;

beforeAll(async () => {
  client = await createTestClient();
});

beforeEach(async () => {
  await resetDatabase();
  ({ id: userId, cookie } = await registerUser(client));
});

afterAll(async () => {
  await client.close();
});

describe('并发页码校验', () => {
  it('并发生成同页折角时至多一条生效，其余收到 409', async () => {
    const book = await seedBook(client, userId);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        client.request(`/api/v1/books/${book.id}/dog-ears`, {
          method: 'POST',
          cookies: [cookie],
          body: { pageNumber: 42 }
        })
      )
    );

    const created = responses.filter((response) => response.status === 201);
    const conflicts = responses.filter(
      (response) => response.status === 409 || (response.body as { idempotent?: boolean }).idempotent === true
    );
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(7);
    expect(
      responses
        .filter((response) => response.status === 409)
        .every((response) => (response.body as { error: { code: string } }).error.code === 'DOG_EAR_EXISTS')
    ).toBe(true);

    expect(await countActiveDogEars(book.id)).toBe(1);
  });

  it('相同请求体的并发折角创建收敛为单一有效行（幂等或冲突，不产生重复行）', async () => {
    const book = await seedBook(client, userId);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        client.request(`/api/v1/books/${book.id}/dog-ears`, {
          method: 'POST',
          cookies: [cookie],
          body: { pageNumber: 7, reason: '开头伏笔' }
        })
      )
    );

    const created = responses.filter((response) => response.status === 201);
    const settled = responses.filter(
      (response) =>
        (response.body as { idempotent?: boolean }).idempotent === true ||
        (response.body as { error?: { code?: string } })?.error?.code === 'DOG_EAR_EXISTS'
    );
    expect(created).toHaveLength(1);
    expect(settled).toHaveLength(4);
    expect(responses.every((response) => response.status < 500)).toBe(true);
    expect(await countActiveDogEars(book.id)).toBe(1);
  });

  it('并发把两条折角移动到同一页码时恰好一次更新成功', async () => {
    const book = await seedBook(client, userId, { pageCount: 100 });
    const createdDogEars = await Promise.all(
      [10, 20].map((pageNumber) =>
        client
          .request(`/api/v1/books/${book.id}/dog-ears`, {
            method: 'POST',
            cookies: [cookie],
            body: { pageNumber }
          })
          .then((response) => (response.body as { dogEar: { id: string; version: number } }).dogEar)
      )
    );

    // 两个请求都基于 version=1 更新到第 30 页：唯一索引与乐观锁共同保证只有一个成功。
    const responses = await Promise.all(
      createdDogEars.map((dogEar) =>
        client.request(`/api/v1/dog-ears/${dogEar.id}`, {
          method: 'PATCH',
          cookies: [cookie],
          body: { pageNumber: 30, version: 1 }
        })
      )
    );
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    expect(await countActiveDogEars(book.id)).toBe(2);
  });

  it('并发创建批注不会破坏页码区间合法性（起止页顺序与总页数）', async () => {
    const book = await seedBook(client, userId, { pageCount: 50 });
    const responses = await Promise.all([
      client.request(`/api/v1/books/${book.id}/annotations`, {
        method: 'POST',
        cookies: [cookie],
        body: { startPage: 30, endPage: 10, content: '区间倒置' }
      }),
      client.request(`/api/v1/books/${book.id}/annotations`, {
        method: 'POST',
        cookies: [cookie],
        body: { startPage: 49, endPage: 51, content: '超出总页数' }
      }),
      client.request(`/api/v1/books/${book.id}/annotations`, {
        method: 'POST',
        cookies: [cookie],
        body: { startPage: 0, endPage: 5, content: '页码为 0' }
      })
    ]);

    expect(responses.every((response) => response.status === 422)).toBe(true);
    expect(
      await client.request(`/api/v1/books/${book.id}/traces?type=ANNOTATION`, { cookies: [cookie] }).then(
        (response) => (response.body as { pagination: { total: number } }).pagination.total
      )
    ).toBe(0);
  });
});

describe('部分唯一索引', () => {
  it('软删除后可以在同页重新创建折角，历史行保留且不参与唯一约束', async () => {
    const book = await seedBook(client, userId);
    const created = await client.request(`/api/v1/books/${book.id}/dog-ears`, {
      method: 'POST',
      cookies: [cookie],
      body: { pageNumber: 99, reason: '第一版' }
    });
    const dogEarId = (created.body as { dogEar: { id: string } }).dogEar.id;

    const removed = await client.request(`/api/v1/dog-ears/${dogEarId}`, {
      method: 'DELETE',
      cookies: [cookie],
      body: {}
    });
    expect(removed.status).toBe(204);

    const recreated = await client.request(`/api/v1/books/${book.id}/dog-ears`, {
      method: 'POST',
      cookies: [cookie],
      body: { pageNumber: 99, reason: '第二版' }
    });
    expect(recreated.status).toBe(201);

    const rows = await prisma.dogEar.findMany({ where: { bookId: book.id }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    const firstRow = rows[0];
    const secondRow = rows[1];
    expect(firstRow).toBeDefined();
    expect(secondRow).toBeDefined();
    expect(firstRow!.deletedAt).not.toBeNull();
    expect(secondRow!.deletedAt).toBeNull();
    expect(secondRow!.reason).toBe('第二版');
  });

  it('直接绕过应用层写入重复有效行时数据库部分唯一索引予以拒绝', async () => {
    const book = await seedBook(client, userId);
    await prisma.dogEar.create({ data: { userId, bookId: book.id, pageNumber: 5 } });
    const duplicate = prisma.dogEar.create({ data: { userId, bookId: book.id, pageNumber: 5 } });
    await expect(duplicate).rejects.toMatchObject({ code: 'P2002' });

    // 两条已删除行互不冲突，验证谓词 deleted_at IS NULL。
    await prisma.dogEar.updateMany({ where: { bookId: book.id, pageNumber: 5 }, data: { deletedAt: new Date() } });
    await expect(
      prisma.dogEar.create({ data: { userId, bookId: book.id, pageNumber: 5, deletedAt: new Date() } })
    ).resolves.toBeTruthy();
  });

  it('同一完成轮次仅允许一条有效完成感受（reflections 部分唯一索引）', async () => {
    const book = await seedBook(client, userId, { status: 'READ' });
    await prisma.completionReflection.create({
      data: {
        userId,
        bookId: book.id,
        completionRound: 1,
        moodTags: ['MOVED'],
        completedAt: new Date(),
        editableUntil: new Date(Date.now() + 7 * 24 * 3600 * 1000)
      }
    });
    await expect(
      prisma.completionReflection.create({
        data: {
          userId,
          bookId: book.id,
          completionRound: 1,
          moodTags: ['CALM'],
          completedAt: new Date(),
          editableUntil: new Date(Date.now() + 7 * 24 * 3600 * 1000)
        }
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

async function countActiveDogEars(bookId: string): Promise<number> {
  return prisma.dogEar.count({ where: { bookId, deletedAt: null } });
}
