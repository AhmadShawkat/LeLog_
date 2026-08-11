import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from './config.js';
import { startServer, type ServerInstance } from './start.js';

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

function fakeServer(
  listen: ServerInstance['listen'] = vi.fn().mockResolvedValue('address'),
  close: ServerInstance['close'] = vi.fn().mockResolvedValue(undefined),
): ServerInstance {
  return { listen, close };
}

describe('startServer', () => {
  it('starts on the configured host and port', async () => {
    const app = fakeServer();

    await expect(startServer(config, () => app)).resolves.toBe(app);
    expect(app.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 8080 });
    expect(app.close).not.toHaveBeenCalled();
  });

  it('closes a partially started app when listen fails', async () => {
    const startupError = new Error('address in use');
    const app = fakeServer(vi.fn().mockRejectedValue(startupError));

    await expect(startServer(config, () => app)).rejects.toBe(startupError);
    expect(app.close).toHaveBeenCalledOnce();
  });

  it('reports startup and cleanup failures together', async () => {
    const startupError = new Error('listen failed');
    const closeError = new Error('close failed');
    const app = fakeServer(
      vi.fn().mockRejectedValue(startupError),
      vi.fn().mockRejectedValue(closeError),
    );

    const failure = await startServer(config, () => app).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      startupError,
      closeError,
    ]);
  });
});
