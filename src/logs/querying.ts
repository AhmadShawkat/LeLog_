import type { Pool } from 'pg';
import type { LogAttributes, LogLevel } from './log-entry.js';
import { encodeCursor, type LogQueryFilters } from './query-validation.js';
import { selectLogs } from './query-repository.js';

export interface QueriedLog {
  timestamp: string;
  service: string;
  level: LogLevel;
  message: string;
  attributes: LogAttributes;
}

export interface LogQueryResult {
  logs: QueriedLog[];
  next_cursor: string | null;
}

export async function queryLogs(
  pool: Pick<Pool, 'query'>,
  filters: LogQueryFilters,
): Promise<LogQueryResult> {
  const rows = await selectLogs(pool, filters);
  const pageRows = rows.slice(0, filters.limit);
  const lastRow = pageRows.at(-1);

  return {
    logs: pageRows.map((row) => ({
      timestamp:
        row.event_timestamp instanceof Date
          ? row.event_timestamp.toISOString()
          : new Date(row.event_timestamp).toISOString(),
      service: row.service,
      level: row.level,
      message: row.message,
      attributes: row.attributes,
    })),
    next_cursor:
      rows.length > filters.limit && lastRow !== undefined
        ? encodeCursor({
            timestamp:
              lastRow.event_timestamp instanceof Date
                ? lastRow.event_timestamp.toISOString()
                : new Date(lastRow.event_timestamp).toISOString(),
            id: lastRow.id,
          })
        : null,
  };
}
