import { describe, expect, it } from 'vitest';
import { validateLogBatch } from './validation.js';

const now = new Date('2026-08-11T12:00:00.000Z');

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-08-11T11:59:00.000Z',
    service: 'billing',
    level: 'info',
    message: 'invoice created',
    ...overrides,
  };
}

describe('validateLogBatch', () => {
  it('accepts the exact fields and normalizes typed attributes for filtering', () => {
    const result = validateLogBatch(
      {
        logs: [
          validEntry({
            attributes: { region: 'west', attempts: 2, cached: false },
          }),
        ],
      },
      now,
    );

    expect(result).toEqual({
      accepted: [
        {
          ...validEntry(),
          attributes: { region: 'west', attempts: 2, cached: false },
          attributesText: {
            region: 'west',
            attempts: '2',
            cached: 'false',
          },
        },
      ],
      rejected: [],
    });
  });

  it('accepts the five-minute future boundary and rejects later timestamps', () => {
    const result = validateLogBatch(
      {
        logs: [
          validEntry({ timestamp: '2026-08-11T12:05:00.000Z' }),
          validEntry({ timestamp: '2026-08-11T12:05:00.001Z' }),
        ],
      },
      now,
    );

    expect(result?.accepted).toHaveLength(1);
    expect(result?.rejected).toEqual([
      {
        index: 1,
        reason: 'timestamp must not be more than five minutes in the future',
      },
    ]);
  });

  it.each([
    ['a top-level array', [validEntry()]],
    ['a missing logs field', {}],
    ['an empty logs array', { logs: [] }],
    ['an extra top-level field', { logs: [validEntry()], extra: true }],
  ])('rejects %s as an invalid top-level body', (_description, body) => {
    expect(validateLogBatch(body, now)).toBeUndefined();
  });

  it.each([
    ['a non-object entry', null, 'entry must be an object'],
    [
      'an impossible calendar date',
      validEntry({ timestamp: '2026-02-30T12:00:00Z' }),
      'timestamp must be a valid ISO 8601 date-time with a timezone',
    ],
    [
      'a timestamp without a timezone',
      validEntry({ timestamp: '2026-08-11T12:00:00' }),
      'timestamp must be a valid ISO 8601 date-time with a timezone',
    ],
    [
      'an unsupported level',
      validEntry({ level: 'fatal' }),
      'level must be one of debug, info, warn, or error',
    ],
    [
      'a blank service',
      validEntry({ service: '  ' }),
      'service must be a non-empty string',
    ],
    [
      'a blank message',
      validEntry({ message: '' }),
      'message must be a non-empty string',
    ],
    [
      'nested attributes',
      validEntry({ attributes: { request: { id: '123' } } }),
      'attribute values must be strings, numbers, or booleans',
    ],
    [
      'null attributes',
      validEntry({ attributes: null }),
      'attributes must be a flat object',
    ],
  ])(
    'rejects %s with its array index and reason',
    (_description, entry, reason) => {
      expect(validateLogBatch({ logs: [entry] }, now)).toEqual({
        accepted: [],
        rejected: [{ index: 0, reason }],
      });
    },
  );
});
