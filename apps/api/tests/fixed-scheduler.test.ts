import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestClient, registerUser, resetDatabase, seedBook, type TestClient } from './helpers/client.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * 固定种子的伪随机数生成器（mulberry32）。
 * 同一种子生成完全一致的操作计划，模拟"随机"调度但逐位可复现：
 * 无论运行多少次，操作的提交顺序与冲突分布必须相同，最终状态也相同。
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PlannedOperation {
  seq: number;
  page: number;
  phase: 'create' | 'delete' | 'restore';
  target?: 'oldest' | 'newest';
}

interface OpResult {
  seq: number;
  kind: string;
  page: number;
  status: number;
  code?: string;
}
interface FinalState {
  status: string;
  bookVersion: number;
  activeDogEarPages: number[];
  activeReflectionRounds: number[];
}

let client: TestClient;
let cookie: string;
let userId: string;

const FIXED_SEED = 20260927;

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

/**
 * 由固定种子生成确定性的操作计划，并严格按照 seq 顺序逐个提交。
 * Promise.all 的网络完成顺序由事件循环与数据库调度决定，无法复现；
 * 这里把"随机"体现在计划内容（页码、是否删除、是否恢复）上，执行顺序固定，
 * 从而既覆盖乱序冲突（计划本身交错）又保证两次运行逐位一致。
 */
async function runSeededScenario(seed: number): Promise<{ results: OpResult[]; final: FinalState }> {
  const random = mulberry32(seed);
  const book = await seedBook(client, userId, { pageCount: 500 });

  // 计划阶段：随机页码序列（含大量同页冲突）。
  const creates: PlannedOperation[] = Array.from({ length: 12 }, (_, index) => ({
    seq: index,
    page: 1 + Math.floor(random() * 6),
    phase: 'create' as const
  }));

  // 执行创建阶段（顺序提交，但页码随机 → 哪些冲突由种子决定）。
  const createResults: OpResult[] = [];
  for (const op of creates) {
    const response = await client.request(`/api/v1/books/${book.id}/dog-ears`, {
      method: 'POST',
      cookies: [cookie],
      body: { pageNumber: op.page, reason: `op-${op.seq}` }
    });
    const code = (response.body as { error?: { code?: string } }).error?.code;
    createResults.push({
      seq: op.seq,
      kind: 'create',
      page: op.page,
      status: response.status,
      ...(code ? { code } : {})
    });
  }

  // 计划删除/恢复阶段：随机挑选有效折角，再随机决定删除后是否恢复。
  const active = await prisma.dogEar.findMany({
    where: { bookId: book.id, deletedAt: null },
    orderBy: { pageNumber: 'asc' }
  });
  const laterResults: OpResult[] = [];
  let seq = creates.length;
  for (const dogEar of active) {
    if (random() >= 0.75) continue;
    const removed = await client.request(`/api/v1/dog-ears/${dogEar.id}`, {
      method: 'DELETE',
      cookies: [cookie],
      body: {}
    });
    laterResults.push({ seq: seq++, kind: 'delete', page: dogEar.pageNumber, status: removed.status });

    if (random() < 0.5) {
      const restored = await client.request(`/api/v1/dog-ears/${dogEar.id}/restore`, {
        method: 'POST',
        cookies: [cookie]
      });
      const code = (restored.body as { error?: { code?: string } }).error?.code;
      laterResults.push({
        seq: seq++,
        kind: 'restore',
        page: dogEar.pageNumber,
        status: restored.status,
        ...(code ? { code } : {})
      });
    }
  }

  const finalBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
  const [finalDogEars, reflections] = await Promise.all([
    prisma.dogEar.findMany({ where: { bookId: book.id, deletedAt: null }, orderBy: { pageNumber: 'asc' } }),
    prisma.completionReflection.findMany({ where: { bookId: book.id, deletedAt: null } })
  ]);

  return {
    results: [...createResults, ...laterResults],
    final: {
      status: finalBook.status,
      bookVersion: finalBook.version,
      activeDogEarPages: finalDogEars.map((item) => item.pageNumber),
      activeReflectionRounds: reflections.map((item) => item.completionRound)
    }
  };
}

