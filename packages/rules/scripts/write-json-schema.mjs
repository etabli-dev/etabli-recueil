#!/usr/bin/env node
/**
 * Write `schema/rule-set.schema.json` from the Zod schema.
 *
 * The artefact is checked in so that the web app and any non-TypeScript consumer can read it
 * without running a build, and `test/json-schema.test.ts` fails when the two drift apart. Run
 * `pnpm --filter @recueil/rules run json-schema` after changing anything under `src/schema/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ruleSetJsonSchema } from '../dist/json-schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'schema', 'rule-set.schema.json');

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(ruleSetJsonSchema(), null, 2)}\n`, 'utf8');
process.stdout.write(`wrote ${target}\n`);
