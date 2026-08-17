import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Pool } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { serializeHstoreRecord } from './hstore.js';
import type { ValidatedLogEntry } from './log-entry.js';
import {
  COPY_LOG_BATCH_QUERY,
  UPSERT_LOG_MINUTE_AGGREGATES_QUERY,
} from './sql.js';

export {
  COPY_LOG_BATCH_QUERY,
  UPSERT_LOG_MINUTE_AGGREGATES_QUERY,
} from './sql.js';

interface MinuteAggregate {
  bucketStart: string;
  service: string;
  level: string;
  count: number;
}

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

export function groupLogMinuteAggregates(
  entries: readonly ValidatedLogEntry[],
): MinuteAggregate[] {
  const aggregates = new Map<string, MinuteAggregate>();

  for (const entry of entries) {
    const timestamp = new Date(entry.timestamp);
    timestamp.setUTCSeconds(0, 0);
    const bucketStart = timestamp.toISOString();
    const key = `${bucketStart}\u0000${entry.service}\u0000${entry.level}`;
    const aggregate = aggregates.get(key);

    if (aggregate) {
      aggregate.count += 1;
    } else {
      aggregates.set(key, {
        bucketStart,
        service: entry.service,
        level: entry.level,
        count: 1,
      });
    }
  }

  return [...aggregates.values()].sort(
    (left, right) =>
      left.bucketStart.localeCompare(right.bucketStart) ||
      left.service.localeCompare(right.service) ||
      left.level.localeCompare(right.level),
  );
}

export async function insertLogBatch(
  pool: Pick<Pool, 'connect'>,
  entries: readonly ValidatedLogEntry[],
): Promise<void> {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const destination = client.query(copyFrom(COPY_LOG_BATCH_QUERY));
    await pipeline(Readable.from([serializeLogBatch(entries)]), destination);

    const aggregates = groupLogMinuteAggregates(entries);
    await client.query({
      name: 'upsert-log-minute-aggregates-v1',
      text: UPSERT_LOG_MINUTE_AGGREGATES_QUERY,
      values: [
        aggregates.map(({ bucketStart }) => bucketStart),
        aggregates.map(({ service }) => service),
        aggregates.map(({ level }) => level),
        aggregates.map(({ count }) => count),
      ],
    });
    await client.query('COMMIT');
  } catch (error) {
    if (transactionStarted) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}
