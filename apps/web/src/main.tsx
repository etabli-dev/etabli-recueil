/**
 * The browser entry point.
 *
 * In a browser the base URL is empty: a deployment serves the SPA and the API on one origin, and in
 * development Vite proxies `/api` and `/health` to the server, so a relative path is right in both
 * cases and there is no build-time origin to configure wrongly. Inside the desktop shell the origin
 * is the shell's own, and the shell says where the server is (`host.ts`).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.js';
import { RecueilClient } from './api/client.js';
import { clientOptionsFor, embeddingHost } from './host.js';
import { setAttachmentOpener } from './item-pane/sections/index.js';
import { registerServiceWorker } from './pwa/register.js';
import { createAppRouter } from './router.js';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('index.html is missing its #root element');

const host = embeddingHost();
const router = createAppRouter();
const client = new RecueilClient(host === undefined ? {} : clientOptionsFor(await host.connection()));

// The attachments section is handed to the registry with nothing but the item, so the navigation it
// needs is installed here rather than passed down through props it does not have.
setAttachmentOpener((attachment) => {
  void router.navigate({ to: '/reader/$attachmentId', params: { attachmentId: attachment.id } });
});

createRoot(container).render(
  <StrictMode>
    <App client={client} router={router} />
  </StrictMode>,
);

// The worker adds the share target and an offline shell, and nothing the application needs to
// render. It is registered after the first render and its failure is ignored on purpose
// (`pwa/register.ts`); in development there is no built worker to register, and inside a host
// shell there is no install prompt or share sheet for it to serve.
void registerServiceWorker({ enabled: import.meta.env.PROD && host === undefined });
