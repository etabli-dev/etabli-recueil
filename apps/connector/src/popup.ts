/** The toolbar button's popup: saving starts on open, and the outcome is said plainly. */
import { extensionApi } from './browser.js';
import type { SaveReply } from './background.js';

const api = extensionApi();
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const detail = document.querySelector<HTMLParagraphElement>('#detail')!;
const open = document.querySelector<HTMLAnchorElement>('#open')!;

document.querySelector('#settings')!.addEventListener('click', (event) => {
  event.preventDefault();
  void api.runtime.openOptionsPage();
});

const say = (text: string, kind: 'ok' | 'error' | 'info', more = ''): void => {
  status.textContent = text;
  status.dataset['kind'] = kind;
  detail.textContent = more;
};

void (api.runtime.sendMessage({ type: 'save' }) as Promise<SaveReply>).then(
  (reply) => {
    if (!reply.ok) {
      say(reply.reason, 'error');
      if (reply.needsSettings === true) void api.runtime.openOptionsPage();
      return;
    }
    const pdf = reply.pdf === 'attached' ? 'with its PDF' : reply.pdf === 'none' ? 'no PDF on the page' : `the PDF was not kept: ${reply.pdf.failed}`;
    say(`Saved: ${reply.title ?? 'untitled'}`, 'ok', pdf);
    open.href = reply.itemUrl;
    open.hidden = false;
  },
  (error: unknown) => say(error instanceof Error ? error.message : String(error), 'error'),
);
