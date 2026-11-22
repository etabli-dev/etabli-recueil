import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const index = JSON.parse(readFileSync(join(root, 'registry/index.json'), 'utf8')) as {
  schema: string;
  plugins: { name: string; recueilApi: string; hooks: string[]; permissions: string[]; repository: string; source: { type: string }; integrity?: string }[];
};

describe('the plugin registry index (spec/plugin-registry.md)', () => {
  it('lists each first-party plugin with exactly what its manifest declares', () => {
    expect(index.schema).toBe('recueil.plugin-registry/1');
    for (const entry of index.plugins.filter((plugin) => plugin.source.type === 'builtin')) {
      const directory = entry.repository.split('/tree/main/')[1]!;
      const manifest = JSON.parse(readFileSync(join(root, directory, 'recueil.plugin.json'), 'utf8')) as { name: string; recueilApi: string; permissions?: string[]; hooks?: { type: string }[] };
      expect(entry.name).toBe(manifest.name);
      expect(entry.recueilApi).toBe(manifest.recueilApi);
      expect(entry.permissions).toEqual(manifest.permissions ?? []);
      expect(entry.hooks).toEqual([...new Set((manifest.hooks ?? []).map((hook) => hook.type))].sort());
    }
  });

  it('carries an integrity hash for anything fetched by URL', () => {
    for (const entry of index.plugins.filter((plugin) => plugin.source.type === 'url')) expect(entry.integrity).toMatch(/^sha512-/u);
  });
});
