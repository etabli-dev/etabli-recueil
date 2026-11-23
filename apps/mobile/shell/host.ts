/**
 * The host script, loaded by the assembled `index.html` ahead of the web client's entry: it
 * installs `globalThis.recueilHost` — where the server is, with which token, and what the phone
 * can capture with (`apps/web/src/host.ts`). With no server configured yet, the app opens on the
 * connection page instead.
 */
import { defaultSettings, nativeCapabilities } from './runtime.js';
import type { Capabilities } from './runtime.js';
import type { Settings, SettingsBackend } from './settings.js';

export interface MobileHost {
  connection(): Promise<{ baseUrl: string; token?: string }>;
  readonly capabilities: Capabilities;
}

export const CONNECTION_PAGE = '/shell/connect.html';

export const createHost = (settings: SettingsBackend, capabilities: Capabilities, onMissing: () => void): MobileHost =>
  Object.freeze({
    connection: async (): Promise<Settings> => {
      const current = await settings.read();
      if (current === null) {
        onMissing();
        throw new Error('No server is configured yet.');
      }
      return current;
    },
    capabilities,
  });

export const installHost = (scope: { recueilHost?: MobileHost }, host: MobileHost): void => {
  Object.defineProperty(scope, 'recueilHost', { value: host, writable: false, configurable: false, enumerable: false });
};

if (typeof window !== 'undefined' && !(globalThis as { recueilHostTest?: boolean }).recueilHostTest) {
  installHost(globalThis as { recueilHost?: MobileHost }, createHost(defaultSettings(), nativeCapabilities(), () => window.location.replace(CONNECTION_PAGE)));
}
