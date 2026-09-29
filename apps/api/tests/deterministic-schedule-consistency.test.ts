import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiResponse } from './helpers/harness.js';
import { ApiClient, getApp, registerUser, resetDatabase } from './helpers/harness.js';
import { prisma } from '../src/lib/prisma.js';
import { createRng, DeterministicScheduler } from './helpers/scheduler.js';

interface Fingerprint {
  totalRows: number;
  activeCount: number;
  deletedCount: number;
  activePages: number[];
  sumOfVersions: number;
  eventsByAction: Record<string, number>;
}

async function loginSameUser(app: Awaited<ReturnType<typeof getApp>>, email: string, lastOctet: number): Promise<ApiClient> {
  const client = new ApiClient(app, `10.77.6.${lastOctet}`);
  const login = await client.request('POST', '/api/v1/auth/login', {
    email,
    password: 'correct horse battery staple'
  });
  expect(login.status).toBe(200);
  return client;
}

function tallyStatuses(results: Array<PromiseSettledResult<ApiResponse>>): Record<number, number> {
  const tally: Record<number, number> = {};
  for (const result of results) {
    expect(result.status).toBe('fulfilled');
    if (result.status === 'fulfilled') {
      tally[result.value.status] = (tally[result.value.status] ?? 0) + 1;
    }
  }
  return tally;
}

const status = (tally: Record<number, number>, code: number): number => tally[code] ?? 0;

/** 201 为真正建行，200 为命中已提交行的幂等返回，二者合计为“被接受”的请求数。 */
const accepted = (tally: Record<number, number>): number => status(tally, 201) + status(tally, 200);

/**
 * 用固定种子调度器驱动三个“设备端”（同一会话用户的三个并发客户端），
 * 依次执行 创建 → 移动 → 删除 → 重建 → 恢复 五个操作波次。
 * 每一波内部任务的派发顺序由种子决定，但每一波开始前的数据状态是确定的。
 */
async function runScenario(seed: number): Promise<Fingerprint> {
  const app = await getApp();
  const { client, email } = await registerUser(app, `sched-${seed}`);
  const actorA = client;
  const actorB = await loginSameUser(app, email, 11);
  const actorC = await loginSameUser(app, email, 12);

  const book = await actorA.post<{ book: { id: string } }>('/api/v1/books', {
    title: `调度收敛 ${seed}`,
    pageCount: 500
  });
  const bookId = book.body.book.id;

  const scheduler = new DeterministicScheduler(createRng(seed));

  // 波次 1：12 个页码，每页两个设备同时创建折角（24 个并发请求）
  // 两个设备带不同原因，确保重复请求走 409 而非幂等 200
  const createWave = await scheduler.runBatch(
    Array.from({ length: 12 }, (_, offset) => {
      const pageNumber = offset + 1;
      return [
        () => actorA.post(`/api/v1/books/${bookId}/dog-ears`, { pageNumber, reason: '设备 A' }),
        () => actorB.post(`/api/v1/books/${bookId}/dog-ears`, { pageNumber, reason: '设备 B' })
      ];
    }).flat()
  );
  const createTally = tallyStatuses(createWave);
  expect(status(createTally, 201)).toBe(12);
  expect(accepted(createTally) + status(createTally, 409)).toBe(24);

  // 波次 2：12 条折角同时移动到 101..112，每条由两个设备并发修改（乐观锁竞争）
  const originals = await prisma.dogEar.findMany({
    where: { bookId, deletedAt: null },
    orderBy: { pageNumber: 'asc' }
  });
  expect(originals).toHaveLength(12);
  const moveWave = await scheduler.runBatch(
    originals.flatMap((row, offset) => {
      const target = 101 + offset;
      return [
        () => actorA.patch(`/api/v1/dog-ears/${row.id}`, { pageNumber: target }),
        () => actorC.patch(`/api/v1/dog-ears/${row.id}`, { pageNumber: target })
      ];
    })
  );
  const moveTally = tallyStatuses(moveWave);
  expect(status(moveTally, 200)).toBe(12);
  expect(status(moveTally, 409)).toBe(12);
  for (const result of moveWave) {
    if (result.status === 'fulfilled' && result.value.status === 409) {
      expect((result.value.body as { error: { code: string } }).error.code).toBe('STALE_WRITE');
    }
  }

  // 波次 3：12 条折角每两条并发删除；失败方可能是乐观锁 409 或已删除 404
  const deleteWave = await scheduler.runBatch(
    originals.flatMap((row) => [
      () => actorA.delete(`/api/v1/dog-ears/${row.id}`),
      () => actorB.delete(`/api/v1/dog-ears/${row.id}`)
    ])
  );
  const deleteTally = tallyStatuses(deleteWave);
  expect(status(deleteTally, 204)).toBe(12);
  expect(status(deleteTally, 409) + status(deleteTally, 404)).toBe(12);

  // 波次 4：在 1..6 与 101..106 上重建，每页仍然双发（带不同原因以触发竞争）
  const recreatePages = [...Array.from({ length: 6 }, (_, i) => i + 1), ...Array.from({ length: 6 }, (_, i) => 101 + i)];
  const recreateWave = await scheduler.runBatch(
    recreatePages.flatMap((pageNumber) => [
      () => actorA.post(`/api/v1/books/${bookId}/dog-ears`, { pageNumber, reason: '重建 A' }),
      () => actorC.post(`/api/v1/books/${bookId}/dog-ears`, { pageNumber, reason: '重建 C' })
    ])
  );
  const recreateTally = tallyStatuses(recreateWave);
  expect(status(recreateTally, 201)).toBe(12);
  expect(accepted(recreateTally) + status(recreateTally, 409)).toBe(24);

  // 波次 5：恢复原始 12 条；101..106 与重建折角冲突，107..112 恢复成功
  const deleted = await prisma.dogEar.findMany({
    where: { bookId, deletedAt: { not: null } },
    orderBy: { pageNumber: 'asc' }
  });
  expect(deleted).toHaveLength(12);
  const restoreWave = await scheduler.runBatch(
    deleted.map((row) => () => actorA.post(`/api/v1/dog-ears/${row.id}/restore`))
  );
  const restoreTally = tallyStatuses(restoreWave);
  expect(status(restoreTally, 200)).toBe(6);
  expect(status(restoreTally, 409)).toBe(6);
  for (const result of restoreWave) {
    if (result.status === 'fulfilled' && result.value.status === 409) {
      expect((result.value.body as { error: { code: string } }).error.code).toBe('DOG_EAR_EXISTS');
    }
  }

  return fingerprint(bookId);
}

