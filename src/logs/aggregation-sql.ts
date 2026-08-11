import { buildLogFilterWhere, type BuiltLogQuery } from './query-sql.js';
import type { AggregationFilters } from './aggregation-validation.js';

const bucketIntervals = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '1h': '1 hour',
  '1d': '1 day',
} as const;

export function buildAggregationQuery(
  filters: AggregationFilters,
): BuiltLogQuery {
  const values: unknown[] = [];
  const where = buildLogFilterWhere(filters, values);
  values.push(bucketIntervals[filters.bucket]);
  const intervalParameter = `$${values.length}`;
  const groupExpression =
    filters.groupBy === undefined ? 'NULL::text' : filters.groupBy;

  return {
    text: `
  SELECT
    date_bin(
      ${intervalParameter}::interval,
      event_timestamp,
      TIMESTAMPTZ '2001-01-01 00:00:00+00'
    ) AS bucket_timestamp,
    ${groupExpression} AS group_value,
    COUNT(*)::bigint AS count
  FROM logs${where}
  GROUP BY bucket_timestamp, group_value
  ORDER BY bucket_timestamp ASC, group_value ASC NULLS FIRST
`,
    values,
  };
}
