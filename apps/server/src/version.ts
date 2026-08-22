/**
 * What version this server says it is.
 *
 * Three sources, in order: an explicit argument (the CLI, a test), `RECUEIL_VERSION` (stamped into
 * the image at build time — deploy/Dockerfile), and finally this package's own `version` field.
 *
 * The manifest is read through `createRequire` rather than imported, because `package.json` sits
 * outside `rootDir` and a JSON import would drag it into the compiler's output tree. The relative
 * path resolves the same from `src/` under Vitest and from `dist/` in a build, which is the whole
 * reason the file is one level below both.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
}

const manifest = require('../package.json') as PackageManifest;

/** The version in `apps/server/package.json`. */
export const PACKAGE_VERSION = manifest.version ?? '0.0.0';

/** The npm name, so `/api/v1/system/info` does not hard-code it in two places. */
export const PACKAGE_NAME = manifest.name ?? '@recueil/server';

/** Resolve the version to report, preferring an explicit value, then the environment. */
export const resolveVersion = (
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const fromEnv = env.RECUEIL_VERSION?.trim();
  return explicit ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : PACKAGE_VERSION);
};
