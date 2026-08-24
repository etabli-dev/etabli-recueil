/**
 * Registering the service worker.
 *
 * Deliberately quiet: a registration that fails must not break the application, because everything
 * the worker does is an addition — the share target and an offline shell — and none of it is on the
 * path of a normal session. A browser without service workers, a page served over plain HTTP on a
 * LAN address, a user who has disabled them: all three are supported configurations of the web
 * client, and all three simply do not get the share target.
 *
 * The worker is not registered in development. Vite serves modules from source and the built worker
 * does not exist there, so registering it would install a worker that 404s and then caches the
 * failure.
 */

export interface RegisterOptions {
  /** `/service-worker.js`, which is where the build emits it with a stable, unhashed name. */
  scriptUrl?: string;
  /** False in development. */
  enabled?: boolean;
}

export const registerServiceWorker = async (options: RegisterOptions = {}): Promise<ServiceWorkerRegistration | null> => {
  const { scriptUrl = '/service-worker.js', enabled = true } = options;
  if (!enabled) return null;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  // A worker only runs on a secure origin; `localhost` counts, a bare LAN address over HTTP does not.
  if (typeof window !== 'undefined' && !window.isSecureContext) return null;

  try {
    return await navigator.serviceWorker.register(scriptUrl, { type: 'module', scope: '/' });
  } catch {
    return null;
  }
};
