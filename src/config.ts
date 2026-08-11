import { z } from 'zod';

const portSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a whole number from 1 to 65535')
  .transform(Number)
  .pipe(z.number().int().max(65_535, 'must be at most 65535'));

const configSchema = z.object({
  HOST: z.string().trim().min(1, 'must not be empty').default('0.0.0.0'),
  PORT: portSchema.default(8080),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
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
