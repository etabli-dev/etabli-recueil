/**
 * The page the app opens on until it knows its server: check the address and the token against
 * the server's health and a token-guarded read, keep them, and hand over to the web client.
 */
import { probeServer } from '../../desktop/shell/probe.js';
import type { ProbeResult } from '../../desktop/shell/probe.js';

import { defaultSettings } from './runtime.js';
import { validateServerUrl } from './settings.js';

const explain = (result: ProbeResult): string => {
  switch (result.kind) {
    case 'connected':
      return result.status === 'ok' ? 'Connected.' : 'Connected; the server reports itself degraded.';
    case 'unreachable':
      return 'The server did not answer. Check the address, and that the phone can reach it.';
    case 'cors-refused':
      return 'The server refused this app. Add capacitor://localhost and https://localhost to RECUEIL_CORS_ORIGIN on the server.';
    case 'not-recueil':
      return `That address answered, but not as a Recueil server (HTTP ${result.httpStatus}).`;
    case 'unhealthy':
      return 'The server answered but reports an error; see its log.';
    case 'token-required':
      return 'This server needs a token.';
    case 'token-refused':
      return 'The server refused the token.';
    case 'api-error':
      return `The server answered with HTTP ${result.httpStatus}.`;
  }
};

const form = document.querySelector<HTMLFormElement>('#connect')!;
const urlInput = document.querySelector<HTMLInputElement>('#url')!;
const tokenInput = document.querySelector<HTMLInputElement>('#token')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const settings = defaultSettings();

const say = (text: string, kind: 'info' | 'error' = 'info'): void => {
  status.textContent = text;
  status.dataset['kind'] = kind;
};

void settings.read().then((current) => {
  if (current !== null) urlInput.value = current.baseUrl;
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const checked = validateServerUrl(urlInput.value);
  if (!checked.ok) return say(checked.reason, 'error');
  const token = tokenInput.value.trim();
  say('Checking…');
  void probeServer(checked.url, token === '' ? {} : { token }).then(async (result) => {
    if (result.kind !== 'connected') return say(explain(result), 'error');
    await settings.write({ baseUrl: checked.url, ...(token === '' ? {} : { token }) });
    say(explain(result));
    window.location.replace('/capture');
  });
});
