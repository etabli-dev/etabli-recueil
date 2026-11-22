import { describe, expect, it } from 'vitest';

import { memorySettings, pluginSettings, validateServerUrl } from '../shell/settings.js';

describe('server address', () => {
  it('takes HTTPS only: the web view would block plain HTTP as mixed content', () => {
    expect(validateServerUrl('https://recueil.example.org/')).toEqual({ ok: true, url: 'https://recueil.example.org' });
    expect(validateServerUrl(' https://example.org/recueil/ ')).toEqual({ ok: true, url: 'https://example.org/recueil' });
    expect(validateServerUrl('http://10.0.2.2:3000')).toMatchObject({ ok: false, reason: expect.stringContaining('HTTPS') });
    expect(validateServerUrl('http://192.168.1.20:3000')).toMatchObject({ ok: false, reason: expect.stringContaining('HTTPS') });
    expect(validateServerUrl('https://user:pw@example.org')).toMatchObject({ ok: false });
    expect(validateServerUrl('recueil')).toMatchObject({ ok: false });
    expect(validateServerUrl('ftp://example.org')).toMatchObject({ ok: false });
  });
});

describe('settings storage', () => {
  it('keeps the token in the secure store and the address in preferences', async () => {
    const prefs = new Map<string, string>();
    const secure = new Map<string, string>();
    const backend = pluginSettings(
      {
        get: async ({ key }) => ({ value: prefs.get(key) ?? null }),
        set: async ({ key, value }) => void prefs.set(key, value),
        remove: async ({ key }) => void prefs.delete(key),
      },
      {
        get: async (key) => secure.get(key) ?? null,
        set: async (key, value) => void secure.set(key, value),
        remove: async (key) => secure.delete(key),
      },
    );
    expect(await backend.read()).toBeNull();
    await backend.write({ baseUrl: 'https://example.org/', token: 'rc_secret' });
    expect([...prefs.values()]).toEqual(['https://example.org']);
    expect([...secure.values()]).toEqual(['rc_secret']);
    expect(await backend.read()).toEqual({ baseUrl: 'https://example.org', token: 'rc_secret' });
    await backend.write({ baseUrl: 'https://example.org' });
    expect(secure.size).toBe(0);
    await expect(backend.write({ baseUrl: 'http://example.org' })).rejects.toThrow(/HTTPS/u);
    await backend.clear();
    expect(await backend.read()).toBeNull();
  });

  it('has an in-memory twin with the same rules', async () => {
    const backend = memorySettings();
    await backend.write({ baseUrl: 'https://a.example/', token: '' });
    expect(await backend.read()).toEqual({ baseUrl: 'https://a.example' });
  });
});
