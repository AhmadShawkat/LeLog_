import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  COPY_LOG_BATCH_QUERY,
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

  it('copies a batch atomically and releases the database client', async () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const query = vi.fn().mockReturnValue(destination);
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release });

    await insertLogBatch({ connect } as never, entries);

    expect(connect).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      text: COPY_LOG_BATCH_QUERY,
    });
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
    const connect = vi.fn().mockResolvedValue({
      query: vi.fn().mockReturnValue(destination),
      release,
    });

    await expect(insertLogBatch({ connect } as never, entries)).rejects.toBe(
      failure,
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
