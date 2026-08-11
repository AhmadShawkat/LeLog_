import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { deleteExpiredLogBatch } from './repository.js';

export interface RetentionWorker {
  start(): void;
  stop(): Promise<void>;
}

export interface RetentionLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
}

export interface RetentionWorkerDependencies {
  deleteBatch(
    pool: Pick<Pool, 'query'>,
    retentionDays: number,
    batchSize: number,
  ): Promise<number>;
  setTimer(callback: () => void, delay: number): NodeJS.Timeout;
  clearTimer(timer: NodeJS.Timeout): void;
}

const defaultDependencies: RetentionWorkerDependencies = {
  deleteBatch: deleteExpiredLogBatch,
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
};

export type RetentionWorkerFactory = (
  pool: Pick<Pool, 'query'>,
  config: AppConfig,
  logger: RetentionLogger,
) => RetentionWorker;

export function createRetentionWorker(
  pool: Pick<Pool, 'query'>,
  config: AppConfig,
  logger: RetentionLogger,
  dependencies: RetentionWorkerDependencies = defaultDependencies,
): RetentionWorker {
  let started = false;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let activeRun: Promise<void> | undefined;

  const schedule = (delay: number): void => {
    if (stopping) {
      return;
    }

    timer = dependencies.setTimer(() => {
      timer = undefined;
      activeRun = run().finally(() => {
        activeRun = undefined;
        schedule(config.RETENTION_INTERVAL_MS);
      });
    }, delay);
    timer.unref?.();
  };

  const run = async (): Promise<void> => {
    let deleted = 0;

    try {
      for (
        let batch = 0;
        batch < config.RETENTION_MAX_BATCHES_PER_RUN && !stopping;
        batch += 1
      ) {
        const rowCount = await dependencies.deleteBatch(
          pool,
          config.RETENTION_DAYS,
          config.RETENTION_BATCH_SIZE,
        );
        deleted += rowCount;

        if (rowCount < config.RETENTION_BATCH_SIZE) {
          break;
        }
      }

      if (deleted > 0) {
        logger.info(
          { deleted, retentionDays: config.RETENTION_DAYS },
          'Expired logs deleted',
        );
      }
    } catch (error) {
      logger.warn({ err: error }, 'Log retention run failed');
    }
  };

  return {
    start(): void {
      if (started) {
        return;
      }

      started = true;
      schedule(0);
    },
    async stop(): Promise<void> {
      stopping = true;
      if (timer) {
        dependencies.clearTimer(timer);
        timer = undefined;
      }
      await activeRun;
    },
  };
}
