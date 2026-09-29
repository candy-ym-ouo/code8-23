import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { ApiClient, registerUser, resetDatabase, getApp } from './helpers/harness.js';

async function setupBook(tag: string): Promise<{ client: ApiClient; userId: string; bookId: string }> {
  const app = await getApp();
  const { client, userId } = await registerUser(app, tag);
  const created = await client.post<{ book: { id: string } }>('/api/v1/books', {
    title: '并发页码',
    pageCount: 100
  });
  expect(created.status).toBe(201);
  return { client, userId, bookId: created.body.book.id };
}

describe('并发页码校验', () => {
  beforeAll(async () => {
    await getApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('同页并发创建折角恰好成功一条，其余请求被 409 拒绝', async () => {
    const { client, bookId } = await setupBook('cp-create');

    // 全部带同一个非空原因。首条落库前并发请求的 create 会在索引上排队；
    // 其中至多一个请求在阻塞后重查到刚提交的同原因行，按幂等返回 200，
    // 其余均为 409。无论调度如何，最终有效折角恰有一条。
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        client.post(`/api/v1/books/${bookId}/dog-ears`, {
          pageNumber: 42,
          reason: '并发同一原因'
        })
      )
    );

    const created = responses.filter((response) => response.status === 201);
    const idempotent = responses.filter((response) => response.status === 200);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(created).toHaveLength(1);
    expect(created.length + idempotent.length + conflicts.length).toBe(8);
    expect(idempotent.every((response) => (response.body as { idempotent: boolean }).idempotent)).toBe(true);

    const active = await prisma.dogEar.findMany({
      where: { bookId, pageNumber: 42, deletedAt: null }
    });
    expect(active).toHaveLength(1);
  });

  it('并发创建超出总页数的折角全部返回 422，不留任何记录', async () => {
    const { client, bookId } = await setupBook('cp-overrun');

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        client.post(`/api/v1/books/${bookId}/dog-ears`, { pageNumber: 101 })
      )
    );
    expect(responses.every((response) => response.status === 422)).toBe(true);
    expect(await prisma.dogEar.count({ where: { bookId } })).toBe(0);
  });

  it('两条折角并发移动到同一目标页时仅一条成功，另一条得到 409', async () => {
    const { client, bookId } = await setupBook('cp-move');

    const [first, second] = await Promise.all([
      client.post(`/api/v1/books/${bookId}/dog-ears`, { pageNumber: 1 }),
      client.post(`/api/v1/books/${bookId}/dog-ears`, { pageNumber: 2 })
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstId = (first.body as { dogEar: { id: string } }).dogEar.id;
    const secondId = (second.body as { dogEar: { id: string } }).dogEar.id;

    const responses = await Promise.all([
      client.patch(`/api/v1/dog-ears/${firstId}`, { pageNumber: 50 }),
      client.patch(`/api/v1/dog-ears/${secondId}`, { pageNumber: 50 })
    ]);
    const ok = responses.filter((response) => response.status === 200);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    // 串行执行时应用层预检给出 DOG_EAR_EXISTS；两个事务真正并发时，
    // 后提交者由部分唯一索引拦截，经错误处理器映射为 DUPLICATE_RESOURCE。
    expect(['DOG_EAR_EXISTS', 'DUPLICATE_RESOURCE']).toContain(
      (conflicts[0]!.body as { error: { code: string } }).error.code
    );

    const targetPage = await prisma.dogEar.findMany({
      where: { bookId, pageNumber: 50, deletedAt: null }
    });
    expect(targetPage).toHaveLength(1);
  });

  it('携带同一版本号并发修改单条折角，乐观锁保证只更新一次', async () => {
    const { client, bookId } = await setupBook('cp-optimistic');

    const created = await client.post(`/api/v1/books/${bookId}/dog-ears`, {
      pageNumber: 3,
      reason: '初始原因'
    });
    const dogEarId = (created.body as { dogEar: { id: string } }).dogEar.id;

    const responses = await Promise.all([
      client.patch(`/api/v1/dog-ears/${dogEarId}`, { reason: '改 A', version: 1 }),
      client.patch(`/api/v1/dog-ears/${dogEarId}`, { reason: '改 B', version: 1 })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const row = await prisma.dogEar.findUniqueOrThrow({ where: { id: dogEarId } });
    expect(row.version).toBe(2);
    expect(['改 A', '改 B']).toContain(row.reason);
  });

  it('并发跨页批注超出总页数时全部返回 422', async () => {
    const { client, bookId } = await setupBook('cp-annotation');

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.post(`/api/v1/books/${bookId}/annotations`, {
          startPage: 90,
          endPage: 120,
          content: '越界批注'
        })
      )
    );
    expect(responses.every((response) => response.status === 422)).toBe(true);
    expect(await prisma.annotation.count({ where: { bookId } })).toBe(0);
  });
});
