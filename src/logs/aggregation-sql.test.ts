import { describe, expect, it } from 'vitest';
import { buildAggregationQuery } from './aggregation-sql.js';

describe('buildAggregationQuery', () => {
  it('reuses parameterized filters and groups into ascending UTC buckets', () => {
    const query = buildAggregationQuery({
      service: "api' OR true --",
      level: 'error',
      since: '2026-08-01T00:00:00Z',
      until: '2026-09-01T00:00:00Z',
      attributes: [{ key: 'region', value: "west' OR true --" }],
      q: '100%_done\\now',
      bucket: '5m',
      groupBy: 'service',
    });

    expect(query.text).toContain('service = $1');
    expect(query.text).toContain('level = $2');
    expect(query.text).toContain('event_timestamp >= $3::timestamptz');
    expect(query.text).toContain('event_timestamp < $4::timestamptz');
    expect(query.text).toContain('attributes_text @> $5::jsonb');
    expect(query.text).toContain("message ILIKE '%' || $6 || '%'");
    expect(query.text).toContain('$7::interval');
    expect(query.text).toContain('service AS group_value');
    expect(query.text).toContain(
      'ORDER BY bucket_timestamp ASC, group_value ASC NULLS FIRST',
    );
    expect(query.text).not.toContain("api' OR true --");
    expect(query.values).toEqual([
      "api' OR true --",
      'error',
      '2026-08-01T00:00:00Z',
      '2026-09-01T00:00:00Z',
      JSON.stringify({ region: "west' OR true --" }),
      '100\\%\\_done\\\\now',
      '5 minutes',
    ]);
  });

  it('returns null groups and omits empty buckets for an ungrouped query', () => {
    const query = buildAggregationQuery({
      since: '2026-08-01T00:00:00Z',
      until: '2026-08-02T00:00:00Z',
      attributes: [],
      bucket: '1h',
    });

    expect(query.text).toContain('NULL::text AS group_value');
    expect(query.text).not.toContain('generate_series');
    expect(query.values).toEqual([
      '2026-08-01T00:00:00Z',
      '2026-08-02T00:00:00Z',
      '1 hour',
    ]);
  });
});
