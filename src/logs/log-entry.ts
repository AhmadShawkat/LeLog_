export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogAttribute = string | number | boolean;
export type LogAttributes = Record<string, LogAttribute>;

export interface ValidatedLogEntry {
  timestamp: string;
  service: string;
  level: LogLevel;
  message: string;
  attributes: LogAttributes;
  attributesText: Record<string, string>;
}

export interface RejectedLogEntry {
  index: number;
  reason: string;
}

export interface ValidatedLogBatch {
  accepted: ValidatedLogEntry[];
  rejected: RejectedLogEntry[];
}
