/**
 * 固定种子的“随机”调度器：
 * - mulberry32 提供可复现的伪随机序列；
 * - 每一批任务用该序列洗牌后并发派发，模拟请求到达顺序不确定；
 * - 同一种子在任意机器、任意次数运行下，派发顺序完全一致。
 */

export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export type Job<T> = () => Promise<T>;

export class DeterministicScheduler {
  constructor(private readonly rng: () => number) {}

  /** 洗牌后并发执行一批任务，返回与输入顺序对齐的结果。 */
  async runBatch<T>(jobs: Array<Job<T>>): Promise<Array<PromiseSettledResult<T>>> {
    const shuffled = shuffle(jobs.map((job, index) => ({ job, index })), this.rng);
    const outcomes = new Array<PromiseSettledResult<T>>(jobs.length);
    await Promise.all(
      shuffled.map(async ({ job, index }) => {
        try {
          outcomes[index] = { status: 'fulfilled', value: await job() };
        } catch (reason) {
          outcomes[index] = { status: 'rejected', reason };
        }
      })
    );
    return outcomes;
  }
}
