/**
 * The environment parser.
 *
 * The behaviour worth testing is the failure: a server that starts with a mistyped variable and
 * silently uses a default is a server that listens on the wrong port at three in the morning. Every
 * bad value must stop the boot and name itself.
 */
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig defaults', () => {
  it('gives a laptop the right defaults', () => {
    const config = loadConfig({});

    expect(config.port).toBe(3000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.databaseUrl).toBe('file:./data/recueil.db');
    expect(config.storagePath).toBe(resolve('./data/storage'));
    expect(config.logLevel).toBe('info');
    expect(config.mode).toBe('server');
    expect(config.corsOrigin).toBe(false);
    expect(config.trustProxy).toBe(false);
  });

  it('treats an empty variable as unset, because `FOO=` is what a .env file looks like', () => {
    const config = loadConfig({ RECUEIL_PORT: '', RECUEIL_HOST: '   ', RECUEIL_BASE_URL: '' });
    expect(config.port).toBe(3000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.baseUrl).toBeUndefined();
  });

  it('resolves the storage path, so it does not move with the working directory', () => {
    const config = loadConfig({ RECUEIL_STORAGE_PATH: './var/store' });
    expect(config.storagePath).toBe(resolve('./var/store'));
  });
});

describe('loadConfig overrides', () => {
  it('reads what the container image sets', () => {
    const config = loadConfig({
      RECUEIL_HOST: '0.0.0.0',
      RECUEIL_PORT: '8080',
      RECUEIL_DATABASE_URL: 'file:/data/recueil.sqlite',
      RECUEIL_STORAGE_PATH: '/data/storage',
      RECUEIL_LOG_LEVEL: 'warn',
    });

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.databaseUrl).toBe('file:/data/recueil.sqlite');
    expect(config.storagePath).toBe('/data/storage');
    expect(config.logLevel).toBe('warn');
  });

  it('parses a CORS origin list, and `*` on its own', () => {
    expect(loadConfig({ RECUEIL_CORS_ORIGIN: '*' }).corsOrigin).toBe(true);
    expect(loadConfig({ RECUEIL_CORS_ORIGIN: 'https://a.example, https://b.example' }).corsOrigin).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('accepts the booleans people actually type', () => {
    for (const value of ['1', 'true', 'yes', 'on']) {
      expect(loadConfig({ RECUEIL_TRUST_PROXY: value }).trustProxy).toBe(true);
    }
    for (const value of ['0', 'false', 'no', 'off']) {
      expect(loadConfig({ RECUEIL_TRUST_PROXY: value }).trustProxy).toBe(false);
    }
  });
});

describe('loadConfig failures', () => {
  it('refuses a port that is not a port, and names the variable', () => {
    expect(() => loadConfig({ RECUEIL_PORT: 'eight thousand' })).toThrow(ConfigError);

    try {
      loadConfig({ RECUEIL_PORT: '70000' });
      expect.unreachable('a port above 65535 must not be accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues.map((issue) => issue.variable)).toContain('RECUEIL_PORT');
      expect((error as ConfigError).message).toContain('RECUEIL_PORT');
    }
  });

  it('refuses a log level pino does not have', () => {
    expect(() => loadConfig({ RECUEIL_LOG_LEVEL: 'chatty' })).toThrow(ConfigError);
  });

  it('refuses a base URL that is not a URL', () => {
    expect(() => loadConfig({ RECUEIL_BASE_URL: 'recueil.example.org' })).toThrow(ConfigError);
  });

  it('reports every bad variable at once, not the first', () => {
    try {
      loadConfig({ RECUEIL_PORT: 'x', RECUEIL_LOG_LEVEL: 'y', RECUEIL_TRUST_PROXY: 'z' });
      expect.unreachable('three bad variables must not be accepted');
    } catch (error) {
      const issues = (error as ConfigError).issues.map((issue) => issue.variable);
      expect(issues).toEqual(
        expect.arrayContaining(['RECUEIL_PORT', 'RECUEIL_LOG_LEVEL', 'RECUEIL_TRUST_PROXY']),
      );
    }
  });
});
