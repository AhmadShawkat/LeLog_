import type { FastifyInstance } from 'fastify';

const HEALTH_QUERY = 'SELECT 1';

export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/health', async (_request, reply) => {
    reply.header('cache-control', 'no-store');

    try {
      await app.db.query(HEALTH_QUERY);
      return { status: 'ok', database: 'reachable' };
    } catch (error) {
      app.log.warn({ err: error }, 'Database health check failed');
      return reply
        .code(503)
        .send({ status: 'unavailable', database: 'unreachable' });
    }
  });
}
