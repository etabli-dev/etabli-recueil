/**
 * The connection page, which the window opens on.
 *
 * On a normal start it checks the configured server — or, on the first run, the address
 * `recueil serve` listens on by default — and hands over to the web client the moment the server
 * answers and accepts this application, so a working setup sees this page for a fraction of a
 * second. When the server does not answer, or answers but refuses, the page stays and says which,
 * with the one thing to change. Opened from the Server menu (`?edit`) it never hands over by
 * itself.
 */
import { checkServerUrl, connection, describeError, saveConnection, shellState } from './bridge.js';
import type { Connection, ShellState } from './bridge.js';
import { diagnose, shellOrigin } from './diagnosis.js';
import type { Diagnosis } from './diagnosis.js';
import { probeServer } from './probe.js';
import type { ProbeResult } from './probe.js';

/** The web client's root, served from the same origin as this page. */
const LIBRARY_PATH = '/';

const editing = new URLSearchParams(window.location.search).has('edit');
const origin = shellOrigin(window.location);

const byId = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`connect.html is missing #${id}`);
  return found as T;
};

const ui = {
  status: byId<HTMLElement>('status'),
  statusTitle: byId<HTMLElement>('status-title'),
  statusDetail: byId<HTMLElement>('status-detail'),
  statusCode: byId<HTMLElement>('status-code'),
  form: byId<HTMLFormElement>('settings'),
  serverUrl: byId<HTMLInputElement>('server-url'),
  token: byId<HTMLInputElement>('token'),
  tokenHint: byId<HTMLElement>('token-hint'),
  forgetRow: byId<HTMLElement>('forget-token-row'),
  forget: byId<HTMLInputElement>('forget-token'),
  formError: byId<HTMLElement>('form-error'),
  test: byId<HTMLButtonElement>('test'),
  save: byId<HTMLButtonElement>('save'),
  continueButton: byId<HTMLButtonElement>('continue'),
  settingsNote: byId<HTMLElement>('settings-note'),
};

let state: ShellState | null = null;

const show = (diagnosis: Diagnosis | { tone: 'pending'; title: string; detail: string; code?: string }): void => {
  ui.status.dataset.tone = diagnosis.tone;
  ui.statusTitle.textContent = diagnosis.title;
  ui.statusDetail.textContent = diagnosis.detail;
  ui.statusCode.hidden = diagnosis.code === undefined;
  ui.statusCode.textContent = diagnosis.code ?? '';
};

const showFormError = (message: string | null): void => {
  ui.formError.hidden = message === null;
  ui.formError.textContent = message ?? '';
};

const setBusy = (busy: boolean): void => {
  for (const button of [ui.test, ui.save, ui.continueButton]) button.disabled = busy;
};

const render = (next: ShellState): void => {
  state = next;
  ui.serverUrl.value = next.serverUrl;
  ui.token.value = '';
  ui.forget.checked = false;

  const hints = [
    'Only needed when the server runs with RECUEIL_REQUIRE_AUTH=true. Kept in the system credential store, never in a file.',
  ];
  if (next.token === 'stored') {
    hints.push('A token for this server is stored; leave the field empty to keep it.');
  } else if (next.token === 'session') {
    hints.push('A token for this server is held for this session only.');
  }
  if (next.credentialStoreProblem !== null) {
    hints.push('No system credential store is available here, so a token entered now lasts until the application closes.');
  }
  ui.tokenHint.textContent = hints.join(' ');
  // The platform's own wording is long and technical: available on hover, and in the log.
  ui.tokenHint.title = next.credentialStoreProblem ?? '';
  ui.forgetRow.hidden = next.token === 'none';

  ui.settingsNote.textContent =
    next.settingsProblem !== null
      ? `The settings file could not be used — ${next.settingsProblem} — so the default address is in use until you save.`
      : next.saved
        ? 'The settings file in your per-user configuration directory holds the server address and nothing else.'
        : `Nothing is saved yet, so the default address is in use: ${next.defaultServerUrl}, where recueil serve listens.`;
};

const check = async (serverUrl: string, token: string | undefined): Promise<ProbeResult> => {
  show({ tone: 'pending', title: 'Checking the server…', detail: serverUrl });
  const result = await probeServer(serverUrl, token === undefined ? {} : { token });
  show(diagnose(result, serverUrl, origin));
  return result;
};

const openLibrary = (): void => {
  window.location.replace(LIBRARY_PATH);
};

/** The typed address in canonical form, or null with the reason shown. */
const typedAddress = async (): Promise<string | null> => {
  try {
    const normalised = await checkServerUrl(ui.serverUrl.value);
    showFormError(null);
    return normalised;
  } catch (error) {
    showFormError(describeError(error));
    ui.serverUrl.focus();
    return null;
  }
};

/** The token to test with: the one typed, else the stored one if the address is unchanged. */
const tokenForTest = async (serverUrl: string): Promise<string | undefined> => {
  const typed = ui.token.value.trim();
  if (typed !== '') return typed;
  if (state !== null && serverUrl === state.serverUrl && state.token !== 'none') {
    return (await connection()).token;
  }
  return undefined;
};

ui.test.addEventListener('click', () => {
  void (async () => {
    setBusy(true);
    try {
      const serverUrl = await typedAddress();
      if (serverUrl !== null) await check(serverUrl, await tokenForTest(serverUrl));
    } catch (error) {
      showFormError(describeError(error));
    } finally {
      setBusy(false);
    }
  })();
});

ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    setBusy(true);
    try {
      const serverUrl = await typedAddress();
      if (serverUrl === null) return;
      const typed = ui.token.value.trim();
      try {
        render(
          await saveConnection({
            serverUrl,
            ...(typed === '' ? {} : { token: typed }),
            forgetToken: ui.forget.checked,
          }),
        );
        const current = await connection();
        const result = await check(current.baseUrl, current.token);
        if (result.kind === 'connected') openLibrary();
      } catch (error) {
        showFormError(describeError(error));
      }
    } finally {
      setBusy(false);
    }
  })();
});

ui.continueButton.addEventListener('click', openLibrary);

const start = async (): Promise<void> => {
  let current: Connection;
  try {
    render(await shellState());
    current = await connection();
  } catch (error) {
    show({ tone: 'error', title: 'The application could not read its settings', detail: describeError(error) });
    ui.form.hidden = false;
    return;
  }

  const result = await check(current.baseUrl, current.token);
  if (result.kind === 'connected' && !editing) {
    openLibrary();
    return;
  }
  ui.form.hidden = false;
  ui.continueButton.hidden = result.kind !== 'connected';
  ui.serverUrl.focus();
};

void start();
