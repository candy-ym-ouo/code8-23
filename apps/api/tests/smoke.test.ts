import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestClient, registerUser, resetDatabase, type TestClient } from './helpers/client.js';

let client: TestClient;

beforeAll(async () => {
  client = await createTestClient();
  await resetDatabase();
});

afterAll(async () => {
  await client.close();
});

test('smoke: register and list books', async () => {
  const user = await registerUser(client);
  expect(user.id).toBeTruthy();
  const response = await client.request('/api/v1/books', { cookies: [user.cookie] });
  expect(response.status).toBe(200);
  expect((response.body as { items: unknown[] }).items).toEqual([]);
});
