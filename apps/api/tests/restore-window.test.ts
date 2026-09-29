import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { ApiClient, getApp, registerUser, resetDatabase } from './helpers/harness.js';

const HOUR = 60 * 60 * 1000;

async function setupBookWithDogEar(
  tag: string
): Promise<{ client: ApiClient; bookId: string; dogEarId: string }> {
  const app = await getApp();
  const { client } = await registerUser(app, tag);
  const book = await client.post<{ book: { id: string } }>('/api/v1/books', {
    title: '恢复窗口',
    pageCount: 300
  });
  const dogEar = await client.post<{ dogEar: { id: string } }>(
    `/api/v1/books/${book.body.book.id}/dog-ears`,
    { pageNumber: 12, reason: '待删除' }
  );
  expect(dogEar.status).toBe(201);
  return { client, bookId: book.body.book.id, dogEarId: dogEar.body.dogEar.id };
}

async function deleteDogEar(client: ApiClient, dogEarId: string): Promise<void> {
  const response = await client.delete(`/api/v1/dog-ears/${dogEarId}`);
  expect(response.status).toBe(204);
}

async function backdateDeletion(dogEarId: string, deletedAt: Date): Promise<void> {
  await prisma.dogEar.update({ where: { id: dogEarId }, data: { deletedAt } });
}

