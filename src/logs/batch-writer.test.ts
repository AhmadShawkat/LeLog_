import { describe, expect, it, vi } from 'vitest';
import type { ValidatedLogEntry } from './log-entry.js';
import { createLogBatchWriter } from './batch-writer.js';

function entry(sequence: number): ValidatedLogEntry {
  return {
    timestamp: `2026-08-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    service: 'api',
    level: 'info',
    message: `event ${sequence}`,
    attributes: { sequence },
    attributesText: { sequence: String(sequence) },
  };
}

describe('createLogBatchWriter', () => {
  it('coalesces pending requests and resolves them after one durable insert', async () => {
    const inserted: ValidatedLogEntry[][] = [];
    const insertBatch = vi.fn(async (_pool, entries) => {
      inserted.push([...entries]);
    });
    const writer = createLogBatchWriter(
      {} as never,
      { maximumBatchSize: 3, flushIntervalMs: 1_000 },
      insertBatch,
    );

    const first = writer.write([entry(1)]);
    const second = writer.write([entry(2), entry(3)]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(insertBatch).toHaveBeenCalledTimes(1);
    expect(inserted[0]?.map(({ message }) => message)).toEqual([
      'event 1',
      'event 2',
      'event 3',
    ]);
    await writer.close();
  });

  it('does not split one request and rejects every request in a failed insert', async () => {
    const failure = new Error('database unavailable');
    const insertBatch = vi.fn().mockRejectedValue(failure);
    const writer = createLogBatchWriter(
      {} as never,
      { maximumBatchSize: 2, flushIntervalMs: 0 },
      insertBatch,
    );

    const oversized = writer.write([entry(1), entry(2), entry(3)]);

    await expect(oversized).rejects.toBe(failure);
    expect(insertBatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([entry(1), entry(2), entry(3)]),
    );
    await writer.close();
  });

  it('drains accepted writes during close and rejects later writes', async () => {
    const insertBatch = vi.fn().mockResolvedValue(undefined);
    const writer = createLogBatchWriter(
      {} as never,
      { flushIntervalMs: 60_000 },
      insertBatch,
    );
    const pending = writer.write([entry(1)]);

    await writer.close();

    await expect(pending).resolves.toBeUndefined();
    await expect(writer.write([entry(2)])).rejects.toThrow('closed');
    expect(insertBatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ maximumBatchSize: 0 }, 'maximumBatchSize'],
    [{ maximumBatchSize: 1.5 }, 'maximumBatchSize'],
    [{ maximumConcurrentBatches: 0 }, 'maximumConcurrentBatches'],
    [{ flushIntervalMs: -1 }, 'flushIntervalMs'],
  ])('rejects invalid options %j', (options, message) => {
    expect(() => createLogBatchWriter({} as never, options)).toThrow(message);
  });
});
