import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The version, read from this package's own manifest.
 *
 * Read at runtime rather than baked in by the build, so that `recueil --version` cannot drift from
 * what the package claims to be. `src/version.ts` and `dist/version.js` sit at the same depth, so
 * the same relative path works whether the CLI is running from source under tsx or from the build.
 */
const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

const readVersion = (): string => {
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
      const { version } = manifest as { version?: unknown };
      if (typeof version === 'string' && version.length > 0) return version;
    }
  } catch {
    // A missing or unreadable manifest is not worth failing a `--version` over.
  }
  return '0.0.0-unknown';
};

export const VERSION: string = readVersion();
