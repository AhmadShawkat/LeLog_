import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('returns immutable defaults', () => {
    const config = loadConfig({});

    expect(config).toEqual({
      HOST: '0.0.0.0',
      PORT: 8080,
      LOG_LEVEL: 'info',
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/log_service',
      DB_POOL_MAX: 20,
      DB_IDLE_TIMEOUT_MS: 30_000,
      DB_CONNECTION_TIMEOUT_MS: 5_000,
      RETENTION_DAYS: 30,
      RETENTION_INTERVAL_MS: 60_000,
      RETENTION_BATCH_SIZE: 5_000,
      RETENTION_MAX_BATCHES_PER_RUN: 10,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('parses valid custom configuration', () => {
    expect(
      loadConfig({
        HOST: '127.0.0.1',
        PORT: '65535',
        LOG_LEVEL: 'debug',
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://app:password@database:5432/logs',
        DB_POOL_MAX: '40',
        DB_IDLE_TIMEOUT_MS: '10000',
        DB_CONNECTION_TIMEOUT_MS: '2500',
        RETENTION_DAYS: '90',
        RETENTION_INTERVAL_MS: '300000',
        RETENTION_BATCH_SIZE: '10000',
        RETENTION_MAX_BATCHES_PER_RUN: '20',
      }),
    ).toEqual({
      HOST: '127.0.0.1',
      PORT: 65_535,
      LOG_LEVEL: 'debug',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://app:password@database:5432/logs',
      DB_POOL_MAX: 40,
      DB_IDLE_TIMEOUT_MS: 10_000,
      DB_CONNECTION_TIMEOUT_MS: 2_500,
      RETENTION_DAYS: 90,
      RETENTION_INTERVAL_MS: 300_000,
      RETENTION_BATCH_SIZE: 10_000,
      RETENTION_MAX_BATCHES_PER_RUN: 20,
    });
  });

  it.each(['', 'abc', '1.5', '0', '-1', '65536', ' 8080', '8080 '])(
    'rejects invalid PORT %j',
    (PORT) => {
      expect(() => loadConfig({ PORT })).toThrow(ConfigurationError);
      expect(() => loadConfig({ PORT })).toThrow(/PORT/);
    },
  );

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it.each(['', 'https://database.example/logs', 'not-a-url'])(
    'rejects invalid DATABASE_URL %j',
    (DATABASE_URL) => {
      expect(() => loadConfig({ DATABASE_URL })).toThrow(/DATABASE_URL/);
    },
  );

  it.each([
    ['DB_POOL_MAX', '0'],
    ['DB_POOL_MAX', '101'],
    ['DB_POOL_MAX', '1.5'],
    ['DB_IDLE_TIMEOUT_MS', '-1'],
    ['DB_IDLE_TIMEOUT_MS', '600001'],
    ['DB_CONNECTION_TIMEOUT_MS', '0'],
    ['DB_CONNECTION_TIMEOUT_MS', '120001'],
    ['RETENTION_DAYS', '0'],
    ['RETENTION_DAYS', '3651'],
    ['RETENTION_INTERVAL_MS', '999'],
    ['RETENTION_INTERVAL_MS', '86400001'],
    ['RETENTION_BATCH_SIZE', '0'],
    ['RETENTION_BATCH_SIZE', '50001'],
    ['RETENTION_MAX_BATCHES_PER_RUN', '0'],
    ['RETENTION_MAX_BATCHES_PER_RUN', '101'],
  ] as const)('rejects invalid %s %j', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(name));
  });

  it('does not expose unrelated environment values in validation errors', () => {
    expect(() =>
      loadConfig({ PORT: 'bad', DATABASE_PASSWORD: 'secret-value' }),
    ).toThrow(/^(?!.*secret-value).*$/s);
  });
});
