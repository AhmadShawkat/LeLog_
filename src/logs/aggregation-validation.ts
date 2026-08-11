import type { LogQueryFilters } from './query-validation.js';
import { validateLogQuery } from './query-validation.js';

export const AGGREGATION_BUCKETS = ['1m', '5m', '1h', '1d'] as const;
export type AggregationBucket = (typeof AGGREGATION_BUCKETS)[number];
export type AggregationGroup = 'service' | 'level';

export interface AggregationFilters extends Pick<
  LogQueryFilters,
  'service' | 'level' | 'since' | 'until' | 'q' | 'attributes'
> {
  since: string;
  until: string;
  bucket: AggregationBucket;
  groupBy?: AggregationGroup;
}

export type AggregationValidationResult =
  { filters: AggregationFilters } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateAggregationQuery(
  query: unknown,
): AggregationValidationResult {
  if (!isRecord(query)) return { error: 'Query parameters must be an object' };

  const baseQuery: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === 'bucket' || key === 'group_by') continue;
    if (
      key === 'service' ||
      key === 'level' ||
      key === 'since' ||
      key === 'until' ||
      key === 'q' ||
      key.startsWith('attr.')
    ) {
      baseQuery[key] = value;
      continue;
    }
    return { error: `Unsupported query parameter: ${key}` };
  }

  const validation = validateLogQuery(baseQuery);
  if ('error' in validation) return validation;

  const since = validation.filters.since;
  if (since === undefined) {
    return { error: 'since is required' };
  }
  const until = validation.filters.until;
  if (until === undefined) {
    return { error: 'until is required' };
  }

  const bucket = query.bucket;
  if (
    typeof bucket !== 'string' ||
    !AGGREGATION_BUCKETS.includes(bucket as AggregationBucket)
  ) {
    return { error: 'bucket must be one of 1m, 5m, 1h, or 1d' };
  }

  const groupBy = query.group_by;
  if (groupBy !== undefined && groupBy !== 'service' && groupBy !== 'level') {
    return { error: 'group_by must be service or level' };
  }

  const sharedFilters = validation.filters;
  return {
    filters: {
      attributes: sharedFilters.attributes,
      since,
      until,
      bucket: bucket as AggregationBucket,
      ...(sharedFilters.service === undefined
        ? {}
        : { service: sharedFilters.service }),
      ...(sharedFilters.level === undefined
        ? {}
        : { level: sharedFilters.level }),
      ...(sharedFilters.q === undefined ? {} : { q: sharedFilters.q }),
      ...(groupBy === undefined ? {} : { groupBy }),
    },
  };
}
