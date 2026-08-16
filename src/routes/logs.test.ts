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
  RETENTION_DAYS: 30,
  RETENTION_INTERVAL_MS: 60_000,
  RETENTION_BATCH_SIZE: 5_000,
  RETENTION_MAX_BATCHES_PER_RUN: 10,
};

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function logsApp() {
  const pool = new Pool();
  const query = vi
    .spyOn(pool, 'query')
    .mockResolvedValue({ rowCount: 1, rows: [] } as never);
  const write = vi.fn().mockResolvedValue(undefined);
  const app = buildApp(config, {
    createPool: () => pool,
    createLogWriter: () => ({ write, close: vi.fn() }),
    migrate: vi.fn().mockResolvedValue(undefined),
    createRetention: () => ({ start: vi.fn(), stop: vi.fn() }),
  });
  apps.push(app);

  return { app, query, write };
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
    const { app, write } = logsApp();

    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [validEntry({ attributes: { status: 200 } }), validEntry()],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 2, rejected: [] });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('partially accepts a batch and preserves rejected array indexes', async () => {
    const { app, write } = logsApp();

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
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it('returns 400 and does not write when every entry is rejected', async () => {
    const { app, write } = logsApp();

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
    expect(write).not.toHaveBeenCalled();
  });

  it.each([{}, [], { logs: [] }, { logs: [validEntry()], extra: true }])(
    'returns 400 for an invalid top-level body',
    async (payload) => {
      const { app, write } = logsApp();

      const response = await app.inject({
        method: 'POST',
        url: '/logs',
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Body must contain only a non-empty logs array',
      });
      expect(write).not.toHaveBeenCalled();
    },
  );

  it('returns a stable 400 response for malformed JSON', async () => {
    const { app, write } = logsApp();

    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      headers: { 'content-type': 'application/json' },
      payload: '[{"message":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Malformed JSON body' });
    expect(write).not.toHaveBeenCalled();
  });

  it('does not report acceptance when the durable insert fails', async () => {
    const { app, write } = logsApp();
    write.mockRejectedValueOnce(new Error('database unavailable'));

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

describe('GET /logs', () => {
  it('returns filtered logs and a cursor for a non-exhausted page', async () => {
    const { app, query } = logsApp();
    query.mockResolvedValueOnce({
      rowCount: 2,
      rows: [
        {
          id: '2',
          event_timestamp: new Date('2026-08-11T12:00:00.000Z'),
          service: 'api',
          level: 'error',
          message: 'request failed',
          attributes: { region: 'west' },
        },
        {
          id: '1',
          event_timestamp: new Date('2026-08-11T11:00:00.000Z'),
          service: 'api',
          level: 'error',
          message: 'older failure',
          attributes: { region: 'west' },
        },
      ],
    } as never);

    const response = await app.inject({
      method: 'GET',
      url: '/logs?service=api&level=error&since=2026-08-01T00%3A00%3A00Z&until=2026-09-01T00%3A00%3A00Z&attr.region=west&q=failed&limit=1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      logs: [
        {
          timestamp: '2026-08-11T12:00:00.000Z',
          service: 'api',
          level: 'error',
          message: 'request failed',
          attributes: { region: 'west' },
        },
      ],
      next_cursor: expect.any(String),
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY'), [
      'api',
      'error',
      '2026-08-01T00:00:00Z',
      '2026-09-01T00:00:00Z',
      '"region"=>"west"',
      'failed',
      2,
    ]);
  });

  it.each([
    ['/logs?level=fatal', 'level must be one of'],
    ['/logs?since=yesterday', 'since must be a valid ISO 8601'],
    ['/logs?limit=1001', 'limit must be an integer'],
    ['/logs?cursor=invalid', 'cursor is malformed'],
  ])('returns { error } with 400 for %s', async (url, message) => {
    const { app, query } = logsApp();

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: expect.stringContaining(message),
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /logs/aggregate', () => {
  it('returns exact grouped buckets in database order', async () => {
    const { app, query } = logsApp();
    query.mockResolvedValueOnce({
      rowCount: 2,
      rows: [
        {
          bucket_timestamp: new Date('2026-08-11T12:00:00Z'),
          group_value: 'api',
          count: '4',
        },
        {
          bucket_timestamp: new Date('2026-08-11T12:05:00Z'),
          group_value: 'api',
          count: '2',
        },
      ],
    } as never);

    const response = await app.inject({
      method: 'GET',
      url: '/logs/aggregate?since=2026-08-11T12%3A00%3A00Z&until=2026-08-11T13%3A00%3A00Z&bucket=5m&group_by=service&service=api&attr.region=west',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      buckets: [
        {
          start: '2026-08-11T12:00:00.000Z',
          count: 4,
          group: 'api',
        },
        {
          start: '2026-08-11T12:05:00.000Z',
          count: 2,
          group: 'api',
        },
      ],
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('date_bin'), [
      'api',
      '2026-08-11T12:00:00Z',
      '2026-08-11T13:00:00Z',
      '"region"=>"west"',
      '5 minutes',
    ]);
  });

  it('returns null groups and no synthetic empty buckets', async () => {
    const { app, query } = logsApp();
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          bucket_timestamp: '2026-08-11T12:00:00Z',
          group_value: null,
          count: '1',
        },
      ],
    } as never);

    const response = await app.inject({
      method: 'GET',
      url: '/logs/aggregate?since=2026-08-11T12%3A00%3A00Z&until=2026-08-11T13%3A00%3A00Z&bucket=1h',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      buckets: [
        {
          start: '2026-08-11T12:00:00.000Z',
          count: 1,
          group: null,
        },
      ],
    });
  });

  it.each([
    [
      '/logs/aggregate?until=2026-08-11T13%3A00%3A00Z&bucket=1h',
      'since is required',
    ],
    [
      '/logs/aggregate?since=2026-08-11T12%3A00%3A00Z&until=2026-08-11T13%3A00%3A00Z&bucket=10m',
      'bucket must be one of',
    ],
    [
      '/logs/aggregate?since=2026-08-11T12%3A00%3A00Z&until=2026-08-11T13%3A00%3A00Z&bucket=1h&group_by=message',
      'group_by must be service or level',
    ],
  ])('returns { error } with 400 for %s', async (url, message) => {
    const { app, query } = logsApp();

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: expect.stringContaining(message),
    });
    expect(query).not.toHaveBeenCalled();
  });
});
