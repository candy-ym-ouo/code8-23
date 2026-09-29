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

async function seedTraces(bookId: string) {
  const [dogEar, annotation, rereadMark] = await Promise.all([
    prisma.dogEar.create({ data: { userId, bookId, pageNumber: 12, reason: '折角' } }),
    prisma.annotation.create({
      data: { userId, bookId, startPage: 20, endPage: 25, content: '批注内容' }
    }),
    prisma.rereadMark.create({ data: { userId, bookId, pageNumber: 100, reason: '重读' } })
  ]);
  return { dogEar, annotation, rereadMark };
}

describe('父书目删除（软删级联）', () => {
  it('删除书目时级联软删全部痕迹，并为每个对象写入 DELETED 事件', async () => {
    const book = await seedBook(client, userId, { pageCount: 200 });
    await seedTraces(book.id);

    const response = await client.request(`/api/v1/books/${book.id}`, {
      method: 'DELETE',
      cookies: [cookie],
      body: {}
    });
    expect(response.status).toBe(204);

    const [deletedBook, activeDogEars, activeAnnotations, activeRereads] = await Promise.all([
      prisma.book.findUniqueOrThrow({ where: { id: book.id } }),
      prisma.dogEar.count({ where: { bookId: book.id, deletedAt: null } }),
      prisma.annotation.count({ where: { bookId: book.id, deletedAt: null } }),
      prisma.rereadMark.count({ where: { bookId: book.id, deletedAt: null } })
    ]);
    expect(deletedBook.deletedAt).not.toBeNull();
    expect(activeDogEars + activeAnnotations + activeRereads).toBe(0);

    const events = await prisma.activityEvent.findMany({
      where: { bookId: book.id, action: 'DELETED' },
      orderBy: { entityType: 'asc' }
    });
    // 书目本身 + 折角 + 批注 + 重读标记，子事件携带 cascade: true。
    expect(events).toHaveLength(4);
    const bookEvent = events.find((event) => event.entityType === 'BOOK');
    const childEvents = events.filter((event) => event.entityType !== 'BOOK');
    expect(bookEvent).toBeTruthy();
    expect(childEvents).toHaveLength(3);
    expect(childEvents.every((event) => (event.payloadJson as { cascade?: boolean }).cascade === true)).toBe(true);
  });

  it('删除后书目在列表与详情中消失，且不能再向其添加痕迹', async () => {
    const book = await seedBook(client, userId);
    await client.request(`/api/v1/books/${book.id}`, { method: 'DELETE', cookies: [cookie], body: {} });

    const [list, detail, createTrace] = await Promise.all([
      client.request('/api/v1/books', { cookies: [cookie] }),
      client.request(`/api/v1/books/${book.id}`, { cookies: [cookie] }),
      client.request(`/api/v1/books/${book.id}/dog-ears`, {
        method: 'POST',
        cookies: [cookie],
        body: { pageNumber: 1 }
      })
    ]);
    expect((list.body as { items: unknown[] }).items).toHaveLength(0);
    expect(detail.status).toBe(404);
    expect(createTrace.status).toBe(404);
  });

  it('并发重复删除同一书目：一次成功，其余排队后返回 404，级联不重复', async () => {
    const book = await seedBook(client, userId, { pageCount: 200 });
    await seedTraces(book.id);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.request(`/api/v1/books/${book.id}`, { method: 'DELETE', cookies: [cookie], body: {} })
      )
    );
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    expect(statuses).toEqual([204, 404, 404, 404]);

    const [deletedBook, bookDeletedEvents] = await Promise.all([
      prisma.book.findUniqueOrThrow({ where: { id: book.id } }),
      prisma.activityEvent.count({ where: { bookId: book.id, entityType: 'BOOK', action: 'DELETED' } })
    ]);
    expect(deletedBook.deletedAt).not.toBeNull();
    expect(bookDeletedEvents).toBe(1);

    // 子对象只被级联软删一次（version 只递增一次）。
    const [dogEars, annotations, rereads] = await Promise.all([
      prisma.dogEar.findMany({ where: { bookId: book.id } }),
      prisma.annotation.findMany({ where: { bookId: book.id } }),
      prisma.rereadMark.findMany({ where: { bookId: book.id } })
    ]);
    expect(dogEars.every((item) => item.version === 2 && item.deletedAt !== null)).toBe(true);
    expect(annotations.every((item) => item.version === 2 && item.deletedAt !== null)).toBe(true);
    expect(rereads.every((item) => item.version === 2 && item.deletedAt !== null)).toBe(true);
  });

  it('陈旧版本号的删除请求被乐观锁拒绝', async () => {
    const book = await seedBook(client, userId);
    // 先更新一次，使 version 变为 2。
    const updated = await client.request(`/api/v1/books/${book.id}`, {
      method: 'PATCH',
      cookies: [cookie],
      body: { title: '改个名字', version: book.version }
    });
    expect(updated.status).toBe(200);

    const response = await client.request(`/api/v1/books/${book.id}`, {
      method: 'DELETE',
      cookies: [cookie],
      body: { version: 1 }
    });
    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe('STALE_WRITE');

    const stillThere = await prisma.book.findUnique({ where: { id: book.id } });
    expect(stillThere?.deletedAt).toBeNull();
  });
});

