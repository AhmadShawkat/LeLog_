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
