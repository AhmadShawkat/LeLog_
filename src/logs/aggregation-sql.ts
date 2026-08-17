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
  if (filters.q === undefined && filters.attributes.length === 0) {
    return buildRollupAggregationQuery(filters);
  }

  return buildRawAggregationQuery(filters);
}

function buildRawAggregationQuery(filters: AggregationFilters): BuiltLogQuery {
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

function buildRollupAggregationQuery(
  filters: AggregationFilters,
): BuiltLogQuery {
  const values: unknown[] = [
    filters.since,
    filters.until,
    bucketIntervals[filters.bucket],
  ];
  const serviceParameter =
    filters.service === undefined
      ? undefined
      : `$${values.push(filters.service)}`;
  const levelParameter =
    filters.level === undefined ? undefined : `$${values.push(filters.level)}`;
  const sharedFilters = [
    ...(serviceParameter === undefined
      ? []
      : [`service = ${serviceParameter}`]),
    ...(levelParameter === undefined ? [] : [`level = ${levelParameter}`]),
  ];
  const rollupFilters = sharedFilters
    .map((filter) => `AND ${filter}`)
    .join('\n');
  const rawFilters = sharedFilters.map((filter) => `AND ${filter}`).join('\n');
  const groupExpression =
    filters.groupBy === undefined ? 'NULL::text' : filters.groupBy;

  return {
    text: `
  WITH bounds AS (
    SELECT
      $1::timestamptz AS since,
      $2::timestamptz AS until,
      date_bin(
        INTERVAL '1 minute',
        $1::timestamptz,
        TIMESTAMPTZ '2001-01-01 00:00:00+00'
      ) + CASE
        WHEN $1::timestamptz = date_bin(
          INTERVAL '1 minute',
          $1::timestamptz,
          TIMESTAMPTZ '2001-01-01 00:00:00+00'
        ) THEN INTERVAL '0 minutes'
        ELSE INTERVAL '1 minute'
      END AS first_full_minute,
      date_bin(
        INTERVAL '1 minute',
        $2::timestamptz,
        TIMESTAMPTZ '2001-01-01 00:00:00+00'
      ) AS last_full_minute
  ),
  minute_counts AS (
    SELECT bucket_start AS minute_start, service, level, count
    FROM log_minute_aggregates
    CROSS JOIN bounds
    WHERE bucket_start >= first_full_minute
      AND bucket_start < last_full_minute
      ${rollupFilters}

    UNION ALL

    SELECT
      date_bin(
        INTERVAL '1 minute',
        event_timestamp,
        TIMESTAMPTZ '2001-01-01 00:00:00+00'
      ) AS minute_start,
      service,
      level,
      COUNT(*)::bigint AS count
    FROM logs
    CROSS JOIN bounds
    WHERE event_timestamp >= since
      AND event_timestamp < until
      AND (
        event_timestamp < first_full_minute
        OR event_timestamp >= last_full_minute
      )
      ${rawFilters}
    GROUP BY minute_start, service, level
  )
  SELECT
    date_bin(
      $3::interval,
      minute_start,
      TIMESTAMPTZ '2001-01-01 00:00:00+00'
    ) AS bucket_timestamp,
    ${groupExpression} AS group_value,
    SUM(count)::bigint AS count
  FROM minute_counts
  GROUP BY bucket_timestamp, group_value
  ORDER BY bucket_timestamp ASC, group_value ASC NULLS FIRST
`,
    values,
  };
}