describe('固定随机调度下的最终一致性', () => {
  it('同一种子运行两次：操作计划、冲突分布与最终状态逐位一致', async () => {
    const first = await runSeededScenario(FIXED_SEED);
    await resetDatabase();
    ({ id: userId, cookie } = await registerUser(client));
    const second = await runSeededScenario(FIXED_SEED);

    const signature = (result: OpResult) =>
      `${result.seq}:${result.kind}:${result.page}:${result.status}:${result.code ?? ''}`;
    expect(second.results.map(signature)).toEqual(first.results.map(signature));
    expect(second.final).toEqual(first.final);
  });

  it('无论随机种子如何，最终态恒满足唯一性与计数不变量', async () => {
    for (const seed of [1, 42, FIXED_SEED, 999983]) {
      const { results, final } = await runSeededScenario(seed);
      await resetDatabase();
      ({ id: userId, cookie } = await registerUser(client));

      // 不变量 1：每页至多一条有效折角（部分唯一索引兜底）。
      expect(new Set(final.activeDogEarPages).size).toBe(final.activeDogEarPages.length);

      // 不变量 2：每个页码的创建请求中，恰好一个 201，其余为 409 或 200 幂等。
      const byPage = new Map<number, number[]>();
      for (const result of results.filter((item) => item.kind === 'create')) {
        byPage.set(result.page, [...(byPage.get(result.page) ?? []), result.status]);
      }
      for (const statuses of byPage.values()) {
        expect(statuses.filter((status) => status === 201)).toHaveLength(1);
        expect(statuses.every((status) => [200, 201, 409].includes(status))).toBe(true);
      }

      // 不变量 3：删除/恢复序列中不允许出现 5xx。
      expect(results.filter((item) => item.kind !== 'create').every((item) => item.status < 500)).toBe(true);

      // 不变量 4：最终有效页集合是创建页集合的子集。
      const createdPages = new Set(results.filter((item) => item.kind === 'create').map((item) => item.page));
      expect(final.activeDogEarPages.every((page) => createdPages.has(page))).toBe(true);
    }
  });

  it('同一种子多次运行的最终状态完全相同（再跑两次确认可重复）', async () => {
    const baseline = await runSeededScenario(FIXED_SEED);
    for (const run of [1, 2]) {
      await resetDatabase();
      ({ id: userId, cookie } = await registerUser(client));
      const next = await runSeededScenario(FIXED_SEED);
      expect(next.final, `run ${run} final state differs`).toEqual(baseline.final);
    }
  });

  it('随机交错的读完标记：并发完成只有一次轮次推进，最终书目稳定在 READ', async () => {
    const random = mulberry32(FIXED_SEED);
    const book = await seedBook(client, userId, { status: 'READING' });
    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // 并发把同一书目标记为 READ（都带完成感受），行锁 + 状态机保证只有一次生效。
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        settle(Math.floor(random() * 4)).then(() =>
          client.request(`/api/v1/books/${book.id}/status`, {
            method: 'PATCH',
            cookies: [cookie],
            body: {
              status: 'READ',
              version: 1,
              reflection: { moodTags: ['MOVED', 'CALM'], text: `第 ${index} 次完成` }
            }
          })
        )
      )
    );

    const statuses = outcomes.map((response) => response.status).sort((a, b) => a - b);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.every((status) => [200, 409, 422].includes(status))).toBe(true);

    const [finalBook, reflections] = await Promise.all([
      prisma.book.findUniqueOrThrow({ where: { id: book.id } }),
      prisma.completionReflection.findMany({ where: { bookId: book.id, deletedAt: null } })
    ]);
    expect(finalBook.status).toBe('READ');
    expect(reflections).toHaveLength(1);
    expect(reflections[0]?.completionRound).toBe(1);

    // 再用同种子跑一次，最终态完全一致。
    await resetDatabase();
    ({ id: userId, cookie } = await registerUser(client));
    const book2 = await seedBook(client, userId, { status: 'READING' });
    const random2 = mulberry32(FIXED_SEED);
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        settle(Math.floor(random2() * 4)).then(() =>
          client.request(`/api/v1/books/${book2.id}/status`, {
            method: 'PATCH',
            cookies: [cookie],
            body: {
              status: 'READ',
              version: 1,
              reflection: { moodTags: ['MOVED', 'CALM'], text: `第 ${index} 次完成` }
            }
          })
        )
      )
    );
    const [finalBook2, reflections2] = await Promise.all([
      prisma.book.findUniqueOrThrow({ where: { id: book2.id } }),
      prisma.completionReflection.findMany({ where: { bookId: book2.id, deletedAt: null } })
    ]);
    expect(finalBook2.status).toBe(finalBook.status);
    expect(reflections2).toHaveLength(reflections.length);
    expect(reflections2[0]?.completionRound).toBe(reflections[0]?.completionRound);
  });
});
