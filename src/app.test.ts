import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { buildApp, type AppDependencies } from './app.js';
import type { AppConfig } from './config.js';

const silentConfig: AppConfig = {
  HOST: '127.0.0.1',
  PORT: 8080,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/log_service',
  DB_POOL_MAX: 20,
  DB_IDLE_TIMEOUT_MS: 30_000,
  DB_CONNECTION_TIMEOUT_MS: 5_000,
};

function testDependencies(): {
  dependencies: AppDependencies;
  pool: Pool;
  migrate: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.spyOn>;
} {
  const pool = new Pool();
  const end = vi.spyOn(pool, 'end').mockResolvedValue(undefined);
  const migrate = vi.fn().mockResolvedValue(undefined);

  return {
    dependencies: { createPool: () => pool, migrate },
    pool,
    migrate,
    end,
  };
}

describe('buildApp', () => {
  it('returns a Fastify instance without opening a listener', async () => {
    const { dependencies } = testDependencies();
    const app = buildApp(silentConfig, dependencies);

    expect(typeof app.addHook).toBe('function');
    expect(app.server.listening).toBe(false);

    await app.close();
  });

  it('uses the configured log level', async () => {
    const { dependencies } = testDependencies();
    const app = buildApp({ ...silentConfig, LOG_LEVEL: 'fatal' }, dependencies);

    expect(app.log.level).toBe('fatal');

    await app.close();
  });

  it('owns one pool, migrates before readiness, and closes the pool', async () => {
    const { dependencies, pool, migrate, end } = testDependencies();
    const app = buildApp(silentConfig, dependencies);

    expect(app.db).toBe(pool);

    await app.ready();
    expect(migrate).toHaveBeenCalledOnce();
    expect(migrate).toHaveBeenCalledWith(pool);

    await app.close();
    expect(end).toHaveBeenCalledOnce();
  });

  it('does not become ready until migrations finish', async () => {
    let finishMigration: (() => void) | undefined;
    const migrationPending = new Promise<void>((resolve) => {
      finishMigration = resolve;
    });
    const { dependencies, migrate } = testDependencies();
    migrate.mockReturnValue(migrationPending);
    const app = buildApp(silentConfig, dependencies);
    let becameReady = false;

    const readiness = app.ready().then(() => {
      becameReady = true;
    });
    await vi.waitFor(() => expect(migrate).toHaveBeenCalledOnce());

    expect(becameReady).toBe(false);
    finishMigration?.();
    await readiness;
    expect(becameReady).toBe(true);

    await app.close();
  });

  it('closes its pool when migration fails', async () => {
    const pool = new Pool();
    const end = vi.spyOn(pool, 'end').mockResolvedValue(undefined);
    const app = buildApp(silentConfig, {
      createPool: () => pool,
      migrate: vi.fn().mockRejectedValue(new Error('migration failed')),
    });

    await expect(app.ready()).rejects.toThrow('migration failed');
    await app.close();
    expect(end).toHaveBeenCalledOnce();
  });
});
