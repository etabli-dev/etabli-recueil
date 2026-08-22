/**
 * Write `spec/openapi.yaml`.
 *
 * Run with `pnpm --filter @recueil/server run openapi`. An explicit output path may be given as the
 * first argument, which is what a drift check uses to render into a temporary file and compare.
 *
 * **Why this and not `packages/schemas`' writer.** P6 says the OpenAPI document is the contract and
 * docs/api.qmd says the document and the implementation "are the same source". `@recueil/schemas`
 * owns the *schemas* and can generate a document from them, but it cannot know which operations a
 * server answers — the Phase 1 route table lives in `apps/server/src/routes`, beside the handlers,
 * so that a route cannot be added without its description. This writer produces the same document
 * the running server serves at `/openapi.json`: the package's schemas, plus every path this server
 * actually implements.
 *
 * `packages/schemas` still has an `openapi` script of its own, and running it would write a
 * document with the Phase 0 operations only. Until `phase1Paths` there is retired or fed from here,
 * **this is the writer that produces the committed file.** See `apps/server/README.md`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderSpecYaml } from '../openapi.js';
import { PACKAGE_VERSION } from '../version.js';

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

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? join(findRepositoryRoot(here), 'spec', 'openapi.yaml');
const yaml = renderSpecYaml({ version: PACKAGE_VERSION });

mkdirSync(dirname(resolve(target)), { recursive: true });
writeFileSync(target, yaml, 'utf8');

process.stdout.write(`wrote ${target} (${yaml.length} bytes)\n`);
