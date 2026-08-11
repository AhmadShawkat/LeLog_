import type { Pool, QueryResultRow } from 'pg';
import type { LogAttributes, LogLevel } from './log-entry.js';
import { buildLogQuery } from './query-sql.js';
import type { LogQueryFilters } from './query-validation.js';

export interface LogRow extends QueryResultRow {
  id: string;
  event_timestamp: Date | string;
  service: string;
  level: LogLevel;
  message: string;
  attributes: LogAttributes;
}

export async function selectLogs(
  pool: Pick<Pool, 'query'>,
  filters: LogQueryFilters,
): Promise<LogRow[]> {
  const query = buildLogQuery(filters);
  const result = await pool.query<LogRow>(query.text, query.values);
  return result.rows;
}
