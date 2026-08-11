import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import {
  createRetentionWorker,
  type RetentionWorkerDependencies,
} from './worker.js';

const config: AppConfig = {
  HOST: '127.0.0.1',
  PORT: 8080,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost/logs',
  DB_POOL_MAX: 20,
  DB_IDLE_TIMEOUT_MS: 30_000,
  DB_CONNECTION_TIMEOUT_MS: 5_000,
  RETENTION_DAYS: 30,
  RETENTION_INTERVAL_MS: 60_000,
  RETENTION_BATCH_SIZE: 5_000,
  RETENTION_MAX_BATCHES_PER_RUN: 3,
};

function harness(deleteBatch = vi.fn().mockResolvedValue(0)) {
  const callbacks: Array<() => void> = [];
  const timers: NodeJS.Timeout[] = [];
  const dependencies: RetentionWorkerDependencies = {
    deleteBatch,
    setTimer: vi.fn((callback: () => void) => {
      callbacks.push(callback);
      const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
      timers.push(timer);
      return timer;
    }),
    clearTimer: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const worker = createRetentionWorker(
    { query: vi.fn() } as never,
    config,
    logger,
    dependencies,
  );

  return { callbacks, timers, dependencies, logger, worker };
}

describe('createRetentionWorker', () => {
  it('starts once, runs immediately, and schedules the next run', async () => {
    const { callbacks, dependencies, worker } = harness();

    worker.start();
    worker.start();
    expect(dependencies.setTimer).toHaveBeenCalledOnce();
    expect(dependencies.setTimer).toHaveBeenCalledWith(expect.any(Function), 0);

    callbacks[0]?.();
    await vi.waitFor(() =>
      expect(dependencies.deleteBatch).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() =>
      expect(dependencies.setTimer).toHaveBeenCalledTimes(2),
    );
    expect(dependencies.setTimer).toHaveBeenLastCalledWith(
      expect.any(Function),
      60_000,
    );

    await worker.stop();
  });

  it('bounds each run and reports the total deleted rows', async () => {
    const deleteBatch = vi.fn().mockResolvedValue(5_000);
    const { callbacks, logger, worker } = harness(deleteBatch);

    worker.start();
    callbacks[0]?.();
    await vi.waitFor(() => expect(deleteBatch).toHaveBeenCalledTimes(3));
    expect(logger.info).toHaveBeenCalledWith(
      { deleted: 15_000, retentionDays: 30 },
      'Expired logs deleted',
    );

    await worker.stop();
  });

  it('logs a failed run and continues scheduling', async () => {
    const failure = new Error('database unavailable');
    const { callbacks, dependencies, logger, worker } = harness(
      vi.fn().mockRejectedValue(failure),
    );

    worker.start();
    callbacks[0]?.();
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        { err: failure },
        'Log retention run failed',
      ),
    );
    await vi.waitFor(() =>
      expect(dependencies.setTimer).toHaveBeenCalledTimes(2),
    );

    await worker.stop();
  });

  it('cancels a pending run when stopped', async () => {
    const { dependencies, timers, worker } = harness();

    worker.start();
    await worker.stop();

    expect(dependencies.clearTimer).toHaveBeenCalledWith(timers[0]);
    expect(dependencies.deleteBatch).not.toHaveBeenCalled();
  });

  it('waits for an active batch and does not schedule again while stopping', async () => {
    let finishDelete: ((count: number) => void) | undefined;
    const pendingDelete = new Promise<number>((resolve) => {
      finishDelete = resolve;
    });
    const { callbacks, dependencies, worker } = harness(
      vi.fn().mockReturnValue(pendingDelete),
    );

    worker.start();
    callbacks[0]?.();
    const stopping = worker.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishDelete?.(5_000);
    await stopping;
    expect(dependencies.setTimer).toHaveBeenCalledOnce();
  });
});
