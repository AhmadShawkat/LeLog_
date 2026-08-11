import {
  LOG_LEVELS,
  type LogAttributes,
  type ValidatedLogBatch,
  type ValidatedLogEntry,
} from './log-entry.js';

const isoTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const maximumFutureOffsetMs = 5 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTimestamp(value: unknown, nowMs: number): string | undefined {
  if (typeof value !== 'string') {
    return 'timestamp must be a valid ISO 8601 date-time with a timezone';
  }

  const match = isoTimestampPattern.exec(value);
  if (!match) {
    return 'timestamp must be a valid ISO 8601 date-time with a timezone';
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    daysInMonth === undefined ||
    day > daysInMonth
  ) {
    return 'timestamp must be a valid ISO 8601 date-time with a timezone';
  }

  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) {
    return 'timestamp must be a valid ISO 8601 date-time with a timezone';
  }

  if (timestampMs > nowMs + maximumFutureOffsetMs) {
    return 'timestamp must not be more than five minutes in the future';
  }

  return undefined;
}

function validateAttributes(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return 'attributes must be a flat object';
  }

  for (const attributeValue of Object.values(value)) {
    if (
      typeof attributeValue !== 'string' &&
      typeof attributeValue !== 'number' &&
      typeof attributeValue !== 'boolean'
    ) {
      return 'attribute values must be strings, numbers, or booleans';
    }
  }

  return undefined;
}

function validateEntry(
  value: unknown,
  nowMs: number,
): { entry?: ValidatedLogEntry; reason?: string } {
  if (!isRecord(value)) return { reason: 'entry must be an object' };

  const timestampError = validateTimestamp(value.timestamp, nowMs);
  if (timestampError) return { reason: timestampError };

  if (
    typeof value.level !== 'string' ||
    !LOG_LEVELS.includes(value.level as (typeof LOG_LEVELS)[number])
  ) {
    return { reason: 'level must be one of debug, info, warn, or error' };
  }

  if (typeof value.service !== 'string' || value.service.trim().length === 0) {
    return { reason: 'service must be a non-empty string' };
  }

  if (typeof value.message !== 'string' || value.message.trim().length === 0) {
    return { reason: 'message must be a non-empty string' };
  }

  const attributes = value.attributes === undefined ? {} : value.attributes;
  const attributesError = validateAttributes(attributes);
  if (attributesError) return { reason: attributesError };

  const typedAttributes = attributes as LogAttributes;
  const attributesText = Object.fromEntries(
    Object.entries(typedAttributes).map(([key, attributeValue]) => [
      key,
      String(attributeValue),
    ]),
  );

  return {
    entry: {
      timestamp: value.timestamp as string,
      level: value.level as ValidatedLogEntry['level'],
      service: value.service,
      message: value.message,
      attributes: typedAttributes,
      attributesText,
    },
  };
}

export function validateLogBatch(
  body: unknown,
  now: Date = new Date(),
): ValidatedLogBatch | undefined {
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    !Array.isArray(body.logs) ||
    body.logs.length === 0
  ) {
    return undefined;
  }

  const result: ValidatedLogBatch = { accepted: [], rejected: [] };
  const nowMs = now.getTime();

  body.logs.forEach((value, index) => {
    const validation = validateEntry(value, nowMs);
    if (validation.entry) {
      result.accepted.push(validation.entry);
    } else {
      result.rejected.push({
        index,
        reason: validation.reason ?? 'entry is invalid',
      });
    }
  });

  return result;
}
