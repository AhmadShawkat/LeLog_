import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Pool } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { serializeHstoreRecord } from './hstore.js';
import type { ValidatedLogEntry } from './log-entry.js';
import { COPY_LOG_BATCH_QUERY } from './sql.js';

export { COPY_LOG_BATCH_QUERY } from './sql.js';

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function serializeLogBatch(
  entries: readonly ValidatedLogEntry[],
): string {
  return entries
    .map((entry) =>
      [
        entry.timestamp,
        entry.service,
        entry.level,
        entry.message,
        JSON.stringify(entry.attributes),
        serializeHstoreRecord(entry.attributesText),
      ]
        .map(csvField)
        .join(','),
    )
    .join('\n')
    .concat('\n');
}

export async function insertLogBatch(
  pool: Pick<Pool, 'connect'>,
  entries: readonly ValidatedLogEntry[],
): Promise<void> {
  const client = await pool.connect();
  try {
    const destination = client.query(copyFrom(COPY_LOG_BATCH_QUERY));
    await pipeline(Readable.from([serializeLogBatch(entries)]), destination);
  } finally {
    client.release();
  }
}
