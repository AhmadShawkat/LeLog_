import { describe, expect, it } from 'vitest';
import { buildLogQuery } from './query-sql.js';

describe('buildLogQuery', () => {
  it('builds parameterized freely combinable filters with keyset pagination', () => {
    const query = buildLogQuery({
      service: "api' OR true --",
      level: 'error',
      since: '2026-08-01T00:00:00Z',
      until: '2026-09-01T00:00:00Z',
      attributes: [{ key: 'region', value: "west' OR true --" }],
      q: '100%_done\\now',
      cursor: { timestamp: '2026-08-15T00:00:00Z', id: '42' },
      limit: 25,
    });

    expect(query.text).toContain('service = $1');
    expect(query.text).toContain('level = $2');
    expect(query.text).toContain('event_timestamp >= $3::timestamptz');
    expect(query.text).toContain('event_timestamp < $4::timestamptz');
    expect(query.text).toContain('attributes_text @> $5::hstore');
    expect(query.text).toContain("message ILIKE '%' || $6 || '%' ESCAPE '\\'");
    expect(query.text).toContain(
      '(event_timestamp, id) < ($7::timestamptz, $8::bigint)',
    );
    expect(query.text).toContain('ORDER BY event_timestamp DESC, id DESC');
    expect(query.text).toContain('LIMIT $9');
    expect(query.text).not.toContain("api' OR true --");
    expect(query.values).toEqual([
      "api' OR true --",
      'error',
      '2026-08-01T00:00:00Z',
      '2026-09-01T00:00:00Z',
      '"region"=>"west\' OR true --"',
      '100\\%\\_done\\\\now',
      '2026-08-15T00:00:00Z',
      '42',
      26,
    ]);
  });

  it('uses only deterministic ordering and limit for an unfiltered query', () => {
    const query = buildLogQuery({ attributes: [], limit: 100 });

    expect(query.text).not.toContain('WHERE');
    expect(query.text).toContain('ORDER BY event_timestamp DESC, id DESC');
    expect(query.values).toEqual([101]);
  });
});
