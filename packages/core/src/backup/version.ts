/**
 * The version stamped into a manifest.
 *
 * Read from this package's own manifest at runtime rather than baked in, for the same reason the
 * CLI does it: a snapshot that claims to have been written by a version that never existed is
 * worse than no claim at all. `src/backup/` and `dist/backup/` sit at the same depth, so one
 * relative path serves both.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

const read = (): { name: string; version: string } => {
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest === 'object' && manifest !== null) {
      const { name, version } = manifest as { name?: unknown; version?: unknown };
      return {
        name: typeof name === 'string' ? name : '@recueil/core',
        version: typeof version === 'string' ? version : '0.0.0-unknown',
      };
    }
  } catch {
    // A missing manifest is not worth failing a backup over; the field is provenance, not logic.
  }
  return { name: '@recueil/core', version: '0.0.0-unknown' };
};

export const BACKUP_GENERATOR: { readonly name: string; readonly version: string } = read();
