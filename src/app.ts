import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from './config.js';
import { runMigrations } from './database/migration-runner.js';
import { createDatabasePool, type PoolFactory } from './database/pool.js';
import {
  createLogBatchWriter,
  type LogBatchWriter,
  type LogBatchWriterFactory,
} from './logs/batch-writer.js';
import {
  createRetentionWorker,
  type RetentionWorkerFactory,
} from './retention/worker.js';
import { registerHealthRoute } from './routes/health.js';
import { registerLogRoutes } from './routes/logs.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
    logWriter: LogBatchWriter;
  }
}

export interface AppDependencies {
  createPool: PoolFactory;
  createLogWriter: LogBatchWriterFactory;
  migrate(pool: Pool): Promise<void>;
  createRetention: RetentionWorkerFactory;
}

export function buildApp(
  config: AppConfig,
  dependencies: Partial<AppDependencies> = {},
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
    },
    // Portable equivalent of nginx `client_max_body_size 16m`: Fastify defaults
    // to a 1 MB body limit, which is too small for large ingestion batches.
    bodyLimit: 16 * 1024 * 1024,
  });
  const poolFactory = dependencies.createPool ?? createDatabasePool;
  const migrate = dependencies.migrate ?? runMigrations;
  const pool = poolFactory(config);
  const logWriterFactory = dependencies.createLogWriter ?? createLogBatchWriter;
  const logWriter = logWriterFactory(pool);
  const retentionFactory =
    dependencies.createRetention ?? createRetentionWorker;
  const retention = retentionFactory(pool, config, app.log);

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
  app.decorate('logWriter', logWriter);
  pool.on('error', (error) => {
    app.log.error({ err: error }, 'Unexpected error from idle database client');
  });
  registerHealthRoute(app);
  registerLogRoutes(app);
  app.addHook('onReady', async () => {
    await migrate(pool);
    retention.start();
  });
  app.addHook('onClose', async () => {
    await retention.stop();
    await logWriter.close();
    await pool.end();
  });

  return app;
}
