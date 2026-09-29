import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { ApiClient, getApp, registerUser, resetDatabase } from './helpers/harness.js';

async function createBook(client: ApiClient, title: string): Promise<string> {
  const created = await client.post<{ book: { id: string } }>('/api/v1/books', {
    title,
    pageCount: 300
  });
  expect(created.status).toBe(201);
  return created.body.book.id;
}

describe('父书目删除', () => {
  beforeAll(async () => {
    await getApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('删除书目会级联软删除全部痕迹，并保留删除历史', async () => {
    const app = await getApp();
    const { client } = await registerUser(app, 'book-delete');
    const bookId = await createBook(client, '将被删除的书');

    // 建一批痕迹：折角、批注、重读、完成感受
    const dogEar = await client.post<{ dogEar: { id: string } }>(`/api/v1/books/${bookId}/dog-ears`, {
      pageNumber: 10,
      reason: '重要'
    });
    const annotation = await client.post<{ annotation: { id: string } }>(
      `/api/v1/books/${bookId}/annotations`,
      { startPage: 20, endPage: 25, content: '一段批注' }
    );
    const reread = await client.post<{ rereadMark: { id: string } }>(
      `/api/v1/books/${bookId}/reread-marks`,
      { pageNumber: 30, reason: '再读一遍' }
    );
    expect([dogEar.status, annotation.status, reread.status]).toEqual([201, 201, 201]);

    const toReading = await client.patch(`/api/v1/books/${bookId}/status`, { status: 'READING' });
    expect(toReading.status).toBe(200);
    const toRead = await client.patch<{ reflection: { id: string } }>(`/api/v1/books/${bookId}/status`, {
      status: 'READ',
      reflection: { moodTags: ['MOVED'], text: '读完很有感触' }
    });
    expect(toRead.status).toBe(200);
    const reflectionId = toRead.body.reflection.id;

    // 删除书目
    const deleted = await client.delete(`/api/v1/books/${bookId}`);
    expect(deleted.status).toBe(204);

    // 数据库层：书目与全部痕迹均为软删除
    const book = await prisma.book.findUniqueOrThrow({ where: { id: bookId } });
    expect(book.deletedAt).not.toBeNull();
    expect((await prisma.dogEar.findUniqueOrThrow({ where: { id: dogEar.body.dogEar.id } })).deletedAt).not.toBeNull();
    expect(
      (await prisma.annotation.findUniqueOrThrow({ where: { id: annotation.body.annotation.id } })).deletedAt
    ).not.toBeNull();
    expect(
      (await prisma.rereadMark.findUniqueOrThrow({ where: { id: reread.body.rereadMark.id } })).deletedAt
    ).not.toBeNull();
    expect(
      (await prisma.completionReflection.findUniqueOrThrow({ where: { id: reflectionId } })).deletedAt
    ).not.toBeNull();

    // API 层：书目与痕迹都不可再访问
    expect((await client.get(`/api/v1/books/${bookId}`)).status).toBe(404);
    expect((await client.get(`/api/v1/books/${bookId}/traces`)).status).toBe(404);
    expect((await client.get(`/api/v1/books/${bookId}/reflections`)).status).toBe(404);

    // 已删除的书目下不能再写入或修改痕迹
    expect(
      (await client.post(`/api/v1/books/${bookId}/dog-ears`, { pageNumber: 1 })).status
    ).toBe(404);
    expect(
      (await client.patch(`/api/v1/dog-ears/${dogEar.body.dogEar.id}`, { reason: 'x' })).status
    ).toBe(404);
    expect((await client.delete(`/api/v1/dog-ears/${dogEar.body.dogEar.id}`)).status).toBe(404);

    // 时间线不回抹：删除事件与级联事件仍然可见
    const timeline = await client.get<{ items: Array<{ entityType: string; action: string; payload: unknown }> }>(
      `/api/v1/timeline?bookId=${bookId}&pageSize=100`
    );
    expect(timeline.status).toBe(200);
    const events = timeline.body.items;
    expect(events.some((event) => event.entityType === 'BOOK' && event.action === 'DELETED')).toBe(true);
    const cascaded = events.filter(
      (event) => event.action === 'DELETED' && (event.payload as { cascade?: boolean }).cascade === true
    );
    expect(new Set(cascaded.map((event) => event.entityType))).toEqual(
      new Set(['DOG_EAR', 'ANNOTATION', 'REREAD_MARK', 'COMPLETION_REFLECTION'])
    );
    // 历史创建事件也仍在
    expect(events.some((event) => event.entityType === 'DOG_EAR' && event.action === 'CREATED')).toBe(true);

    // 删除是幂等失败：重复删除返回 404
    expect((await client.delete(`/api/v1/books/${bookId}`)).status).toBe(404);

    // 其他用户视角下该书目始终是 404
    const other = await registerUser(app, 'book-delete-other');
    expect((await other.client.get(`/api/v1/books/${bookId}`)).status).toBe(404);
    expect((await other.client.delete(`/api/v1/books/${bookId}`)).status).toBe(404);
  });

  it('书目删除后同页可重新建折角：部分唯一索引只约束未删除记录', async () => {
    const app = await getApp();
    const { client } = await registerUser(app, 'book-delete-recreate');
    const bookId = await createBook(client, '删后重建');

    const first = await client.post<{ dogEar: { id: string } }>(`/api/v1/books/${bookId}/dog-ears`, {
      pageNumber: 7
    });
    expect(first.status).toBe(201);
    expect((await client.delete(`/api/v1/books/${bookId}`)).status).toBe(204);

    const secondBookId = await createBook(client, '删后重建（新）');
    const recreated = await client.post(`/api/v1/books/${secondBookId}/dog-ears`, { pageNumber: 7 });
    expect(recreated.status).toBe(201);
  });
});
