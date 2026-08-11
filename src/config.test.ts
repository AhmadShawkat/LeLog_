import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('returns immutable defaults', () => {
    const config = loadConfig({});

    expect(config).toEqual({
      HOST: '0.0.0.0',
      PORT: 8080,
      LOG_LEVEL: 'info',
      NODE_ENV: 'development',
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('parses valid custom configuration', () => {
    expect(
      loadConfig({
        HOST: '127.0.0.1',
        PORT: '65535',
        LOG_LEVEL: 'debug',
        NODE_ENV: 'production',
      }),
    ).toEqual({
      HOST: '127.0.0.1',
      PORT: 65_535,
      LOG_LEVEL: 'debug',
      NODE_ENV: 'production',
    });
  });

  it.each(['', 'abc', '1.5', '0', '-1', '65536', ' 8080', '8080 '])(
    'rejects invalid PORT %j',
    (PORT) => {
      expect(() => loadConfig({ PORT })).toThrow(ConfigurationError);
      expect(() => loadConfig({ PORT })).toThrow(/PORT/);
    },
  );

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('does not expose unrelated environment values in validation errors', () => {
    expect(() =>
      loadConfig({ PORT: 'bad', DATABASE_PASSWORD: 'secret-value' }),
    ).toThrow(/^(?!.*secret-value).*$/s);
  });
});
