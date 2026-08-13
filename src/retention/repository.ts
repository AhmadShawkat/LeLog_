import type { Pool } from 'pg';

const retentionLockId = 891_247_331;

export const DELETE_EXPIRED_LOGS_QUERY = `
  WITH lock_acquired AS (
    SELECT pg_try_advisory_lock($3) AS acquired
  ),
  expired AS (
    SELECT id
    FROM logs
    CROSS JOIN lock_acquired
    WHERE event_timestamp < clock_timestamp() - make_interval(days => $1)
      AND lock_acquired.acquired
    ORDER BY event_timestamp ASC, id ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM logs
    USING expired
    WHERE logs.id = expired.id
    RETURNING 1
  ),
  released AS (
    SELECT pg_advisory_unlock($3)
    FROM lock_acquired
    WHERE acquired
  )
  SELECT (
    COALESCE((SELECT COUNT(*) FROM deleted), 0) +
    (COALESCE((SELECT COUNT(*) FROM released), 0) * 0)
  ) AS deleted
`.trim();

export async function deleteExpiredLogBatch(
  pool: Pick<Pool, 'query'>,
  retentionDays: number,
  batchSize: number,
): Promise<number> {
  const result = await pool.query({
    name: 'delete-expired-logs-v1',
    text: DELETE_EXPIRED_LOGS_QUERY,
    values: [retentionDays, batchSize, retentionLockId],
  });

  return Number(
    (result.rows[0] as { deleted?: number } | undefined)?.deleted ?? 0,
  );
}
