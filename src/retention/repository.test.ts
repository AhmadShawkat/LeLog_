import { describe, expect, it, vi } from 'vitest';
import {
  DELETE_EXPIRED_LOGS_QUERY,
  deleteExpiredLogBatch,
} from './repository.js';

describe('deleteExpiredLogBatch', () => {
  it('deletes one parameterized, ordered, non-blocking batch', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 250 });

    await expect(
      deleteExpiredLogBatch({ query } as never, 30, 5_000),
    ).resolves.toBe(250);

    expect(query).toHaveBeenCalledWith({
      name: 'delete-expired-logs-v1',
      text: DELETE_EXPIRED_LOGS_QUERY,
      values: [30, 5_000],
    });
    expect(DELETE_EXPIRED_LOGS_QUERY).toMatch(
      /ORDER BY event_timestamp ASC, id ASC/,
    );
    expect(DELETE_EXPIRED_LOGS_QUERY).toContain('LIMIT $2');
    expect(DELETE_EXPIRED_LOGS_QUERY).toContain('FOR UPDATE SKIP LOCKED');
    expect(DELETE_EXPIRED_LOGS_QUERY).not.toContain('30');
  });

  it('treats a missing row count as zero', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: null });

    await expect(
      deleteExpiredLogBatch({ query } as never, 7, 100),
    ).resolves.toBe(0);
  });
});
