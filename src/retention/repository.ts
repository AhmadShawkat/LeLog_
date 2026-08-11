import type { Pool } from 'pg';

export const DELETE_EXPIRED_LOGS_QUERY = `
  WITH expired AS (
    SELECT id
    FROM logs
    WHERE event_timestamp < clock_timestamp() - make_interval(days => $1)
    ORDER BY event_timestamp ASC, id ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM logs
  USING expired
  WHERE logs.id = expired.id
`.trim();

export async function deleteExpiredLogBatch(
  pool: Pick<Pool, 'query'>,
  retentionDays: number,
  batchSize: number,
): Promise<number> {
  const result = await pool.query({
    name: 'delete-expired-logs-v1',
    text: DELETE_EXPIRED_LOGS_QUERY,
    values: [retentionDays, batchSize],
  });

  return result.rowCount ?? 0;
}
