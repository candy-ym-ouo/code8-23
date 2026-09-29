import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import { buildApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string | undefined>;
}

/** 每个 ApiClient 来自不同 IP，绕开注册接口按 IP 的速率限制。 */
export class ApiClient {
  private cookie: string | undefined;

  constructor(
    private readonly app: FastifyInstance,
    private readonly ip: string
  ) {}

  async request<T = unknown>(
    method: Method,
    url: string,
    body?: unknown,
    options: { withCookie?: boolean; cookie?: string } = {}
  ): Promise<ApiResponse<T>> {
    const useCookie = options.withCookie ?? true;
    const headers: Record<string, string> = {};
    const explicitCookie = options.cookie ?? this.cookie;
    if (useCookie && explicitCookie) headers.cookie = explicitCookie;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const injectOptions: InjectOptions = {
      method,
      url,
      headers,
      remoteAddress: this.ip,
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {})
    };
    const reply = await this.app.inject(injectOptions);

    if (!this.cookie) {
      const setCookie = reply.headers['set-cookie'];
      const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (raw) this.cookie = raw.split(';')[0];
    }

    let parsed: unknown = reply.body;
    if (reply.body && String(reply.headers['content-type'] ?? '').includes('json')) {
      try {
        parsed = JSON.parse(reply.body);
      } catch {
        parsed = reply.body;
      }
    }
    return {
      status: reply.statusCode,
      body: parsed as T,
      headers: reply.headers as Record<string, string | undefined>
    };
  }

  get<T = unknown>(url: string) {
    return this.request<T>('GET', url);
  }

  post<T = unknown>(url: string, body?: unknown) {
    return this.request<T>('POST', url, body);
  }

  patch<T = unknown>(url: string, body?: unknown) {
    return this.request<T>('PATCH', url, body);
  }

  delete<T = unknown>(url: string, body?: unknown) {
    return this.request<T>('DELETE', url, body);
  }
}

let appPromise: Promise<FastifyInstance> | undefined;

export function getApp(): Promise<FastifyInstance> {
  appPromise ??= buildApp();
  return appPromise;
}

let clientSeq = 0;

/** 注册一个全新用户并返回其已登录的客户端，邮箱全局唯一。 */
export async function registerUser(
  app: FastifyInstance,
  tag = 'it'
): Promise<{ client: ApiClient; userId: string; email: string }> {
  clientSeq += 1;
  const ip = `10.234.${Math.floor(clientSeq / 250) % 250}.${(clientSeq % 250) + 1}`;
  const client = new ApiClient(app, ip);
  const email = `trace-${tag}-${clientSeq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const response = await client.post<{ user: { id: string } }>('/api/v1/auth/register', {
    email,
    password: 'correct horse battery staple'
  });
  if (response.status !== 201) {
    throw new Error(`registerUser failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { client, userId: response.body.user.id, email };
}

const ALL_TABLES = [
  'activity_events',
  'completion_reflections',
  'reread_marks',
  'annotations',
  'dog_ears',
  'books',
  'sessions',
  'users'
] as const;

/** 清空全部业务表；测试文件串行执行，每个用例彼此隔离。 */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}
