import type { Pool } from 'pg';
import type { ValidatedLogEntry } from './log-entry.js';
import { INSERT_LOG_BATCH_QUERY } from './sql.js';

export { INSERT_LOG_BATCH_QUERY } from './sql.js';

export async function insertLogBatch(
  pool: Pick<Pool, 'query'>,
  entries: readonly ValidatedLogEntry[],
): Promise<void> {
  await pool.query({
    name: 'insert-log-batch-v1',
    text: INSERT_LOG_BATCH_QUERY,
    values: [
      entries.map(({ timestamp }) => timestamp),
      entries.map(({ service }) => service),
      entries.map(({ level }) => level),
      entries.map(({ message }) => message),
      entries.map(({ attributes }) => attributes),
      entries.map(({ attributesText }) => attributesText),
    ],
  });
}
