export const COPY_LOG_BATCH_QUERY = `
  COPY logs (
    event_timestamp,
    service,
    level,
    message,
    attributes,
    attributes_text
  )
  FROM STDIN WITH (FORMAT CSV)
`;

export const UPSERT_LOG_MINUTE_AGGREGATES_QUERY = `
  INSERT INTO log_minute_aggregates (bucket_start, service, level, count)
  SELECT *
  FROM unnest(
    $1::timestamptz[],
    $2::text[],
    $3::text[],
    $4::bigint[]
  )
  ON CONFLICT (bucket_start, service, level)
  DO UPDATE SET count = log_minute_aggregates.count + EXCLUDED.count
`;
