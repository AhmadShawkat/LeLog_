import { describe, expect, it, vi } from 'vitest';
import { aggregateLogs } from './aggregation.js';

describe('aggregateLogs', () => {
  it('serializes database bucket rows into the exact response shape', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          bucket_timestamp: new Date('2026-08-01T00:00:00Z'),
          group_value: 'api',
          count: '3',
        },
        {
          bucket_timestamp: '2026-08-01T00:05:00Z',
          group_value: 'worker',
          count: '2',
        },
      ],
      rowCount: 2,
    });

    await expect(
      aggregateLogs({ query } as never, {
        since: '2026-08-01T00:00:00Z',
        until: '2026-08-02T00:00:00Z',
        attributes: [],
        bucket: '5m',
        groupBy: 'service',
      }),
    ).resolves.toEqual({
      buckets: [
        {
          timestamp: '2026-08-01T00:00:00.000Z',
          count: 3,
          group: 'api',
        },
        {
          timestamp: '2026-08-01T00:05:00.000Z',
          count: 2,
          group: 'worker',
        },
      ],
    });
  });
});
