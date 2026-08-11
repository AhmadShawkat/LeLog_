import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';

export function buildApp(config: AppConfig): FastifyInstance {
  return Fastify({
    logger: {
      level: config.LOG_LEVEL,
    },
  });
}
