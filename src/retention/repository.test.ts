import { describe, expect, it, vi } from 'vitest';
import {
  DELETE_EXPIRED_LOGS_QUERY,
  deleteExpiredLogBatch,
} from './repository.js';

describe('deleteExpiredLogBatch', () => {
  it('deletes one parameterized, ordered, non-blocking batch', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ deleted: 250 }] });

    await expect(
      deleteExpiredLogBatch({ query } as never, 30, 5_000),
    ).resolves.toBe(250);

    expect(query).toHaveBeenCalledWith({
      name: 'delete-expired-logs-v2',
      text: DELETE_EXPIRED_LOGS_QUERY,
      values: [30, 5_000, 891_247_331],
    });
    expect(DELETE_EXPIRED_LOGS_QUERY).toMatch(
      /ORDER BY event_timestamp ASC, id ASC/,
    );
    expect(DELETE_EXPIRED_LOGS_QUERY).toContain('LIMIT $2');
    expect(DELETE_EXPIRED_LOGS_QUERY).toContain('FOR UPDATE SKIP LOCKED');
    expect(DELETE_EXPIRED_LOGS_QUERY).toContain('pg_try_advisory_lock($3)');
    expect(DELETE_EXPIRED_LOGS_QUERY).toContain('pg_advisory_unlock($3)');
    expect(DELETE_EXPIRED_LOGS_QUERY).toContain('updated_rollups AS');
    expect(DELETE_EXPIRED_LOGS_QUERY).toContain('removed_rollups AS');
    expect(DELETE_EXPIRED_LOGS_QUERY).toContain(
      'aggregate.count - deleted_groups.count',
    );
    expect(DELETE_EXPIRED_LOGS_QUERY).not.toContain('30');
  });

  it('treats a missing deleted count as zero', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{}] });

    await expect(
      deleteExpiredLogBatch({ query } as never, 7, 100),
    ).resolves.toBe(0);
  });
});
