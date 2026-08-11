import { Pool } from 'pg';
import type { AppConfig } from '../config.js';

export type PoolFactory = (config: AppConfig) => Pool;

export function createDatabasePool(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    application_name: 'log-ingestion-and-query-service',
    keepAlive: true,
  });
}
