import { describe, expect, it } from 'vitest';
import { encodeCursor, validateLogQuery } from './query-validation.js';

describe('validateLogQuery', () => {
  it('accepts freely combinable filters and the maximum limit', () => {
    const cursor = encodeCursor({
      timestamp: '2026-08-11T12:00:00.000Z',
      id: '9007199254740993',
    });

    expect(
      validateLogQuery({
        service: 'api',
        level: 'error',
        since: '2026-08-01T00:00:00Z',
        until: '2026-09-01T00:00:00+00:00',
        'attr.region': 'west',
        'attr.status': '500',
        q: 'failed',
        limit: '1000',
        cursor,
      }),
    ).toEqual({
      filters: {
        service: 'api',
        level: 'error',
        since: '2026-08-01T00:00:00Z',
        until: '2026-09-01T00:00:00+00:00',
        attributes: [
          { key: 'region', value: 'west' },
          { key: 'status', value: '500' },
        ],
        q: 'failed',
        limit: 1000,
        cursor: {
          timestamp: '2026-08-11T12:00:00.000Z',
          id: '9007199254740993',
        },
      },
    });
  });

  it('uses a default limit of 100', () => {
    expect(validateLogQuery({})).toEqual({
      filters: { attributes: [], limit: 100 },
    });
  });

  it.each([
    [{ since: 'not-a-date' }, 'since must be a valid ISO 8601'],
    [{ until: '2026-02-30T00:00:00Z' }, 'until must be a valid ISO 8601'],
    [
      { since: '2026-08-02T00:00:00Z', until: '2026-08-01T00:00:00Z' },
      'since must not be after until',
    ],
    [{ level: 'fatal' }, 'level must be one of'],
    [{ limit: '0' }, 'limit must be an integer between 1 and 1000'],
    [{ limit: '1001' }, 'limit must be an integer between 1 and 1000'],
    [{ limit: '1.5' }, 'limit must be an integer between 1 and 1000'],
    [{ cursor: 'not-a-cursor' }, 'cursor is malformed'],
    [
      {
        cursor: Buffer.from(
          JSON.stringify({
            v: 1,
            t: '2026-08-11T12:00:00Z',
            i: '9223372036854775808',
          }),
        ).toString('base64url'),
      },
      'cursor is malformed',
    ],
    [{ 'attr.': 'value' }, 'Attribute filter keys must not be empty'],
    [{ unexpected: 'value' }, 'Unsupported query parameter'],
    [{ service: ['api', 'worker'] }, 'must be specified once'],
  ])('rejects invalid query %#', (query, message) => {
    expect(validateLogQuery(query)).toMatchObject({
      error: expect.stringContaining(message),
    });
  });

  it('accepts equal time bounds as a valid empty range', () => {
    const timestamp = '2026-08-11T12:00:00Z';
    expect(validateLogQuery({ since: timestamp, until: timestamp })).toEqual({
      filters: {
        since: timestamp,
        until: timestamp,
        attributes: [],
        limit: 100,
      },
    });
  });
});
