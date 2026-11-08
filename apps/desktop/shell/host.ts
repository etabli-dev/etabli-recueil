/**
 * The host script: loaded by the assembled `index.html` ahead of the web client's entry.
 *
 * It installs `globalThis.recueilHost`, the one-question contract `apps/web/src/host.ts` defines:
 * where is the server, and with which token. Module scripts run in document order, so this has
 * run before the web client's entry looks for it.
 */
import { connection } from './bridge.js';
import type { Connection } from './bridge.js';

export interface RecueilHost {
  connection(): Promise<Connection>;
}

/** Where a failed answer sends the window: the page that can explain it. */
export const CONNECTION_PAGE = '/shell/connect.html?edit';

export const installHost = (scope: { recueilHost?: RecueilHost }, ask: () => Promise<Connection> = connection): void => {
  Object.defineProperty(scope, 'recueilHost', {
    value: Object.freeze({ connection: ask }),
    writable: false,
    configurable: false,
    enumerable: false,
  });
};

/**
 * The shell's answer, or — if the shell cannot give one — the connection page instead of a web
 * client with no server to talk to.
 */
const askTheShell = async (): Promise<Connection> => {
  try {
    return await connection();
  } catch (error) {
    window.location.replace(CONNECTION_PAGE);
    throw error;
  }
};

installHost(globalThis as { recueilHost?: RecueilHost }, askTheShell);
