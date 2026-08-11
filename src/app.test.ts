import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';

const silentConfig: AppConfig = {
  HOST: '127.0.0.1',
  PORT: 8080,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
};

describe('buildApp', () => {
  it('returns a Fastify instance without opening a listener', async () => {
    const app = buildApp(silentConfig);

    expect(typeof app.addHook).toBe('function');
    expect(app.server.listening).toBe(false);

    await app.close();
  });

  it('uses the configured log level', async () => {
    const app = buildApp({ ...silentConfig, LOG_LEVEL: 'fatal' });

    expect(app.log.level).toBe('fatal');

    await app.close();
  });
});
