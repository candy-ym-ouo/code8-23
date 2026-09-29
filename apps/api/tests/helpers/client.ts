import type { FastifyInstance } from 'fastify';
import type { Response as LightMyResponse } from 'light-my-request';
import type { BookStatus } from '@prisma/client';
import { prisma } from '../../src/lib/prisma.js';
import { buildApp } from '../../src/app.js';

export interface TestClient {
  app: FastifyInstance;
  prisma: typeof prisma;
  request: RequestFn;
  close: () => Promise<void>;
}

interface ResponseOptions {
  method?: string;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: unknown;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  cookie: string | undefined;
}

type RequestFn = (path: string, options?: ResponseOptions) => Promise<RawResponse>;

export async function createTestClient(): Promise<TestClient> {
  const app = await buildApp();
  await app.ready();

  const request: RequestFn = async (path, options = {}) => {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
      ...(options.headers ?? {})
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.cookies?.length) headers.cookie = options.cookies.join('; ');

    const response = (await app.inject({
      method: method.toUpperCase() as 'GET',
      url: path,
      headers,
      ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) })
    })) as LightMyResponse;

    let body: unknown = response.body;
    const contentType = String(response.headers['content-type'] ?? '');
    if (contentType.includes('application/json')) {
      try {
        body = response.json();
      } catch {
        body = response.body;
      }
    }
    return {
      status: response.statusCode,
      headers: response.headers as unknown as Record<string, string | string[] | undefined>,
      body,
      cookie: extractSetCookie(response.headers['set-cookie'])
    };
  };

  return {
    app,
    prisma,
    request,
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    }
  };
}

function extractSetCookie(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const cookies = Array.isArray(value) ? value : [value];
  return (
    cookies
      .map((entry) => entry.split(';')[0] ?? '')
      .find((entry) => entry.startsWith('pbt_session='))
  );
}

export async function registerUser(
  client: TestClient,
  email = `user-${Math.random().toString(36).slice(2)}@example.com`
): Promise<{ id: string; email: string; cookie: string }> {
  const response = await client.request('/api/v1/auth/register', {
    method: 'POST',
    body: { email, password: 'correct-horse-battery' }
  });
  if (response.status !== 201) {
    throw new Error(`register failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const user = (response.body as { user: { id: string; email: string } }).user;
  return { ...user, cookie: response.cookie as string };
}

export interface BookSeed {
  id: string;
  title: string;
  pageCount: number | null;
  status: BookStatus;
  version: number;
}

export async function seedBook(
  client: TestClient,
  userId: string,
  overrides: { title?: string; pageCount?: number | null; status?: BookStatus } = {}
): Promise<BookSeed> {
  const book = await client.prisma.book.create({
    data: {
      userId,
      title: overrides.title ?? `测试书 ${Math.random().toString(36).slice(2)}`,
      pageCount: overrides.pageCount === undefined ? 300 : overrides.pageCount,
      status: overrides.status ?? 'TO_READ'
    }
  });
  return {
    id: book.id,
    title: book.title,
    pageCount: book.pageCount,
    status: book.status,
    version: book.version
  };
}

/** 清空所有业务表并重置序列，保证用例之间互不干扰。 */
export async function resetDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.activityEvent.deleteMany(),
    prisma.completionReflection.deleteMany(),
    prisma.rereadMark.deleteMany(),
    prisma.annotation.deleteMany(),
    prisma.dogEar.deleteMany(),
    prisma.book.deleteMany(),
    prisma.session.deleteMany(),
    prisma.user.deleteMany()
  ]);
}
