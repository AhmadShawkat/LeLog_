import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import type { AppConfig } from '../config.js';
import { INSERT_LOG_BATCH_QUERY } from '../logs/repository.js';

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

function logsApp() {
  const pool = new Pool();
  const query = vi
    .spyOn(pool, 'query')
    .mockResolvedValue({ rowCount: 1 } as never);
  const app = buildApp(config, {
    createPool: () => pool,
    migrate: vi.fn().mockResolvedValue(undefined),
  });
  apps.push(app);

  return { app, query };
}

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: new Date(Date.now() - 1_000).toISOString(),
    service: 'api',
    level: 'info',
    message: 'request completed',
    ...overrides,
  };
}

describe('POST /logs', () => {
  it('durably inserts a valid batch before reporting it accepted', async () => {
    const { app, query } = logsApp();

    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [validEntry({ attributes: { status: 200 } }), validEntry()],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 2, rejected: [] });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      name: 'insert-log-batch-v1',
      text: INSERT_LOG_BATCH_QUERY,
    });
  });

  it('partially accepts a batch and preserves rejected array indexes', async () => {
    const { app, query } = logsApp();

    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [validEntry(), validEntry({ level: 'fatal' }), 'invalid'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 1,
      rejected: [
        {
          index: 1,
          reason: 'level must be one of debug, info, warn, or error',
        },
        { index: 2, reason: 'entry must be an object' },
      ],
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it('returns 400 and does not write when every entry is rejected', async () => {
    const { app, query } = logsApp();

    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validEntry({ message: '' })] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      accepted: 0,
      rejected: [{ index: 0, reason: 'message must be a non-empty string' }],
    });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([{}, [], { logs: [] }, { logs: [validEntry()], extra: true }])(
    'returns 400 for an invalid top-level body',
    async (payload) => {
      const { app, query } = logsApp();

      const response = await app.inject({
        method: 'POST',
        url: '/logs',
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Body must contain only a non-empty logs array',
      });
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('returns a stable 400 response for malformed JSON', async () => {
    const { app, query } = logsApp();

    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      headers: { 'content-type': 'application/json' },
      payload: '[{"message":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Malformed JSON body' });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not report acceptance when the durable insert fails', async () => {
    const { app, query } = logsApp();
    query.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validEntry()] },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal server error' });
    expect(response.body).not.toContain('database unavailable');
  });
});