describe('24 小时恢复窗口', () => {
  it('窗口内恢复折角成功，再次恢复返回 404，窗口过期后拒绝恢复', async () => {
    const book = await seedBook(client, userId);
    const created = await client.request(`/api/v1/books/${book.id}/dog-ears`, {
      method: 'POST',
      cookies: [cookie],
      body: { pageNumber: 33 }
    });
    const dogEarId = (created.body as { dogEar: { id: string } }).dogEar.id;

    await client.request(`/api/v1/dog-ears/${dogEarId}`, { method: 'DELETE', cookies: [cookie], body: {} });

    // 23 小时后仍在窗口内。
    await prisma.dogEar.update({
      where: { id: dogEarId },
      data: { deletedAt: new Date(Date.now() - 23 * 3600 * 1000) }
    });
    const restored = await client.request(`/api/v1/dog-ears/${dogEarId}/restore`, {
      method: 'POST',
      cookies: [cookie]
    });
    expect(restored.status).toBe(200);
    expect((restored.body as { dogEar: { deletedAt: null } }).dogEar.deletedAt).toBeNull();

    const restoreAgain = await client.request(`/api/v1/dog-ears/${dogEarId}/restore`, {
      method: 'POST',
      cookies: [cookie]
    });
    expect(restoreAgain.status).toBe(404);

    // 再次删除并把删除时间拨到 25 小时前。
    await client.request(`/api/v1/dog-ears/${dogEarId}`, { method: 'DELETE', cookies: [cookie], body: {} });
    await prisma.dogEar.update({
      where: { id: dogEarId },
      data: { deletedAt: new Date(Date.now() - 25 * 3600 * 1000) }
    });
    const expired = await client.request(`/api/v1/dog-ears/${dogEarId}/restore`, {
      method: 'POST',
      cookies: [cookie]
    });
    expect(expired.status).toBe(409);
    expect((expired.body as { error: { code: string } }).error.code).toBe('RESTORE_WINDOW_EXPIRED');
  });

  it('边界：24 小时整仍在窗口内，超过 1 毫秒窗口关闭', async () => {
    const book = await seedBook(client, userId);
    const created = await client.request(`/api/v1/books/${book.id}/dog-ears`, {
      method: 'POST',
      cookies: [cookie],
      body: { pageNumber: 88 }
    });
    const dogEarId = (created.body as { dogEar: { id: string } }).dogEar.id;

    // 删除时间拨到 24 小时前减去安全余量：在请求执行时必然仍满足 <= 24h。
    await client.request(`/api/v1/dog-ears/${dogEarId}`, { method: 'DELETE', cookies: [cookie], body: {} });
    await prisma.dogEar.update({
      where: { id: dogEarId },
      data: { deletedAt: new Date(Date.now() - (24 * 3600 * 1000 - 1000)) }
    });
    const atBoundary = await client.request(`/api/v1/dog-ears/${dogEarId}/restore`, {
      method: 'POST',
      cookies: [cookie]
    });
    expect(atBoundary.status).toBe(200);

    // 重新软删并越过窗口 1 毫秒：恢复必须被拒绝。
    await client.request(`/api/v1/dog-ears/${dogEarId}`, { method: 'DELETE', cookies: [cookie], body: {} });
    await prisma.dogEar.update({
      where: { id: dogEarId },
      data: { deletedAt: new Date(Date.now() - (24 * 3600 * 1000 + 1000)) }
    });
    const pastBoundary = await client.request(`/api/v1/dog-ears/${dogEarId}/restore`, {
      method: 'POST',
      cookies: [cookie]
    });
    expect(pastBoundary.status).toBe(409);
    expect((pastBoundary.body as { error: { code: string } }).error.code).toBe('RESTORE_WINDOW_EXPIRED');
  });

  it('所属书目被删除时，痕迹恢复被 BOOK_DELETED 拒绝', async () => {
    const book = await seedBook(client, userId);
    const created = await client.request(`/api/v1/books/${book.id}/reread-marks`, {
      method: 'POST',
      cookies: [cookie],
      body: { pageNumber: 50 }
    });
    const markId = (created.body as { rereadMark: { id: string } }).rereadMark.id;
    await client.request(`/api/v1/reread-marks/${markId}`, { method: 'DELETE', cookies: [cookie], body: {} });
    // 先恢复痕迹，再整体删除书目，使痕迹随父书目级联进入已删除状态。
    await client.request(`/api/v1/reread-marks/${markId}/restore`, { method: 'POST', cookies: [cookie] });
    await client.request(`/api/v1/books/${book.id}`, { method: 'DELETE', cookies: [cookie], body: {} });

    const response = await client.request(`/api/v1/reread-marks/${markId}/restore`, {
      method: 'POST',
      cookies: [cookie]
    });
    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe('BOOK_DELETED');
  });

  it('恢复折角时若同页已有新折角则返回 DOG_EAR_EXISTS，新记录保持有效', async () => {
    const book = await seedBook(client, userId);
    const created = await client.request(`/api/v1/books/${book.id}/dog-ears`, {
      method: 'POST',
      cookies: [cookie],
      body: { pageNumber: 77 }
    });
    const oldId = (created.body as { dogEar: { id: string } }).dogEar.id;
    await client.request(`/api/v1/dog-ears/${oldId}`, { method: 'DELETE', cookies: [cookie], body: {} });
    const replacement = await client.request(`/api/v1/books/${book.id}/dog-ears`, {
      method: 'POST',
      cookies: [cookie],
      body: { pageNumber: 77, reason: '新折角' }
    });
    expect(replacement.status).toBe(201);

    const response = await client.request(`/api/v1/dog-ears/${oldId}/restore`, {
      method: 'POST',
      cookies: [cookie]
    });
    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe('DOG_EAR_EXISTS');

    const active = await prisma.dogEar.findMany({ where: { bookId: book.id, deletedAt: null } });
    expect(active).toHaveLength(1);
    expect(active[0]?.reason).toBe('新折角');
  });
});
