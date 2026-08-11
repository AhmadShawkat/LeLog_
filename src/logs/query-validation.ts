import { LOG_LEVELS, type LogLevel } from './log-entry.js';
import { parseIsoTimestamp } from './timestamp.js';

const defaultLimit = 100;
const maximumLimit = 1_000;
const maximumLogId = 9_223_372_036_854_775_807n;
const cursorPattern = /^[A-Za-z0-9_-]+$/;
const fixedParameters = new Set([
  'service',
  'level',
  'since',
  'until',
  'q',
  'limit',
  'cursor',
]);

export interface LogCursor {
  timestamp: string;
  id: string;
}

export interface AttributeFilter {
  key: string;
  value: string;
}

export interface LogQueryFilters {
  service?: string;
  level?: LogLevel;
  since?: string;
  until?: string;
  q?: string;
  cursor?: LogCursor;
  attributes: AttributeFilter[];
  limit: number;
}

export type LogQueryValidationResult =
  { filters: LogQueryFilters } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeCursor(value: string): LogCursor | undefined {
  if (value.length === 0 || value.length > 512 || !cursorPattern.test(value)) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) return undefined;

    const payload: unknown = JSON.parse(decoded.toString('utf8'));
    if (!isRecord(payload)) return undefined;
    if (
      Object.keys(payload).length !== 3 ||
      payload.v !== 1 ||
      typeof payload.t !== 'string' ||
      typeof payload.i !== 'string' ||
      parseIsoTimestamp(payload.t) === undefined ||
      !/^[1-9]\d*$/.test(payload.i) ||
      BigInt(payload.i) > maximumLogId
    ) {
      return undefined;
    }

    return { timestamp: payload.t, id: payload.i };
  } catch {
    return undefined;
  }
}

export function encodeCursor(cursor: LogCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: cursor.timestamp, i: cursor.id }),
  ).toString('base64url');
}

export function validateLogQuery(query: unknown): LogQueryValidationResult {
  if (!isRecord(query)) return { error: 'Query parameters must be an object' };

  const attributes: AttributeFilter[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') {
      return { error: `Query parameter ${key} must be specified once` };
    }

    if (key.startsWith('attr.')) {
      const attributeKey = key.slice('attr.'.length);
      if (attributeKey.length === 0) {
        return { error: 'Attribute filter keys must not be empty' };
      }
      attributes.push({ key: attributeKey, value });
    } else if (!fixedParameters.has(key)) {
      return { error: `Unsupported query parameter: ${key}` };
    }
  }

  const service = query.service as string | undefined;
  const level = query.level as string | undefined;
  const since = query.since as string | undefined;
  const until = query.until as string | undefined;
  const q = query.q as string | undefined;
  const limitValue = query.limit as string | undefined;
  const cursorValue = query.cursor as string | undefined;

  if (level !== undefined && !LOG_LEVELS.includes(level as LogLevel)) {
    return { error: 'level must be one of debug, info, warn, or error' };
  }
  if (since !== undefined && parseIsoTimestamp(since) === undefined) {
    return {
      error: 'since must be a valid ISO 8601 date-time with a timezone',
    };
  }
  if (until !== undefined && parseIsoTimestamp(until) === undefined) {
    return {
      error: 'until must be a valid ISO 8601 date-time with a timezone',
    };
  }
  if (
    since !== undefined &&
    until !== undefined &&
    Date.parse(since) > Date.parse(until)
  ) {
    return { error: 'since must not be after until' };
  }

  let limit = defaultLimit;
  if (limitValue !== undefined) {
    if (!/^[1-9]\d*$/.test(limitValue)) {
      return { error: 'limit must be an integer between 1 and 1000' };
    }
    limit = Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit > maximumLimit) {
      return { error: 'limit must be an integer between 1 and 1000' };
    }
  }

  const cursor =
    cursorValue === undefined ? undefined : decodeCursor(cursorValue);
  if (cursorValue !== undefined && cursor === undefined) {
    return { error: 'cursor is malformed' };
  }

  const filters: LogQueryFilters = {
    attributes,
    limit,
    ...(service === undefined ? {} : { service }),
    ...(level === undefined ? {} : { level: level as LogLevel }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(q === undefined ? {} : { q }),
    ...(cursor === undefined ? {} : { cursor }),
  };
  return { filters };
}
