/**
 * `create-recueil-plugin` — a new plugin directory with a manifest the host accepts, one working
 * check, its test and the build configuration (CONCEPT §7 Phase 9, spec/hooks.md).
 *
 * The template is a check because a check is read-only, needs no permission and no network, and
 * shows every part of the contract: the manifest hook, the named export, a result with a specific
 * message, and a test that runs it without a host.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

/** `recueil-plugin-shouting-titles` → `Shouting titles`. */
const titleOf = (name) => {
  const base = name.replace(/^@[^/]+\//u, '').replace(/^(recueil-)?plugin-/u, '').replace(/[-_.]+/gu, ' ').trim();
  return base === '' ? 'My plugin' : base[0].toUpperCase() + base.slice(1);
};

export const files = ({ name, displayName = titleOf(name), author = 'Your name', sdk = '^1.0.0', licence = 'MIT' }) => {
  if (!NAME.test(name)) throw new Error(`'${name}' is not a valid npm package name.`);
  const manifest = {
    $schema: 'https://github.com/etabli-dev/etabli-recueil/raw/main/spec/plugin-manifest.schema.json',
    name,
    displayName,
    version: '0.1.0',
    description: 'Warns when an item’s title is written entirely in capitals.',
    author: { name: author },
    licence,
    recueilApi: '^1.0.0',
    main: './dist/index.js',
    permissions: [],
    hooks: [{ type: 'check', id: 'shouting-title', export: 'shoutingTitle', priority: 100, provides: ['shouting-title'] }],
  };
  return {
    'recueil.plugin.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'package.json': `${JSON.stringify(
      {
        name,
        version: '0.1.0',
        description: manifest.description,
        license: licence,
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        files: ['dist', 'recueil.plugin.json', 'README.md'],
        keywords: ['recueil-plugin'],
        engines: { node: '>=22' },
        scripts: { build: 'tsc -p tsconfig.json', test: 'tsc -p tsconfig.json && node --test dist/*.test.js' },
        dependencies: { '@recueil/plugin-sdk': sdk },
        devDependencies: { '@types/node': '^22.20.5', typescript: '^5.9.3' },
      },
      null,
      2,
    )}\n`,
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noUncheckedIndexedAccess: true,
          verbatimModuleSyntax: true,
          declaration: true,
          outDir: 'dist',
          rootDir: 'src',
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
    'src/index.ts': `/**
 * ${displayName}: a Recueil check (spec/hooks.md §6.2).
 *
 * A check is read-only and deterministic for a given item. Its message names the problem — the
 * report shows it verbatim — and a pass says what was looked at.
 */
import type { Check, CheckResult, CheckSubject } from '@recueil/plugin-sdk';

const titleOf = (subject: CheckSubject): string | null => {
  if (subject.type !== 'item') return null;
  const snapshot = subject.snapshot as { title?: unknown; bibliographic?: { title?: unknown } };
  const title = snapshot.bibliographic?.title ?? snapshot.title;
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : null;
};

export const shoutingTitle: Check = {
  id: 'shouting-title',
  title: 'Title in capitals',
  severity: 'info',
  explanation: 'Some databases export titles in capitals. They read badly in a bibliography, and a citation style cannot recover the original case.',
  subjectTypes: ['item'],
  autoFixable: false,
  async run(subject): Promise<CheckResult[]> {
    const title = titleOf(subject);
    const base = { checkId: this.id, subjectType: 'item' as const, subjectId: subject.type === 'item' ? subject.itemId : 'unknown', autoFixable: false };
    if (title === null) return [{ ...base, status: 'skipped', severity: 'info', message: 'the item has no title' }];
    const letters = title.replace(/[^\\p{L}]/gu, '');
    const shouting = letters.length >= 8 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
    return shouting
      ? [{ ...base, status: 'warn', severity: 'info', message: \`the title "\${title.slice(0, 80)}" is written entirely in capitals\` }]
      : [{ ...base, status: 'pass', severity: 'info', message: 'the title is not written entirely in capitals' }];
  },
};
`,
    'src/index.test.ts': `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shoutingTitle } from './index.js';

const item = (title: string) => ({ type: 'item' as const, itemId: '01JD3X8Q7V5ZKM2N4P6R8T0W2Y', snapshot: { title } });
// The check uses nothing from the host context, so a test needs none.
const ctx = {} as Parameters<typeof shoutingTitle.run>[1];

test('warns on a title in capitals', async () => {
  const [result] = await shoutingTitle.run(item('TRANEXAMIC ACID IN HIP FRACTURE SURGERY'), ctx);
  assert.equal(result?.status, 'warn');
  assert.match(result?.message ?? '', /entirely in capitals/u);
});

test('passes an ordinary title, and short acronyms', async () => {
  assert.equal((await shoutingTitle.run(item('Tranexamic acid in hip fracture surgery'), ctx))[0]?.status, 'pass');
  assert.equal((await shoutingTitle.run(item('MRI'), ctx))[0]?.status, 'pass');
});
`,
    'README.md': `# ${displayName}

A [Recueil](https://github.com/etabli-dev/etabli-recueil) plugin. It adds one check, \`shouting-title\`,
that warns when an item's title is written entirely in capitals.

\`\`\`sh
npm install
npm test
npm run build
RECUEIL_PLUGIN_PATH=$PWD/.. recueil plugin list      # the host finds the plugin by its directory
recueil plugin enable ${name}
recueil check --checks shouting-title
\`\`\`

Edit \`src/index.ts\` and the hook in \`recueil.plugin.json\` to make it yours. The contract is
[spec/hooks.md](https://github.com/etabli-dev/etabli-recueil/blob/main/spec/hooks.md); the manifest is
checked against [spec/plugin-manifest.schema.json](https://github.com/etabli-dev/etabli-recueil/blob/main/spec/plugin-manifest.schema.json).
Ask for the fewest permissions that work: this check needs none.
`,
    '.gitignore': 'node_modules/\ndist/\n',
  };
};

export const scaffold = async (directory, options) => {
  const existing = await readdir(directory).catch(() => []);
  if (existing.length > 0) throw new Error(`${directory} is not empty; choose a new directory.`);
  const entries = files(options);
  for (const [path, content] of Object.entries(entries)) {
    await mkdir(join(directory, path, '..'), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  return Object.keys(entries);
};
