import { describe, expect, it } from 'vitest';
import { serializeHstorePairs, serializeHstoreRecord } from './hstore.js';

describe('Hstore serialization', () => {
  it('quotes every key and value, including the literal NULL', () => {
    expect(
      serializeHstoreRecord({
        plain: 'value',
        NULL: 'NULL',
      }),
    ).toBe('"plain"=>"value","NULL"=>"NULL"');
  });

  it('escapes quotes and backslashes without interpreting SQL text', () => {
    expect(
      serializeHstorePairs([
        ['key"\\', 'value"\\'],
        ["region' OR true --", "west' OR true --"],
      ]),
    ).toBe(
      '"key\\"\\\\"=>"value\\"\\\\","region\' OR true --"=>"west\' OR true --"',
    );
  });

  it('serializes an empty record as an empty Hstore value', () => {
    expect(serializeHstoreRecord({})).toBe('');
  });
});
