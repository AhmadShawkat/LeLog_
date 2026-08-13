import type { Pool } from 'pg';
import type { ValidatedLogEntry } from './log-entry.js';
import { insertLogBatch } from './repository.js';

const defaultMaximumBatchSize = 1_000;
const defaultMaximumConcurrentBatches = 2;
const defaultFlushIntervalMs = 5;

interface PendingWrite {
  entries: readonly ValidatedLogEntry[];
  resolve(): void;
  reject(error: unknown): void;
}

export interface LogBatchWriter {
  write(entries: readonly ValidatedLogEntry[]): Promise<void>;
  close(): Promise<void>;
}

export interface LogBatchWriterOptions {
  maximumBatchSize?: number;
  maximumConcurrentBatches?: number;
  flushIntervalMs?: number;
}

export type InsertBatch = (
  pool: Pick<Pool, 'connect'>,
  entries: readonly ValidatedLogEntry[],
) => Promise<void>;

export type LogBatchWriterFactory = (
  pool: Pick<Pool, 'connect'>,
) => LogBatchWriter;

export function createLogBatchWriter(
  pool: Pick<Pool, 'connect'>,
  options: LogBatchWriterOptions = {},
  insertBatch: InsertBatch = insertLogBatch,
): LogBatchWriter {
  const maximumBatchSize = options.maximumBatchSize ?? defaultMaximumBatchSize;
  const maximumConcurrentBatches =
    options.maximumConcurrentBatches ?? defaultMaximumConcurrentBatches;
  const flushIntervalMs = options.flushIntervalMs ?? defaultFlushIntervalMs;
  if (!Number.isSafeInteger(maximumBatchSize) || maximumBatchSize < 1) {
    throw new Error('maximumBatchSize must be a positive safe integer');
  }
  if (
    !Number.isSafeInteger(maximumConcurrentBatches) ||
    maximumConcurrentBatches < 1
  ) {
    throw new Error('maximumConcurrentBatches must be a positive safe integer');
  }
  if (!Number.isSafeInteger(flushIntervalMs) || flushIntervalMs < 0) {
    throw new Error('flushIntervalMs must be a non-negative safe integer');
  }

  const queue: PendingWrite[] = [];
  let queuedEntryCount = 0;
  let accepting = true;
  let flushTimer: NodeJS.Timeout | undefined;
  const activeBatches = new Set<Promise<void>>();

  function clearFlushTimer(): void {
    if (flushTimer === undefined) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }

  function takeBatch(): PendingWrite[] {
    const batch: PendingWrite[] = [];
    let batchEntryCount = 0;

    while (queue.length > 0) {
      const next = queue[0];
      if (!next) break;
      if (
        batch.length > 0 &&
        batchEntryCount + next.entries.length > maximumBatchSize
      ) {
        break;
      }

      queue.shift();
      queuedEntryCount -= next.entries.length;
      batchEntryCount += next.entries.length;
      batch.push(next);
    }

    return batch;
  }

  async function executeBatch(writes: PendingWrite[]): Promise<void> {
    const entries = writes.flatMap((write) => write.entries);

    try {
      await insertBatch(pool, entries);
      writes.forEach((write) => write.resolve());
    } catch (error) {
      writes.forEach((write) => write.reject(error));
    }
  }

  function pump(): void {
    clearFlushTimer();

    while (queue.length > 0 && activeBatches.size < maximumConcurrentBatches) {
      const writes = takeBatch();
      const task = executeBatch(writes);
      activeBatches.add(task);
      void task.then(() => {
        activeBatches.delete(task);
        pump();
      });
    }
  }

  function scheduleFlush(): void {
    if (
      flushTimer !== undefined ||
      activeBatches.size >= maximumConcurrentBatches
    ) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      pump();
    }, flushIntervalMs);
    flushTimer.unref();
  }

  return {
    write(entries) {
      if (!accepting) {
        return Promise.reject(new Error('Log batch writer is closed'));
      }
      if (entries.length === 0) return Promise.resolve();

      const completion = new Promise<void>((resolve, reject) => {
        queue.push({ entries, resolve, reject });
        queuedEntryCount += entries.length;
      });

      if (queuedEntryCount >= maximumBatchSize) {
        clearFlushTimer();
        pump();
      } else {
        scheduleFlush();
      }

      return completion;
    },

    async close() {
      accepting = false;
      clearFlushTimer();

      pump();
      while (queue.length > 0 || activeBatches.size > 0) {
        await Promise.all([...activeBatches]);
        pump();
      }
    },
  };
}
