// The bin entry has to be executable and has to start with a shebang.
//
// TypeScript preserves a leading `#!` when it emits, so this only has to make sure of it — and
// make the file executable, which tsc has no opinion about. A `pnpm build` that produced a bin
// npm cannot run is the sort of thing that is discovered at install time by someone else.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist', 'index.js');

const source = readFileSync(entry, 'utf8');
if (!source.startsWith('#!')) {
  writeFileSync(entry, `#!/usr/bin/env node\n${source}`);
  console.log(`added the missing shebang to ${entry}`);
}
chmodSync(entry, 0o755);
