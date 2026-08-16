import { describe, expect, it } from 'vitest';
import { migrations } from './migrations.js';

describe('migrations', () => {
  it('defines unique migrations in version order', () => {
    const versions = migrations.map(({ version }) => version);

    expect(versions).toEqual([
      '001_create_logs',
      '002_create_log_indexes',
      '003_tune_logs_autovacuum',
      '004_optimize_log_access_paths',
      '005_use_global_autovacuum_settings',
      '006_tune_logs_autovacuum_thresholds',
      '007_convert_attribute_lookup_to_hstore',
      '008_bound_hstore_gin_pending_list',
    ]);
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
    expect(indexes).toMatch(
      /GIN \(attributes_text jsonb_path_ops\) WITH \(fastupdate = on\)/,
    );
    expect(indexes).toMatch(
      /GIN \(message gin_trgm_ops\) WITH \(fastupdate = on\)/,
    );
  });

  it('vacuum analyzes retained logs before dead tuples accumulate excessively', () => {
    const settings = migrations[2]?.sql ?? '';

    expect(settings).toMatch(/autovacuum_vacuum_scale_factor = 0\.02/);
    expect(settings).toMatch(/autovacuum_vacuum_threshold = 1000/);
    expect(settings).toMatch(/autovacuum_analyze_scale_factor = 0\.01/);
    expect(settings).toMatch(/autovacuum_analyze_threshold = 1000/);
  });

  it('keeps lean access paths and batched GIN index maintenance', () => {
    const optimization = migrations[3]?.sql ?? '';

    expect(optimization).toMatch(
      /DROP INDEX IF EXISTS logs_service_event_timestamp_id_idx/,
    );
    expect(optimization).toMatch(
      /DROP INDEX IF EXISTS logs_level_event_timestamp_id_idx/,
    );
    expect(optimization).toMatch(
      /ALTER INDEX logs_message_trgm_idx SET \(fastupdate = on\)/,
    );
    expect(optimization).toMatch(
      /ALTER INDEX logs_attributes_text_gin_idx SET \(fastupdate = on\)/,
    );
    expect(optimization).not.toMatch(/DROP INDEX logs_event_timestamp_id_idx/);
    expect(optimization).not.toMatch(/CREATE INDEX/);
    expect(optimization).not.toMatch(/ALTER TABLE logs/);
  });

  it('removes table overrides so global autovacuum tuning takes effect', () => {
    const autovacuum = migrations[4]?.sql ?? '';

    expect(autovacuum).toMatch(/ALTER TABLE logs RESET/);
    expect(autovacuum).toMatch(/autovacuum_vacuum_scale_factor/);
    expect(autovacuum).toMatch(/autovacuum_analyze_scale_factor/);
  });

  it('restores table-level autovacuum thresholds for high-churn retention', () => {
    const thresholds = migrations[5]?.sql ?? '';

    expect(thresholds).toMatch(/ALTER TABLE logs SET/);
    expect(thresholds).toMatch(/autovacuum_vacuum_threshold = 1000/);
    expect(thresholds).toMatch(/autovacuum_analyze_threshold = 1000/);
    expect(thresholds).not.toMatch(/autovacuum_vacuum_scale_factor/);
    expect(thresholds).not.toMatch(/autovacuum_analyze_scale_factor/);
  });

  it('converts the normalized lookup column to indexed Hstore', () => {
    const hstore = migrations[6]?.sql ?? '';

    expect(hstore).toMatch(/CREATE EXTENSION IF NOT EXISTS hstore/);
    expect(hstore).toMatch(/ADD COLUMN attributes_text_hstore HSTORE/);
    expect(hstore).toMatch(/jsonb_each_text\(source\.attributes_text\)/);
    expect(hstore).toMatch(/DROP CONSTRAINT logs_attributes_text_object/);
    expect(hstore).toMatch(
      /RENAME COLUMN attributes_text_hstore TO attributes_text/,
    );
    expect(hstore).toMatch(/GIN \(attributes_text\) WITH \(fastupdate = on\)/);
    expect(hstore).not.toMatch(/DROP COLUMN attributes;/);
  });

  it('bounds only the Hstore GIN pending list', () => {
    const pendingList = migrations[7]?.sql ?? '';

    expect(pendingList).toMatch(/ALTER INDEX logs_attributes_text_gin_idx SET/);
    expect(pendingList).toMatch(/fastupdate = on/);
    expect(pendingList).toMatch(/gin_pending_list_limit = 4096/);
    expect(pendingList).not.toMatch(/logs_message_trgm_idx/);
  });
});
