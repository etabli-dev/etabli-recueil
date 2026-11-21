// Regenerate src/types.generated.ts from the TypeScript blocks of spec/hooks.md.
//
// The specification is the contract (spec/plugin-api.md §1); the SDK types are a mechanical copy of
// it, so the two cannot drift. Run `node scripts/generate-types.mjs` after changing hooks.md, or
// `node scripts/generate-types.mjs --check` to fail when the committed file is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, '..', '..', '..', 'spec', 'hooks.md');
const outPath = join(here, '..', 'src', 'types.generated.ts');

export const generate = (spec) => {
  const blocks = [...spec.matchAll(/```ts\n([\s\S]*?)```/gu)].map((match) => match[1]);
  const body = blocks
    // The error hierarchy is declared in the spec and implemented, as real classes, in errors.ts.
    .filter((block) => !/^declare class PluginError/mu.test(block))
    .map((block) => block.replace(/^(interface|type) /gmu, 'export $1 ').trimEnd() + '\n')
    .join('\n');
  return [
    '/**',
    ' * The plugin API types, generated from the TypeScript blocks of `spec/hooks.md` by',
    ' * `scripts/generate-types.mjs`. The specification is the source: change it and regenerate, never',
    ' * edit this file by hand. `pnpm test` fails when the two disagree.',
    ' */',
    '/* eslint-disable */',
    "import type { HostApiTypes } from './host-apis.js';",
    "type SettingsHandle = HostApiTypes['SettingsHandle'];",
    "type Logger = HostApiTypes['Logger'];",
    "type LibraryApi = HostApiTypes['LibraryApi'];",
    "type GraphApi = HostApiTypes['GraphApi'];",
    "type SearchApi = HostApiTypes['SearchApi'];",
    "type SystematicReviewApi = HostApiTypes['SystematicReviewApi'];",
    "type StorageApi = HostApiTypes['StorageApi'];",
    "type JobsApi = HostApiTypes['JobsApi'];",
    "type HttpApi = HostApiTypes['HttpApi'];",
    "type EventsApi = HostApiTypes['EventsApi'];",
    "type CacheApi = HostApiTypes['CacheApi'];",
    "type ScratchApi = HostApiTypes['ScratchApi'];",
    '',
    body,
  ].join('\n');
};

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const next = generate(readFileSync(specPath, 'utf8'));
  if (process.argv.includes('--check')) {
    if (readFileSync(outPath, 'utf8') !== next) {
      console.error('src/types.generated.ts is stale: run node scripts/generate-types.mjs');
      process.exit(1);
    }
  } else {
    writeFileSync(outPath, next);
  }
}
