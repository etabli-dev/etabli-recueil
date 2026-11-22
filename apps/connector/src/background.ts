/**
 * The service worker: on a `save` message from the popup, read the active tab's metadata in the
 * page, and save it to the configured server. The PDF is fetched from here, where the extension's
 * host permission for the publisher applies and the user's own session cookies are sent.
 */
import { extensionApi, readSettings } from './browser.js';
import { extractPageMetadata } from './extract.js';
import type { PageMetadata } from './extract.js';
import { SaveError, saveToRecueil } from './save.js';

export type SaveReply =
  | { ok: true; itemId: string; title: string | null; pdf: 'attached' | 'none' | { failed: string }; itemUrl: string }
  | { ok: false; reason: string; needsSettings?: boolean };

const api = extensionApi();

const save = async (): Promise<SaveReply> => {
  const settings = await readSettings(api);
  if (settings === null) return { ok: false, reason: 'Set the server address and a token first.', needsSettings: true };
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || tab.url === undefined || !/^https?:/u.test(tab.url)) return { ok: false, reason: 'This page cannot be saved (only web pages can).' };
  let meta: PageMetadata;
  try {
    const [injected] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageMetadata as () => PageMetadata });
    if (injected?.result === undefined) return { ok: false, reason: 'The page did not answer.' };
    meta = injected.result;
  } catch (error) {
    return { ok: false, reason: `The page could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const outcome = await saveToRecueil(settings, meta);
    return { ok: true, itemId: outcome.itemId, title: meta.title, pdf: outcome.pdf, itemUrl: `${settings.baseUrl.replace(/\/+$/u, '')}/?item=${encodeURIComponent(outcome.itemId)}` };
  } catch (error) {
    if (error instanceof SaveError && (error.status === 401 || error.status === 403)) return { ok: false, reason: 'The server refused the token; check it in the settings.', needsSettings: true };
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
};

api.runtime.onMessage.addListener((message, _sender, respond) => {
  if ((message as { type?: string } | null)?.type !== 'save') return undefined;
  void save().then(respond);
  return true;
});