describe('恢复窗口', () => {
  beforeAll(async () => {
    await getApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('窗口内删除的折角可以恢复，并记录 RESTORED 事件', async () => {
    const { client, bookId, dogEarId } = await setupBookWithDogEar('rw-open');
    await deleteDogEar(client, dogEarId);

    const restored = await client.post<{ dogEar: { id: string; version: number } }>(
      `/api/v1/dog-ears/${dogEarId}/restore`
    );
    expect(restored.status).toBe(200);
    expect(restored.body.dogEar.id).toBe(dogEarId);
    expect(restored.body.dogEar.version).toBe(3);

    const row = await prisma.dogEar.findUniqueOrThrow({ where: { id: dogEarId } });
    expect(row.deletedAt).toBeNull();

    const events = await prisma.activityEvent.findMany({
      where: { entityType: 'DOG_EAR', entityId: dogEarId },
      orderBy: { occurredAt: 'asc' }
    });
    expect(events.map((event) => event.action)).toEqual(['CREATED', 'DELETED', 'RESTORED']);

    const traces = await client.get<{ items: Array<{ id: string }> }>(`/api/v1/books/${bookId}/traces`);
    expect(traces.body.items.some((item) => item.id === dogEarId)).toBe(true);
  });

  it('删除时间恰在 24 小时边界内仍可恢复', async () => {
    const { client, dogEarId } = await setupBookWithDogEar('rw-boundary');
    await deleteDogEar(client, dogEarId);
    // 预留 5 秒执行余量，避免时钟抖动导致用例不稳定
    await backdateDeletion(dogEarId, new Date(Date.now() - 24 * HOUR + 5_000));

    const restored = await client.post(`/api/v1/dog-ears/${dogEarId}/restore`);
    expect(restored.status).toBe(200);
  });

  it('超过 24 小时恢复窗口的折角返回 409 RESTORE_WINDOW_EXPIRED', async () => {
    const { client, bookId, dogEarId } = await setupBookWithDogEar('rw-expired');
    await deleteDogEar(client, dogEarId);
    await backdateDeletion(dogEarId, new Date(Date.now() - 24 * HOUR - 5_000));

    const restored = await client.post<{ error: { code: string } }>(
      `/api/v1/dog-ears/${dogEarId}/restore`
    );
    expect(restored.status).toBe(409);
    expect(restored.body.error.code).toBe('RESTORE_WINDOW_EXPIRED');

    const row = await prisma.dogEar.findUniqueOrThrow({ where: { id: dogEarId } });
    expect(row.deletedAt).not.toBeNull();
    const traces = await client.get<{ items: Array<{ id: string }> }>(`/api/v1/books/${bookId}/traces`);
    expect(traces.body.items.some((item) => item.id === dogEarId)).toBe(false);
  });

  it('批注与重读记录同样受 24 小时恢复窗口约束', async () => {
    const app = await getApp();
    const { client } = await registerUser(app, 'rw-other-types');
    const book = await client.post<{ book: { id: string } }>('/api/v1/books', {
      title: '窗口通用性',
      pageCount: 300
    });
    const bookId = book.body.book.id;
    const annotation = await client.post<{ annotation: { id: string } }>(
      `/api/v1/books/${bookId}/annotations`,
      { startPage: 1, endPage: 3, content: '批注内容' }
    );
    const reread = await client.post<{ rereadMark: { id: string } }>(
      `/api/v1/books/${bookId}/reread-marks`,
      { pageNumber: 5 }
    );
    const annotationId = annotation.body.annotation.id;
    const rereadId = reread.body.rereadMark.id;
    expect((await client.delete(`/api/v1/annotations/${annotationId}`)).status).toBe(204);
    expect((await client.delete(`/api/v1/reread-marks/${rereadId}`)).status).toBe(204);

    // 批注在窗口内可恢复
    const annotationRestore = await client.post(`/api/v1/annotations/${annotationId}/restore`);
    expect(annotationRestore.status).toBe(200);

    // 重读记录过期后不可恢复
    await prisma.rereadMark.update({
      where: { id: rereadId },
      data: { deletedAt: new Date(Date.now() - 25 * HOUR) }
    });
    const rereadRestore = await client.post<{ error: { code: string } }>(
      `/api/v1/reread-marks/${rereadId}/restore`
    );
    expect(rereadRestore.status).toBe(409);
    expect(rereadRestore.body.error.code).toBe('RESTORE_WINDOW_EXPIRED');
  });

  it('恢复与目标页已有折角冲突时返回 409 DOG_EAR_EXISTS', async () => {
    const { client, bookId, dogEarId } = await setupBookWithDogEar('rw-duplicate');
    await deleteDogEar(client, dogEarId);

    const replacement = await client.post(`/api/v1/books/${bookId}/dog-ears`, {
      pageNumber: 12,
      reason: '同页新折角'
    });
    expect(replacement.status).toBe(201);

    const restored = await client.post<{ error: { code: string } }>(
      `/api/v1/dog-ears/${dogEarId}/restore`
    );
    expect(restored.status).toBe(409);
    expect(restored.body.error.code).toBe('DOG_EAR_EXISTS');
    expect((await prisma.dogEar.findUniqueOrThrow({ where: { id: dogEarId } })).deletedAt).not.toBeNull();
  });

  it('所属书目已删除时恢复返回 409 BOOK_DELETED', async () => {
    const { client, bookId, dogEarId } = await setupBookWithDogEar('rw-book-deleted');
    await deleteDogEar(client, dogEarId);
    expect((await client.delete(`/api/v1/books/${bookId}`)).status).toBe(204);

    const restored = await client.post<{ error: { code: string } }>(
      `/api/v1/dog-ears/${dogEarId}/restore`
    );
    expect(restored.status).toBe(409);
    expect(restored.body.error.code).toBe('BOOK_DELETED');
  });

  it('其他用户无法恢复不属于自己的折角', async () => {
    const app = await getApp();
    const { client, dogEarId } = await setupBookWithDogEar('rw-foreign');
    await deleteDogEar(client, dogEarId);

    const { client: stranger } = await registerUser(app, 'rw-foreign-other');
    const restored = await stranger.post(`/api/v1/dog-ears/${dogEarId}/restore`);
    expect(restored.status).toBe(404);
    expect((await prisma.dogEar.findUniqueOrThrow({ where: { id: dogEarId } })).deletedAt).not.toBeNull();
  });
});
