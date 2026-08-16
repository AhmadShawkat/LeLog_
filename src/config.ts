import { z } from 'zod';

const portSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a whole number from 1 to 65535')
  .transform(Number)
  .pipe(z.number().int().max(65_535, 'must be at most 65535'));

function integerSchema(minimum: number, maximum: number) {
  return z
    .string()
    .regex(/^\d+$/, `must be a whole number from ${minimum} to ${maximum}`)
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum));
}

const databaseUrlSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'postgres:' || protocol === 'postgresql:';
    } catch {
      return false;
    }
  }, 'must be a valid PostgreSQL connection URL');

const configSchema = z
  .object({
    HOST: z.string().trim().min(1, 'must not be empty').default('0.0.0.0'),
    PORT: portSchema.default(8080),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    DATABASE_URL: databaseUrlSchema.default(
      'postgresql://postgres:postgres@127.0.0.1:5432/log_service',
    ),
    DB_POOL_MAX: integerSchema(1, 100).default(4),
    DB_IDLE_TIMEOUT_MS: integerSchema(0, 600_000).default(30_000),
    DB_CONNECTION_TIMEOUT_MS: integerSchema(1, 120_000).default(5_000),
    RETENTION_DAYS: integerSchema(1, 3_650).default(90),
    RETENTION_INTERVAL_MS: integerSchema(1_000, 86_400_000).default(60_000),
    RETENTION_BATCH_SIZE: integerSchema(1, 50_000).default(5_000),
    RETENTION_MAX_BATCHES_PER_RUN: integerSchema(1, 100).default(10),
  })
  .superRefine((configuration, context) => {
    if (
      configuration.NODE_ENV === 'production' &&
      configuration.RETENTION_DAYS < 90
    ) {
      context.addIssue({
        code: 'custom',
        path: ['RETENTION_DAYS'],
        message: 'must be at least 90 in production',
      });
    }
  });

export type AppConfig = Readonly<z.infer<typeof configSchema>>;

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';

  constructor(error: z.ZodError) {
    const details = error.issues
      .map(
        (issue) =>
          `${issue.path.join('.') || 'configuration'}: ${issue.message}`,
      )
      .join('; ');

    super(`Invalid environment configuration: ${details}`, { cause: error });
  }
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const result = configSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(result.error);
  }

  return Object.freeze(result.data);
}
