/**
 * Reading and validating `recueil.plugin.json` (spec/plugin-api.md §3.3).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PluginManifest } from '@recueil/plugin-sdk';
import { PLUGIN_API_VERSION } from '@recueil/plugin-sdk';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import semver from 'semver';

const here = dirname(fileURLToPath(import.meta.url));

type Ajv2020Instance = InstanceType<typeof Ajv2020Module.default>;
let compiled: ReturnType<Ajv2020Instance['compile']> | null = null;

const manifestValidator = () => {
  if (compiled !== null) return compiled;
  const candidates = [
    join(here, 'plugin-manifest.schema.json'),
    join(here, '..', 'dist', 'plugin-manifest.schema.json'),
    join(here, '..', '..', '..', 'spec', 'plugin-manifest.schema.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) throw new Error(`plugin-manifest.schema.json not found (looked in ${candidates.join(', ')})`);
  const Ajv2020 = Ajv2020Module.default;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  (addFormatsModule as unknown as { default: (ajv: Ajv2020Instance) => void }).default(ajv);
  compiled = ajv.compile(JSON.parse(readFileSync(path, 'utf8')) as object);
  return compiled;
};

export interface ManifestProblem {
  path: string;
  message: string;
}

export const validateManifest = (value: unknown): { ok: true; manifest: PluginManifest } | { ok: false; problems: ManifestProblem[] } => {
  const validate = manifestValidator();
  if (validate(value)) return { ok: true, manifest: value as PluginManifest };
  return {
    ok: false,
    problems: (validate.errors ?? []).map((error) => ({ path: error.instancePath || '/', message: error.message ?? 'invalid' })),
  };
};

export const readManifest = (directory: string): unknown =>
  JSON.parse(readFileSync(join(directory, 'recueil.plugin.json'), 'utf8')) as unknown;

/** Whether a manifest's `recueilApi` admits the running plugin API (spec/plugin-api.md §2.4). */
export const isCompatible = (range: string, version = PLUGIN_API_VERSION): boolean =>
  semver.satisfies(version, range, { includePrerelease: false });
