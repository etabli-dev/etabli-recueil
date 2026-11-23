import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateManifest } from '@recueil/plugin-host';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- plain ES module without type declarations
import { files, scaffold } from '../src/scaffold.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'create-recueil-plugin-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('create-recueil-plugin', () => {
  it('writes a plugin whose manifest the host accepts, with the export the hook names', async () => {
    const written = (await scaffold(join(dir, 'shouting'), { name: 'recueil-plugin-shouting-titles', author: 'Ada' })) as string[];
    expect(written.sort()).toEqual(['.gitignore', 'README.md', 'package.json', 'recueil.plugin.json', 'src/index.test.ts', 'src/index.ts', 'tsconfig.json']);
    const manifest = JSON.parse(readFileSync(join(dir, 'shouting', 'recueil.plugin.json'), 'utf8')) as { hooks: { export: string }[] };
    expect(validateManifest(manifest)).toMatchObject({ ok: true });
    const source = readFileSync(join(dir, 'shouting', 'src', 'index.ts'), 'utf8');
    for (const hook of manifest.hooks) expect(source).toContain(`export const ${hook.export}: Check`);
    expect(JSON.parse(readFileSync(join(dir, 'shouting', 'package.json'), 'utf8'))).toMatchObject({ name: 'recueil-plugin-shouting-titles', dependencies: { '@recueil/plugin-sdk': '^1.0.0' } });
  });

  it('refuses a bad package name and a directory that is not empty', async () => {
    expect(() => files({ name: 'Not Valid' })).toThrow(/npm package name/u);
    await scaffold(join(dir, 'a'), { name: 'recueil-plugin-a' });
    await expect(scaffold(join(dir, 'a'), { name: 'recueil-plugin-a' })).rejects.toThrow(/not empty/u);
  });
});
