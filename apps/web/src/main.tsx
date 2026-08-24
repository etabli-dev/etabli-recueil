/**
 * The browser entry point.
 *
 * The base URL is empty: in production the SPA is served by the Fastify app and in development
 * Vite proxies `/api` and `/health` to it, so a relative path is right in both cases and there is
 * no build-time origin to configure wrongly.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.js';
import { RecueilClient } from './api/client.js';
import { setAttachmentOpener } from './item-pane/sections/index.js';
import { registerServiceWorker } from './pwa/register.js';
import { createAppRouter } from './router.js';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('index.html is missing its #root element');

const router = createAppRouter();
const client = new RecueilClient();

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
// (`pwa/register.ts`); in development there is no built worker to register.
void registerServiceWorker({ enabled: import.meta.env.PROD });
