import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import type { AppConfig } from '../config.js';

const config: AppConfig = {
  HOST: '127.0.0.1',
  PORT: 8080,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/log_service',
  DB_POOL_MAX: 20,
  DB_IDLE_TIMEOUT_MS: 30_000,
  DB_CONNECTION_TIMEOUT_MS: 5_000,
};

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function healthApp(queryResult: 'success' | 'failure') {
  const pool = new Pool();
  const query = vi.spyOn(pool, 'query');

  if (queryResult === 'success') {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] } as never);
  } else {
    query.mockRejectedValue(new Error('database unavailable'));
  }

  const app = buildApp(config, {
    createPool: () => pool,
    migrate: vi.fn().mockResolvedValue(undefined),
  });
  apps.push(app);

  return { app, query };
}

describe('GET /health', () => {
  it('returns success only after a lightweight database query succeeds', async () => {
    const { app, query } = healthApp('success');

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      status: 'ok',
      database: 'reachable',
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns a stable unavailable response without leaking database errors', async () => {
    const { app } = healthApp('failure');

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      status: 'unavailable',
      database: 'unreachable',
    });
    expect(response.body).not.toContain('database unavailable');
  });

  it('does not expose an unsupported method for the health endpoint', async () => {
    const { app } = healthApp('success');

    const response = await app.inject({ method: 'POST', url: '/health' });

    expect(response.statusCode).toBe(404);
  });
});
