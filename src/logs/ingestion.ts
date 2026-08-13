import type { RejectedLogEntry } from './log-entry.js';
import type { LogBatchWriter } from './batch-writer.js';
import { validateLogBatch } from './validation.js';

export interface LogIngestionResult {
  accepted: number;
  rejected: RejectedLogEntry[];
}

export async function ingestLogBatch(
  writer: Pick<LogBatchWriter, 'write'>,
  body: unknown,
): Promise<LogIngestionResult | undefined> {
  const validation = validateLogBatch(body);
  if (!validation) return undefined;

  if (validation.accepted.length > 0) {
    await writer.write(validation.accepted);
  }

  return {
    accepted: validation.accepted.length,
    rejected: validation.rejected,
  };
}
