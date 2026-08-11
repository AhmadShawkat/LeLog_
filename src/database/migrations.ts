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
        ON logs USING GIN (attributes_text jsonb_path_ops);

      CREATE INDEX logs_message_trgm_idx
        ON logs USING GIN (message gin_trgm_ops);
    `.trim(),
  }),
]);
