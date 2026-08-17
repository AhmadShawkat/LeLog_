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
    RETURNING
      date_bin(
        INTERVAL '1 minute',
        logs.event_timestamp,
        TIMESTAMPTZ '2001-01-01 00:00:00+00'
      ) AS bucket_start,
      logs.service,
      logs.level
  ),
  deleted_groups AS (
    SELECT bucket_start, service, level, COUNT(*)::bigint AS count
    FROM deleted
    GROUP BY bucket_start, service, level
  ),
  updated_rollups AS (
    UPDATE log_minute_aggregates AS aggregate
    SET count = aggregate.count - deleted_groups.count
    FROM deleted_groups
    WHERE aggregate.bucket_start = deleted_groups.bucket_start
      AND aggregate.service = deleted_groups.service
      AND aggregate.level = deleted_groups.level
      AND aggregate.count > deleted_groups.count
    RETURNING 1
  ),
  removed_rollups AS (
    DELETE FROM log_minute_aggregates AS aggregate
    USING deleted_groups
    WHERE aggregate.bucket_start = deleted_groups.bucket_start
      AND aggregate.service = deleted_groups.service
      AND aggregate.level = deleted_groups.level
      AND aggregate.count <= deleted_groups.count
    RETURNING 1
  ),
  released AS (
    SELECT pg_advisory_unlock($3)
    FROM lock_acquired
    WHERE acquired
  )
  SELECT (
    COALESCE((SELECT COUNT(*) FROM deleted), 0) +
    (COALESCE((SELECT COUNT(*) FROM updated_rollups), 0) * 0) +
    (COALESCE((SELECT COUNT(*) FROM removed_rollups), 0) * 0) +
    (COALESCE((SELECT COUNT(*) FROM released), 0) * 0)
  ) AS deleted
`.trim();

export async function deleteExpiredLogBatch(
  pool: Pick<Pool, 'query'>,
  retentionDays: number,
  batchSize: number,
): Promise<number> {
  const result = await pool.query({
    name: 'delete-expired-logs-v2',
    text: DELETE_EXPIRED_LOGS_QUERY,
    values: [retentionDays, batchSize, retentionLockId],
  });

  return Number(
    (result.rows[0] as { deleted?: number } | undefined)?.deleted ?? 0,
  );
}
