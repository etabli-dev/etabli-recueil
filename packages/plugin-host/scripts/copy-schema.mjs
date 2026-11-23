// The manifest schema is part of the plugin API (spec/plugin-api.md §1); the host validates
// against the copy shipped beside its compiled code, so a packaged build does not need the spec tree.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, '..', 'dist'), { recursive: true });
copyFileSync(join(here, '..', '..', '..', 'spec', 'plugin-manifest.schema.json'), join(here, '..', 'dist', 'plugin-manifest.schema.json'));
