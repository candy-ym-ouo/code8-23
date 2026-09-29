import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

export const TEST_DB_NAME = 'paper_book_traces_test';
export const TEST_DB_PORT = 55432;
export const TEST_DATABASE_URL = `postgresql://app:app@localhost:${TEST_DB_PORT}/${TEST_DB_NAME}?schema=public`;

let pg: EmbeddedPostgres | null = null;
let dataDir = '';

export default async function setup(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'pbt-pg-'));
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'app',
    password: 'app',
    port: TEST_DB_PORT,
    persistent: true
  });
  await pg.initialise();
  await pg.start();
  // 嵌入式 postgres 作为子进程（含 stdio 管道）会一直持有事件循环；
  // unref 进程与管道，让 vitest 在 teardown 后可以正常退出。
  const child = (pg as unknown as {
    process?: { unref?: () => void; stdout?: { unref?: () => void } | null; stderr?: { unref?: () => void } | null };
  }).process;
  child?.unref?.();
  child?.stdout?.unref?.();
  child?.stderr?.unref?.();
  try {
    await pg.createDatabase(TEST_DB_NAME);
  } catch (error) {
    // 数据库可能已存在（上一次集群未被清理），忽略即可。
    if (!/already exists/i.test(String((error as Error).message))) throw error;
  }

  const prismaBin = join(here, '..', 'node_modules', 'prisma', 'build', 'index.js');
  await execFileAsync(
    process.execPath,
    [prismaBin, 'migrate', 'deploy'],
    {
      cwd: join(here, '..'),
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: 'pipe'
    } as Parameters<typeof execFileAsync>[2]
  );
}

export async function teardown(): Promise<void> {
  if (pg) {
    const instance = pg;
    // 库内部在发送 SIGINT 之后才注册 exit 监听，存在丢事件挂起的可能；
    // 加超时兜底，超时后强杀，保证全局拆卸必定结束。
    await Promise.race([
      instance.stop(),
      new Promise<void>((resolve) => setTimeout(resolve, 5000))
    ]).catch(() => undefined);
    forceKillPostgres(instance);
    pg = null;
  }
  if (dataDir && existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function forceKillPostgres(instance: EmbeddedPostgres): void {
  const child = (instance as unknown as { process?: { pid?: number; kill: (signal: string) => boolean } })
    .process;
  try {
    child?.kill('SIGKILL');
  } catch {
    // 进程已退出时忽略。
  }
}
