/**
 * Which plugins the data commands load (spec/plugin-api.md §3.2).
 *
 * The three first-party plugins ship with the CLI and are found where npm put them. Further plugins
 * are directories named in `RECUEIL_PLUGIN_PATH` (colon-separated), each holding a
 * `recueil.plugin.json`. Nothing is enabled by being found: `recueil plugin enable` does that.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import { PluginHost } from '@recueil/plugin-host';
import type { PluginSource } from '@recueil/plugin-host';
import type { Recueil } from '@recueil/core';

import type { Ui } from './ui.js';

const require = createRequire(import.meta.url);

export const BUILTIN_PLUGINS = [
  '@recueil/plugin-resolvers-core',
  '@recueil/plugin-checks-core',
  '@recueil/plugin-dedup-core',
] as const;

export const pluginSources = (env: NodeJS.ProcessEnv = process.env): PluginSource[] => {
  const sources: PluginSource[] = BUILTIN_PLUGINS.map((name) => ({
    directory: dirname(require.resolve(`${name}/package.json`)),
    source: 'builtin' as const,
  }));
  for (const entry of (env['RECUEIL_PLUGIN_PATH'] ?? '').split(':')) {
    if (entry.trim() !== '') sources.push({ directory: resolve(entry.trim()), source: 'local' });
  }
  return sources;
};

export const bootHost = async (recueil: Recueil, ui: Ui): Promise<PluginHost> => {
  const host = new PluginHost(recueil, {
    plugins: pluginSources(),
    log: (level, message) => {
      if (level === 'error' || level === 'warn') ui.warn(message);
      else if (level === 'info') ui.info(message);
    },
  });
  await host.boot();
  return host;
};
