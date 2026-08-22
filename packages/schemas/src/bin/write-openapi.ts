/**
 * Write `spec/openapi.yaml`.
 *
 * Run with `pnpm --filter @recueil/schemas run openapi`. An explicit output path may be given as
 * the first argument, which is what the CI drift check uses to render into a temporary file and
 * compare.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderOpenApiYaml } from '../openapi/document.js';

/** Walk up from this file until the workspace root — the directory holding pnpm-workspace.yaml. */
const findRepositoryRoot = (from: string): string => {
  let directory = from;
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8');
      return directory;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error(`could not find pnpm-workspace.yaml above ${from}`);
};

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
const repositoryRoot = findRepositoryRoot(here);
const packageRoot = resolve(here, '..', '..');
const target = process.argv[2] ?? join(repositoryRoot, 'spec', 'openapi.yaml');

const yaml = renderOpenApiYaml({ version: readPackageVersion(packageRoot) });

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, yaml, 'utf8');

process.stdout.write(`wrote ${target} (${yaml.length} bytes)\n`);
