export const INSERT_LOG_BATCH_QUERY = `
  INSERT INTO logs (
    event_timestamp,
    service,
    level,
    message,
    attributes,
    attributes_text
  )
  SELECT
    event_timestamp,
    service,
    level,
    message,
    attributes,
    attributes_text
  FROM UNNEST(
    $1::timestamptz[],
    $2::text[],
    $3::text[],
    $4::text[],
    $5::jsonb[],
    $6::jsonb[]
  ) AS entry(
    event_timestamp,
    service,
    level,
    message,
    attributes,
    attributes_text
  )
`;
