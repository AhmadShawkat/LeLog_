import type { LogQueryFilters } from './query-validation.js';

export interface BuiltLogQuery {
  text: string;
  values: unknown[];
}

function escapeLikePattern(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

export function buildLogFilterWhere(
  filters: Pick<
    LogQueryFilters,
    'service' | 'level' | 'since' | 'until' | 'attributes' | 'q'
  >,
  values: unknown[],
): string {
  const conditions: string[] = [];
  const parameter = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.service !== undefined) {
    conditions.push(`service = ${parameter(filters.service)}`);
  }
  if (filters.level !== undefined) {
    conditions.push(`level = ${parameter(filters.level)}`);
  }
  if (filters.since !== undefined) {
    conditions.push(
      `event_timestamp >= ${parameter(filters.since)}::timestamptz`,
    );
  }
  if (filters.until !== undefined) {
    conditions.push(
      `event_timestamp < ${parameter(filters.until)}::timestamptz`,
    );
  }
  if (filters.attributes.length > 0) {
    conditions.push(
      `attributes_text @> ${parameter(JSON.stringify(Object.fromEntries(filters.attributes.map(({ key, value }) => [key, value]))))}::jsonb`,
    );
  }
  if (filters.q !== undefined) {
    conditions.push(
      `message ILIKE '%' || ${parameter(escapeLikePattern(filters.q))} || '%' ESCAPE '\\'`,
    );
  }

  return conditions.length === 0
    ? ''
    : `\n  WHERE ${conditions.join('\n    AND ')}`;
}

export function buildLogQuery(filters: LogQueryFilters): BuiltLogQuery {
  const values: unknown[] = [];
  const parameter = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  let where = buildLogFilterWhere(filters, values);
  if (filters.cursor !== undefined) {
    const timestamp = parameter(filters.cursor.timestamp);
    const id = parameter(filters.cursor.id);
    const cursorCondition = `(event_timestamp, id) < (${timestamp}::timestamptz, ${id}::bigint)`;
    where =
      where.length === 0
        ? `\n  WHERE ${cursorCondition}`
        : `${where}\n    AND ${cursorCondition}`;
  }
  const limit = parameter(filters.limit + 1);
  return {
    text: `
  SELECT id, event_timestamp, service, level, message, attributes
  FROM logs${where}
  ORDER BY event_timestamp DESC, id DESC
  LIMIT ${limit}
`,
    values,
  };
}
