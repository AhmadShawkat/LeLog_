import { describe, expect, it, vi } from 'vitest';
import { INSERT_LOG_BATCH_QUERY, insertLogBatch } from './repository.js';

describe('insertLogBatch', () => {
  it('writes a batch atomically without interpolating values into SQL', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2 });
    const entries = [
      {
        timestamp: '2026-08-11T11:00:00.000Z',
        service: "api'); DROP TABLE logs; --",
        level: 'info' as const,
        message: 'one',
        attributes: { attempt: 1 },
        attributesText: { attempt: '1' },
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

    await insertLogBatch({ query } as never, entries);

    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith({
      name: 'insert-log-batch-v1',
      text: INSERT_LOG_BATCH_QUERY,
      values: [
        [entries[0]?.timestamp, entries[1]?.timestamp],
        ["api'); DROP TABLE logs; --", 'worker'],
        ['info', 'error'],
        ['one', 'two'],
        [{ attempt: 1 }, {}],
        [{ attempt: '1' }, {}],
      ],
    });
    expect(INSERT_LOG_BATCH_QUERY).toContain('FROM UNNEST(');
    expect(INSERT_LOG_BATCH_QUERY).not.toContain('DROP TABLE');
  });
});
