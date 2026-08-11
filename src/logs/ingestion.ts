import type { Pool } from 'pg';
import type { RejectedLogEntry } from './log-entry.js';
import { insertLogBatch } from './repository.js';
import { validateLogBatch } from './validation.js';

export interface LogIngestionResult {
  accepted: number;
  rejected: RejectedLogEntry[];
}

export async function ingestLogBatch(
  pool: Pick<Pool, 'query'>,
  body: unknown,
): Promise<LogIngestionResult | undefined> {
  const validation = validateLogBatch(body);
  if (!validation) return undefined;

  if (validation.accepted.length > 0) {
    await insertLogBatch(pool, validation.accepted);
  }

  return {
    accepted: validation.accepted.length,
    rejected: validation.rejected,
  };
}
