import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from './config.js';
import { runMigrations } from './database/migration-runner.js';
import { createDatabasePool, type PoolFactory } from './database/pool.js';
import { registerHealthRoute } from './routes/health.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
  }
}

export interface AppDependencies {
  createPool: PoolFactory;
  migrate(pool: Pool): Promise<void>;
}

export function buildApp(
  config: AppConfig,
  dependencies: Partial<AppDependencies> = {},
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
    },
  });
  const poolFactory = dependencies.createPool ?? createDatabasePool;
  const migrate = dependencies.migrate ?? runMigrations;
  const pool = poolFactory(config);

  app.decorate('db', pool);
  pool.on('error', (error) => {
    app.log.error({ err: error }, 'Unexpected error from idle database client');
  });
  registerHealthRoute(app);
  app.addHook('onReady', async () => migrate(pool));
  app.addHook('onClose', async () => pool.end());

  return app;
}
