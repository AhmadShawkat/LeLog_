import type { FastifyInstance } from 'fastify';
import { ingestLogBatch } from '../logs/ingestion.js';

export function registerLogRoutes(app: FastifyInstance): void {
  app.post('/logs', async (request, reply) => {
    const result = await ingestLogBatch(app.db, request.body);

    if (!result) {
      return reply
        .code(400)
        .send({ error: 'Body must contain only a non-empty logs array' });
    }

    if (result.accepted === 0) {
      return reply.code(400).send(result);
    }

    return result;
  });
}
