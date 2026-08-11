import { describe, expect, it } from 'vitest';
import { validateAggregationQuery } from './aggregation-validation.js';

describe('validateAggregationQuery', () => {
  it('accepts all shared filters and grouping', () => {
    expect(
      validateAggregationQuery({
        since: '2026-08-01T00:00:00Z',
        until: '2026-09-01T00:00:00Z',
        bucket: '5m',
        group_by: 'service',
        service: 'api',
        level: 'error',
        'attr.region': 'west',
        q: 'failed',
      }),
    ).toEqual({
      filters: {
        since: '2026-08-01T00:00:00Z',
        until: '2026-09-01T00:00:00Z',
        bucket: '5m',
        groupBy: 'service',
        service: 'api',
        level: 'error',
        attributes: [{ key: 'region', value: 'west' }],
        q: 'failed',
      },
    });
  });

  it('accepts each supported bucket without grouping', () => {
    for (const bucket of ['1m', '5m', '1h', '1d']) {
      expect(
        validateAggregationQuery({
          since: '2026-08-01T00:00:00Z',
          until: '2026-08-02T00:00:00Z',
          bucket,
        }),
      ).toMatchObject({ filters: { bucket, attributes: [] } });
    }
  });

  it.each([
    [{ until: '2026-08-02T00:00:00Z', bucket: '1m' }, 'since is required'],
    [{ since: '2026-08-01T00:00:00Z', bucket: '1m' }, 'until is required'],
    [
      {
        since: 'invalid',
        until: '2026-08-02T00:00:00Z',
        bucket: '1m',
      },
      'since must be a valid ISO 8601',
    ],
    [
      {
        since: '2026-08-03T00:00:00Z',
        until: '2026-08-02T00:00:00Z',
        bucket: '1m',
      },
      'since must not be after until',
    ],
    [
      {
        since: '2026-08-01T00:00:00Z',
        until: '2026-08-02T00:00:00Z',
        bucket: '10m',
      },
      'bucket must be one of',
    ],
    [
      {
        since: '2026-08-01T00:00:00Z',
        until: '2026-08-02T00:00:00Z',
        bucket: '1m',
        group_by: 'message',
      },
      'group_by must be service or level',
    ],
    [
      {
        since: '2026-08-01T00:00:00Z',
        until: '2026-08-02T00:00:00Z',
        bucket: '1m',
        limit: '10',
      },
      'Unsupported query parameter: limit',
    ],
  ])('rejects invalid aggregation query %#', (query, message) => {
    expect(validateAggregationQuery(query)).toEqual({
      error: expect.stringContaining(message),
    });
  });
});
