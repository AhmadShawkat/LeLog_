import { buildApp } from './app.js';
import type { AppConfig } from './config.js';

export interface ServerInstance {
  listen(options: { host: string; port: number }): Promise<unknown>;
  close(): Promise<void>;
}

export type AppFactory = (config: AppConfig) => ServerInstance;

export async function startServer(
  config: AppConfig,
  createApp: AppFactory = buildApp,
): Promise<ServerInstance> {
  const app = createApp(config);

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    return app;
  } catch (startupError) {
    try {
      await app.close();
    } catch (closeError) {
      throw new AggregateError(
        [startupError, closeError],
        'Server startup failed and cleanup also failed',
        { cause: closeError },
      );
    }

    throw startupError;
  }
}