async function fingerprint(bookId: string): Promise<Fingerprint> {
  const rows = await prisma.dogEar.findMany({ where: { bookId } });
  const events = await prisma.activityEvent.findMany({ where: { bookId, entityType: 'DOG_EAR' } });
  const eventsByAction: Record<string, number> = {};
  for (const event of events) {
    eventsByAction[event.action] = (eventsByAction[event.action] ?? 0) + 1;
  }
  return {
    totalRows: rows.length,
    activeCount: rows.filter((row) => row.deletedAt === null).length,
    deletedCount: rows.filter((row) => row.deletedAt !== null).length,
    activePages: rows.filter((row) => row.deletedAt === null).map((row) => row.pageNumber).sort((a, b) => a - b),
    sumOfVersions: rows.reduce((sum, row) => sum + row.version, 0),
    eventsByAction
  };
}

const EXPECTED: Fingerprint = {
  totalRows: 24, // 12 条原始折角 + 12 条重建折角
  activeCount: 18, // 12 条重建 + 6 条恢复
  deletedCount: 6, // 101..106 上恢复冲突的原始折角
  activePages: [1, 2, 3, 4, 5, 6, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112],
  sumOfVersions: 54, // 恢复的 6×4 + 仍删除的 6×3 + 新建的 12×1
  eventsByAction: { CREATED: 24, UPDATED: 12, DELETED: 12, RESTORED: 6 }
};

describe('固定随机调度的最终一致性', () => {
  beforeAll(async () => {
    await getApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('同一种子重复执行得到完全相同的最终状态，且与理论推导一致', async () => {
    const first = await runScenario(20260927);
    const second = await runScenario(20260927);

    expect(first).toEqual(EXPECTED);
    expect(second).toEqual(EXPECTED);
    expect(first).toEqual(second);
  });

  it('换一个种子改变派发顺序，最终状态仍然收敛到同一结果', async () => {
    const otherSeed = await runScenario(987654321);
    expect(otherSeed).toEqual(EXPECTED);
  });

  it('每条折角的版本号与其事件流水严格一致，API 视图与数据库一致', async () => {
    const app = await getApp();
    const { client } = await registerUser(app, 'sched-invariants');
    const book = await client.post<{ book: { id: string } }>('/api/v1/books', {
      title: '不变量校验',
      pageCount: 500
    });
    const bookId = book.body.book.id;

    // 简化场景：创建 -> 移动 -> 删除 -> 恢复，全部走 API
    const created = await client.post<{ dogEar: { id: string } }>(`/api/v1/books/${bookId}/dog-ears`, {
      pageNumber: 1,
      reason: '初始'
    });
    const id = created.body.dogEar.id;
    expect((await client.patch(`/api/v1/dog-ears/${id}`, { pageNumber: 2 })).status).toBe(200);
    expect((await client.delete(`/api/v1/dog-ears/${id}`)).status).toBe(204);
    expect((await client.post(`/api/v1/dog-ears/${id}/restore`)).status).toBe(200);

    const row = await prisma.dogEar.findUniqueOrThrow({ where: { id } });
    const events = await prisma.activityEvent.findMany({ where: { entityId: id }, orderBy: { occurredAt: 'asc' } });
    const mutations = events.filter((event) =>
      ['UPDATED', 'DELETED', 'RESTORED'].includes(event.action)
    ).length;
    expect(row.version).toBe(1 + mutations);
    expect(events.map((event) => event.action)).toEqual(['CREATED', 'UPDATED', 'DELETED', 'RESTORED']);

    // 时间线与数据库事件数量一致
    const timeline = await client.get<{ pagination: { total: number } }>(
      `/api/v1/timeline?bookId=${bookId}&pageSize=100`
    );
    const dbEventCount = await prisma.activityEvent.count({ where: { bookId } });
    expect(timeline.body.pagination.total).toBe(dbEventCount);

    // traces API 只暴露有效折角，且页码与数据库一致
    const traces = await client.get<{ items: Array<{ id: string; pageNumber: number }> }>(
      `/api/v1/books/${bookId}/traces?pageSize=100`
    );
    const dbActive = await prisma.dogEar.findMany({
      where: { bookId, deletedAt: null },
      select: { id: true, pageNumber: true }
    });
    expect(traces.body.items).toHaveLength(dbActive.length);
    expect(
      traces.body.items.map((item) => `${item.id}:${item.pageNumber}`).sort()
    ).toEqual(dbActive.map((item) => `${item.id}:${item.pageNumber}`).sort());
  });
});
