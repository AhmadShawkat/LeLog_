import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  COPY_LOG_BATCH_QUERY,
  UPSERT_LOG_MINUTE_AGGREGATES_QUERY,
  groupLogMinuteAggregates,
  insertLogBatch,
  serializeLogBatch,
} from './repository.js';

const entries = [
  {
    timestamp: '2026-08-11T11:00:00.000Z',
    service: 'api,"primary"',
    level: 'info' as const,
    message: 'one\nnext line',
    attributes: { attempt: 1, label: 'a,b' },
    attributesText: { attempt: '1', label: 'a,b' },
  },
  {
    timestamp: '2026-08-11T11:00:01.000Z',
    service: 'worker',
    level: 'error' as const,
    message: 'two',
    attributes: {},
    attributesText: {},
  },
];

describe('insertLogBatch', () => {
  it('serializes every value as a quoted CSV field', () => {
    expect(serializeLogBatch(entries)).toBe(
      '"2026-08-11T11:00:00.000Z","api,""primary""","info","one\nnext line","{""attempt"":1,""label"":""a,b""}","""attempt""=>""1"",""label""=>""a,b"""\n' +
        '"2026-08-11T11:00:01.000Z","worker","error","two","{}",""\n',
    );
  });

  it('groups rollups by UTC minute, service, and level', () => {
    expect(groupLogMinuteAggregates(entries)).toEqual([
      {
        bucketStart: '2026-08-11T11:00:00.000Z',
        service: 'api,"primary"',
        level: 'info',
        count: 1,
      },
      {
        bucketStart: '2026-08-11T11:00:00.000Z',
        service: 'worker',
        level: 'error',
        count: 1,
      },
    ]);
  });

  it('copies logs and upserts rollups in one transaction', async () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const query = vi.fn((statement: unknown) =>
      typeof statement === 'object' &&
      statement !== null &&
      'text' in statement &&
      (statement as { text?: string }).text === COPY_LOG_BATCH_QUERY
        ? destination
        : Promise.resolve({ rows: [] }),
    );
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release });

    await insertLogBatch({ connect } as never, entries);

    expect(connect).toHaveBeenCalledOnce();
    expect(query.mock.calls.map(([statement]) => statement)).toEqual([
      'BEGIN',
      expect.objectContaining({ text: COPY_LOG_BATCH_QUERY }),
      expect.objectContaining({
        name: 'upsert-log-minute-aggregates-v1',
        text: UPSERT_LOG_MINUTE_AGGREGATES_QUERY,
        values: [
          ['2026-08-11T11:00:00.000Z', '2026-08-11T11:00:00.000Z'],
          ['api,"primary"', 'worker'],
          ['info', 'error'],
          [1, 1],
        ],
      }),
      'COMMIT',
    ]);
    expect(chunks.join('')).toBe(serializeLogBatch(entries));
    expect(release).toHaveBeenCalledOnce();
    expect(COPY_LOG_BATCH_QUERY).toContain('FROM STDIN WITH (FORMAT CSV)');
  });

  it('releases the database client after a copy failure', async () => {
    const failure = new Error('copy failed');
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callback(failure);
      },
    });
    const release = vi.fn();
    const query = vi.fn((statement: unknown) =>
      typeof statement === 'object' &&
      statement !== null &&
      'text' in statement &&
      (statement as { text?: string }).text === COPY_LOG_BATCH_QUERY
        ? destination
        : Promise.resolve({ rows: [] }),
    );
    const connect = vi.fn().mockResolvedValue({
      query,
      release,
    });

    await expect(insertLogBatch({ connect } as never, entries)).rejects.toBe(
      failure,
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
