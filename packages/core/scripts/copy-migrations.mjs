/**
 * Copy the committed SQL migrations next to the compiled migrator.
 *
 * `tsc` emits JavaScript and nothing else, so `src/db/migrations` — which is data the server reads
 * at runtime, not code — would be missing from a published build. This runs after the build and is
 * the reason `findMigrationsFolder` has a `dist` candidate at all.
 */
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(packageRoot, 'src', 'db', 'migrations');
const to = join(packageRoot, 'dist', 'db', 'migrations');

await mkdir(dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
