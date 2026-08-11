import { describe, expect, it, vi } from 'vitest';
import { validateLogQuery } from './query-validation.js';
import { queryLogs } from './querying.js';

const rows = [
  {
    id: '12',
    event_timestamp: new Date('2026-08-11T12:00:00.000Z'),
    service: 'api',
    level: 'info' as const,
    message: 'newer',
    attributes: { status: 200 },
  },
  {
    id: '11',
    event_timestamp: new Date('2026-08-11T12:00:00.000Z'),
    service: 'api',
    level: 'warn' as const,
    message: 'older tie',
    attributes: {},
  },
];

describe('queryLogs', () => {
  it('returns one page and an opaque cursor based on the last returned row', async () => {
    const query = vi.fn().mockResolvedValue({ rows, rowCount: 2 });
    const result = await queryLogs({ query } as never, {
      attributes: [],
      limit: 1,
    });

    expect(result.logs).toEqual([
      {
        timestamp: '2026-08-11T12:00:00.000Z',
        service: 'api',
        level: 'info',
        message: 'newer',
        attributes: { status: 200 },
      },
    ]);
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(validateLogQuery({ cursor: result.next_cursor })).toMatchObject({
      filters: {
        cursor: { timestamp: '2026-08-11T12:00:00.000Z', id: '12' },
      },
    });
  });

  it('returns a null cursor when the page is exhausted', async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: rows.slice(0, 1), rowCount: 1 });

    await expect(
      queryLogs({ query } as never, { attributes: [], limit: 100 }),
    ).resolves.toMatchObject({ next_cursor: null });
  });
});
