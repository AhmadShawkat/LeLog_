import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { createDatabasePool } from './pool.js';

const config: AppConfig = {
  HOST: '127.0.0.1',
  PORT: 8080,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app:password@database:5432/logs',
  DB_POOL_MAX: 12,
  DB_IDLE_TIMEOUT_MS: 15_000,
  DB_CONNECTION_TIMEOUT_MS: 2_000,
};

describe('createDatabasePool', () => {
  it('maps validated configuration to pg pool options without connecting', async () => {
    const pool = createDatabasePool(config);

    expect(pool.options).toMatchObject({
      connectionString: config.DATABASE_URL,
      max: 12,
      idleTimeoutMillis: 15_000,
      connectionTimeoutMillis: 2_000,
      application_name: 'log-ingestion-and-query-service',
      keepAlive: true,
    });
    expect(pool.totalCount).toBe(0);

    await pool.end();
  });
});
