/**
 * Settings: the server and the token, kept in the extension's local storage, and the host
 * permission for that server asked for at the moment it is needed — the manifest asks for none
 * up front beyond the active tab.
 */
import { extensionApi, originPattern } from './browser.js';
import { checkServerUrl } from './url.js';

const api = extensionApi();
const form = document.querySelector<HTMLFormElement>('#settings')!;
const baseUrl = document.querySelector<HTMLInputElement>('#baseUrl')!;
const token = document.querySelector<HTMLInputElement>('#token')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;

void api.storage.local.get(['baseUrl']).then((stored) => {
  if (typeof stored['baseUrl'] === 'string') baseUrl.value = stored['baseUrl'];
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const checked = checkServerUrl(baseUrl.value);
  if (!checked.ok) {
    status.textContent = checked.reason;
    return;
  }
  // The permission prompt must come from the click itself, before any other await.
  void api.permissions.request({ origins: [originPattern(checked.url)] }).then(async (granted) => {
    if (!granted) {
      status.textContent = 'Without permission to reach the server, the connector cannot save anything.';
      return;
    }
    await api.storage.local.set({ baseUrl: checked.url, token: token.value.trim() });
    token.value = '';
    status.textContent = 'Saved.';
  });
});
