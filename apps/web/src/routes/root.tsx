/**
 * The application chrome: the one bar that is on every screen, and the health indicator on it.
 *
 * The indicator is not decoration. `/health` reports the library's own counts and whether the
 * store is writable (apps/server/src/health.ts), and a client that silently shows an empty library
 * when the server is degraded is a client that lies. So the state of the server is on screen, in
 * the same place, always.
 */
import { Outlet } from '@tanstack/react-router';

import { useHealth } from '../api/queries.js';

export const RootLayout = (): JSX.Element => (
  <div className="app">
    <header className="app__bar">
      <span className="app__name">Recueil</span>
      <HealthBadge />
    </header>
    <main className="app__main">
      <Outlet />
    </main>
  </div>
);

const HealthBadge = (): JSX.Element => {
  const health = useHealth();

  if (health.isPending) {
    return (
      <span className="badge badge--quiet" role="status">
        Checking the server…
      </span>
    );
  }
  if (health.isError) {
    return (
      <span className="badge badge--error" role="status" title={health.error.problem.detail ?? health.error.problem.title}>
        Server unreachable — {health.error.problem.title}
      </span>
    );
  }

  const items = health.data.library?.items;
  return (
    <span className={`badge badge--${health.data.status === 'ok' ? 'ok' : 'warn'}`} role="status">
      {health.data.status}
      {items === undefined ? '' : ` · ${items} items`}
    </span>
  );
};
