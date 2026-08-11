import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from './config.js';
import { runMigrations } from './database/migration-runner.js';
import { createDatabasePool, type PoolFactory } from './database/pool.js';
import { registerHealthRoute } from './routes/health.js';
import { registerLogRoutes } from './routes/logs.js';

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

  app.setErrorHandler((error, _request, reply) => {
    const errorCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    if (errorCode === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return reply.code(400).send({ error: 'Malformed JSON body' });
    }

    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    if (typeof statusCode !== 'number' || statusCode >= 500) {
      app.log.error({ err: error }, 'Request failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }

    return reply.send(error);
  });

  app.decorate('db', pool);
  pool.on('error', (error) => {
    app.log.error({ err: error }, 'Unexpected error from idle database client');
  });
  registerHealthRoute(app);
  registerLogRoutes(app);
  app.addHook('onReady', async () => migrate(pool));
  app.addHook('onClose', async () => pool.end());

  return app;
}
