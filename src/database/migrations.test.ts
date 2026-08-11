import { describe, expect, it } from 'vitest';
import { migrations } from './migrations.js';

describe('migrations', () => {
  it('defines unique migrations in version order', () => {
    const versions = migrations.map(({ version }) => version);

    expect(versions).toEqual(['001_create_logs', '002_create_log_indexes']);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('creates the required durable log columns and JSON object constraints', () => {
    const schema = migrations[0]?.sql ?? '';

    expect(schema).toMatch(
      /id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY/,
    );
    expect(schema).toMatch(/event_timestamp TIMESTAMPTZ NOT NULL/);
    expect(schema).toMatch(/received_at TIMESTAMPTZ NOT NULL/);
    expect(schema).toMatch(/service TEXT NOT NULL/);
    expect(schema).toMatch(/level TEXT NOT NULL/);
    expect(schema).toMatch(/message TEXT NOT NULL/);
    expect(schema).toMatch(/attributes JSONB NOT NULL/);
    expect(schema).toMatch(/attributes_text JSONB NOT NULL/);
    expect(schema).toMatch(/jsonb_typeof\(attributes\) = 'object'/);
    expect(schema).toMatch(/jsonb_typeof\(attributes_text\) = 'object'/);
  });

  it('creates indexes for deterministic pagination and planned filters', () => {
    const indexes = migrations[1]?.sql ?? '';

    expect(indexes).toMatch(/\(event_timestamp DESC, id DESC\)/);
    expect(indexes).toMatch(/\(service, event_timestamp DESC, id DESC\)/);
    expect(indexes).toMatch(/\(level, event_timestamp DESC, id DESC\)/);
    expect(indexes).toMatch(/GIN \(attributes_text jsonb_path_ops\)/);
    expect(indexes).toMatch(/GIN \(message gin_trgm_ops\)/);
  });
});
