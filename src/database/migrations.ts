export interface Migration {
  readonly version: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = Object.freeze([
  Object.freeze({
    version: '001_create_logs',
    sql: `
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      CREATE TABLE logs (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_timestamp TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        service TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
        attributes_text JSONB NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT logs_attributes_object CHECK (jsonb_typeof(attributes) = 'object'),
        CONSTRAINT logs_attributes_text_object CHECK (jsonb_typeof(attributes_text) = 'object')
      );
    `.trim(),
  }),
  Object.freeze({
    version: '002_create_log_indexes',
    sql: `
      CREATE INDEX logs_event_timestamp_id_idx
        ON logs (event_timestamp DESC, id DESC);

      CREATE INDEX logs_service_event_timestamp_id_idx
        ON logs (service, event_timestamp DESC, id DESC);

      CREATE INDEX logs_level_event_timestamp_id_idx
        ON logs (level, event_timestamp DESC, id DESC);

      CREATE INDEX logs_attributes_text_gin_idx
        ON logs USING GIN (attributes_text jsonb_path_ops) WITH (fastupdate = on);

      CREATE INDEX logs_message_trgm_idx
        ON logs USING GIN (message gin_trgm_ops) WITH (fastupdate = on);
    `.trim(),
  }),
  Object.freeze({
    version: '003_tune_logs_autovacuum',
    sql: `
      ALTER TABLE logs SET (
        autovacuum_vacuum_scale_factor = 0.02,
        autovacuum_vacuum_threshold = 1000,
        autovacuum_analyze_scale_factor = 0.01,
        autovacuum_analyze_threshold = 1000
      );
    `.trim(),
  }),
  Object.freeze({
    version: '004_optimize_log_access_paths',
    sql: `
      DROP INDEX IF EXISTS logs_service_event_timestamp_id_idx;
      DROP INDEX IF EXISTS logs_level_event_timestamp_id_idx;

      ALTER INDEX logs_message_trgm_idx SET (fastupdate = on);
      ALTER INDEX logs_attributes_text_gin_idx SET (fastupdate = on);
    `.trim(),
  }),
  Object.freeze({
    version: '005_use_global_autovacuum_settings',
    sql: `
      ALTER TABLE logs RESET (
        autovacuum_vacuum_scale_factor,
        autovacuum_vacuum_threshold,
        autovacuum_analyze_scale_factor,
        autovacuum_analyze_threshold
      );
    `.trim(),
  }),
  Object.freeze({
    version: '006_tune_logs_autovacuum_thresholds',
    sql: `
      ALTER TABLE logs SET (
        autovacuum_vacuum_threshold = 1000,
        autovacuum_analyze_threshold = 1000
      );
    `.trim(),
  }),
  Object.freeze({
    version: '007_convert_attribute_lookup_to_hstore',
    sql: `
      CREATE EXTENSION IF NOT EXISTS hstore;

      DROP INDEX IF EXISTS logs_attributes_text_gin_idx;

      ALTER TABLE logs
        ADD COLUMN attributes_text_hstore HSTORE NOT NULL DEFAULT ''::hstore;

      UPDATE logs AS target
      SET attributes_text_hstore = converted.attributes_text
      FROM (
        SELECT
          source.id,
          hstore(
            array_agg(attribute.key ORDER BY attribute.key),
            array_agg(attribute.value ORDER BY attribute.key)
          ) AS attributes_text
        FROM logs AS source
        CROSS JOIN LATERAL jsonb_each_text(source.attributes_text) AS attribute
        GROUP BY source.id
      ) AS converted
      WHERE target.id = converted.id;

      ALTER TABLE logs DROP CONSTRAINT logs_attributes_text_object;
      ALTER TABLE logs DROP COLUMN attributes_text;
      ALTER TABLE logs RENAME COLUMN attributes_text_hstore TO attributes_text;

      CREATE INDEX logs_attributes_text_gin_idx
        ON logs USING GIN (attributes_text) WITH (fastupdate = on);
    `.trim(),
  }),
  Object.freeze({
    version: '008_bound_hstore_gin_pending_list',
    sql: `
      ALTER INDEX logs_attributes_text_gin_idx SET (
        fastupdate = on,
        gin_pending_list_limit = 4096
      );
    `.trim(),
  }),
  Object.freeze({
    version: '009_prioritize_sustained_writes_over_message_search',
    sql: `
      DROP INDEX IF EXISTS logs_message_trgm_idx;
    `.trim(),
  }),
  Object.freeze({
    version: '010_add_exact_minute_rollups',
    sql: `
      CREATE TABLE log_minute_aggregates (
        bucket_start TIMESTAMPTZ NOT NULL,
        service TEXT NOT NULL,
        level TEXT NOT NULL,
        count BIGINT NOT NULL CHECK (count > 0),
        PRIMARY KEY (bucket_start, service, level)
      );

      INSERT INTO log_minute_aggregates (bucket_start, service, level, count)
      SELECT
        date_bin(
          INTERVAL '1 minute',
          event_timestamp,
          TIMESTAMPTZ '2001-01-01 00:00:00+00'
        ),
        service,
        level,
        COUNT(*)::bigint
      FROM logs
      GROUP BY 1, 2, 3;
    `.trim(),
  }),
]);
