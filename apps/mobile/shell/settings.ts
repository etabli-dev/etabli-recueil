/**
 * Where the server is and which token to use, kept on the phone.
 *
 * The address is ordinary configuration (Capacitor Preferences); the token is a credential and
 * goes to the platform's secure store — the iOS Keychain, Android's Keystore-backed storage —
 * never to Preferences or `localStorage` (ADR-0024).
 */
export interface Settings {
  baseUrl: string;
  token?: string;
}

export interface SettingsBackend {
  read(): Promise<Settings | null>;
  write(settings: Settings): Promise<void>;
  clear(): Promise<void>;
}

/** Hosts a phone may reach over plain HTTP: the device itself and the Android emulator's host. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '10.0.2.2']);

/**
 * A server address a phone may use: HTTPS, or HTTP to a loopback address for development. App
 * Transport Security on iOS and Android's cleartext default would refuse anything else anyway; this
 * says so before the first request rather than after it.
 */
export const validateServerUrl = (raw: string): { ok: true; url: string } | { ok: false; reason: string } => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'That is not a web address. It looks like https://recueil.example.org.' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'Leave the user name and password out of the address; use a token.' };
  if (url.protocol === 'https:') return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/u, '')}` };
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/u, '')}` };
  if (url.protocol === 'http:') return { ok: false, reason: 'A phone talks to the server over HTTPS. Put the server behind TLS (deploy/README.md) and use its https:// address.' };
  return { ok: false, reason: `'${url.protocol}' is not a protocol the app can use.` };
};

const URL_KEY = 'recueil.server.url';
const TOKEN_KEY = 'recueil.server.token';

interface PreferencesLike {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

interface SecureStoreLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<unknown>;
}

/** The backend over Capacitor Preferences and the secure store. */
export const pluginSettings = (preferences: PreferencesLike, secure: SecureStoreLike): SettingsBackend => ({
  read: async () => {
    const { value } = await preferences.get({ key: URL_KEY });
    if (value === null || value === '') return null;
    const token = await secure.get(TOKEN_KEY).catch(() => null);
    return { baseUrl: value, ...(typeof token === 'string' && token !== '' ? { token } : {}) };
  },
  write: async (settings) => {
    const checked = validateServerUrl(settings.baseUrl);
    if (!checked.ok) throw new Error(checked.reason);
    await preferences.set({ key: URL_KEY, value: checked.url });
    if (settings.token === undefined || settings.token === '') await secure.remove(TOKEN_KEY).catch(() => undefined);
    else await secure.set(TOKEN_KEY, settings.token);
  },
  clear: async () => {
    await preferences.remove({ key: URL_KEY });
    await secure.remove(TOKEN_KEY).catch(() => undefined);
  },
});

/** An in-memory backend, for tests and for a browser preview of the shell. */
export const memorySettings = (initial: Settings | null = null): SettingsBackend => {
  let current = initial;
  return {
    read: async () => (current === null ? null : { ...current }),
    write: async (settings) => {
      const checked = validateServerUrl(settings.baseUrl);
      if (!checked.ok) throw new Error(checked.reason);
      current = { baseUrl: checked.url, ...(settings.token === undefined || settings.token === '' ? {} : { token: settings.token }) };
    },
    clear: async () => {
      current = null;
    },
  };
};
