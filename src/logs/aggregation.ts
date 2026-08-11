import type { Pool, QueryResultRow } from 'pg';
import type { AggregationFilters } from './aggregation-validation.js';
import { buildAggregationQuery } from './aggregation-sql.js';

interface AggregationRow extends QueryResultRow {
  bucket_timestamp: Date | string;
  group_value: string | null;
  count: string;
}

export interface AggregationBucketResult {
  timestamp: string;
  count: number;
  group: string | null;
}

export async function aggregateLogs(
  pool: Pick<Pool, 'query'>,
  filters: AggregationFilters,
): Promise<{ buckets: AggregationBucketResult[] }> {
  const query = buildAggregationQuery(filters);
  const result = await pool.query<AggregationRow>(query.text, query.values);

  return {
    buckets: result.rows.map((row) => ({
      timestamp:
        row.bucket_timestamp instanceof Date
          ? row.bucket_timestamp.toISOString()
          : new Date(row.bucket_timestamp).toISOString(),
      count: Number(row.count),
      group: row.group_value,
    })),
  };
}
