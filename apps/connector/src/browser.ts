/**
 * The few WebExtension APIs the connector uses, typed here so the code needs no vendor typings,
 * and resolved to `browser` (Firefox, Safari) or `chrome` (Chromium) at run time. Both expose the
 * promise-returning MV3 forms of these calls.
 */
export interface Tab {
  id?: number;
  url?: string;
  title?: string;
}

export interface ExtensionApi {
  tabs: { query(query: { active: boolean; currentWindow: boolean }): Promise<Tab[]>; create(options: { url: string }): Promise<Tab> };
  scripting: { executeScript<T>(options: { target: { tabId: number }; func: () => T }): Promise<{ result?: T }[]> };
  storage: { local: { get(keys: string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: { addListener(listener: (message: unknown, sender: unknown, respond: (answer: unknown) => void) => boolean | undefined): void };
    openOptionsPage(): Promise<void>;
  };
  permissions: { request(permissions: { origins: string[] }): Promise<boolean>; contains(permissions: { origins: string[] }): Promise<boolean> };
}

export const extensionApi = (): ExtensionApi => {
  const scope = globalThis as { browser?: ExtensionApi; chrome?: ExtensionApi };
  const api = scope.browser ?? scope.chrome;
  if (api === undefined) throw new Error('Not running as a browser extension.');
  return api;
};

export const SETTINGS_KEYS = ['baseUrl', 'token'] as const;

export const readSettings = async (api: ExtensionApi): Promise<{ baseUrl: string; token: string } | null> => {
  const stored = await api.storage.local.get([...SETTINGS_KEYS]);
  const baseUrl = typeof stored['baseUrl'] === 'string' ? stored['baseUrl'] : '';
  const token = typeof stored['token'] === 'string' ? stored['token'] : '';
  return baseUrl === '' || token === '' ? null : { baseUrl, token };
};

/** The origin pattern a server URL needs as a host permission: `https://recueil.example.org/*`. */
export const originPattern = (baseUrl: string): string => `${new URL(baseUrl).origin}/*`;
