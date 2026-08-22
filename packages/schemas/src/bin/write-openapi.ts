/**
 * Write this package's OpenAPI document to a named file.
 *
 * **This is not the writer of the committed contract.** `spec/openapi.yaml` is produced by
 * `pnpm --filter @recueil/server run openapi`, because only the server knows which operations it
 * answers: that writer takes the document built here and merges the path items declared beside the
 * handlers over it. Rendering this package's document straight into `spec/openapi.yaml` would
 * silently drop every Phase 1 route, so the destination is required rather than defaulted.
 *
 * Run with `pnpm --filter @recueil/schemas run openapi -- <path>` — which is what a drift check
 * does when it renders into a temporary file and compares the components.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderOpenApiYaml } from '../openapi/document.js';

const readPackageVersion = (packageRoot: string): string => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const { version } = parsed as { version?: unknown };
      if (typeof version === 'string') return version;
    }
  } catch {
    // A missing or unreadable package.json is not a reason to refuse to generate the document.
  }
  return '0.0.0';
};

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');
const target = process.argv[2];

if (target === undefined) {
  process.stderr.write(
    'usage: write-openapi <path>\n\n' +
      'The committed contract is written by `pnpm --filter @recueil/server run openapi`; this\n' +
      "writer renders this package's document alone, so it needs an explicit destination.\n",
  );
  process.exit(2);
}

const yaml = renderOpenApiYaml({ version: readPackageVersion(packageRoot) });

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, yaml, 'utf8');

process.stdout.write(`wrote ${target} (${yaml.length} bytes)\n`);
