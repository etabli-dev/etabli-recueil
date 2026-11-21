/**
 * Plugin settings: defaults from the schema, validation, and secret references (spec/plugin-api.md §4).
 */
import { readFileSync } from 'node:fs';

import { ValidationError } from '@recueil/plugin-sdk';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [k: string]: JsonValue };
type Schema = { [k: string]: unknown };

const SECRET_REFERENCE = /^\$\{(env|file):([^}]+)\}$/u;

const properties = (schema: Schema | undefined): Record<string, Schema> =>
  (schema?.['properties'] as Record<string, Schema> | undefined) ?? {};

/** Every `default` in the schema, walked recursively (§4.1). */
export const defaultsOf = (schema: Schema | undefined): JsonObject => {
  const out: JsonObject = {};
  for (const [name, property] of Object.entries(properties(schema))) {
    if (property['default'] !== undefined) out[name] = property['default'] as JsonValue;
    else if (property['type'] === 'object') {
      const nested = defaultsOf(property);
      if (Object.keys(nested).length > 0) out[name] = nested;
    }
  }
  return out;
};

export const secretPaths = (schema: Schema | undefined): string[] =>
  Object.entries(properties(schema))
    .filter(([, property]) => property['x-recueil-secret'] === true)
    .map(([name]) => name);

/** Required properties with no value: the plugin is `needs configuration` (§3.4). */
export const missingRequired = (schema: Schema | undefined, values: JsonObject): string[] =>
  ((schema?.['required'] as string[] | undefined) ?? []).filter((name) => values[name] === undefined);

export const validateSettings = (schema: Schema | undefined, values: JsonObject): void => {
  for (const name of secretPaths(schema)) {
    const value = values[name];
    if (value !== undefined && (typeof value !== 'string' || !SECRET_REFERENCE.test(value))) {
      throw new ValidationError(
        `'${name}' is a secret: give a reference such as \${env:VAR_NAME} or \${file:/run/secrets/name}, never the value`,
      );
    }
  }
  if (schema === undefined) return;
  const Ajv2020 = Ajv2020Module.default;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  (addFormatsModule as unknown as { default: (ajv: InstanceType<typeof Ajv2020>) => void }).default(ajv);
  // A secret reference is validated as a reference, not against the property's own constraints.
  const relaxed = structuredClone(schema) as Schema;
  for (const name of secretPaths(schema)) properties(relaxed)[name] = { type: 'string' };
  const validate = ajv.compile(relaxed);
  if (!validate(values)) {
    const detail = (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`).join('; ');
    throw new ValidationError(`settings do not match the plugin's schema: ${detail}`);
  }
};

/** Resolve secret references at `get()` time; the values are never written anywhere (§4.2). */
export const resolveSecrets = (
  schema: Schema | undefined,
  values: JsonObject,
  env: Record<string, string | undefined>,
): JsonObject => {
  const out: JsonObject = { ...values };
  for (const name of secretPaths(schema)) {
    const reference = values[name];
    if (typeof reference !== 'string') continue;
    const match = SECRET_REFERENCE.exec(reference);
    if (match === null) {
      delete out[name];
      continue;
    }
    const [, kind, target] = match as unknown as [string, 'env' | 'file', string];
    let value: string | undefined;
    if (kind === 'env') value = env[target];
    else {
      try {
        value = readFileSync(target, 'utf8').trim();
      } catch {
        value = undefined;
      }
    }
    if (value === undefined || value === '') delete out[name];
    else out[name] = value;
  }
  return out;
};

/** For display: whether each secret reference currently resolves (§4.2). */
export const secretStatus = (
  schema: Schema | undefined,
  values: JsonObject,
  env: Record<string, string | undefined>,
): Record<string, boolean> => {
  const resolved = resolveSecrets(schema, values, env);
  return Object.fromEntries(
    secretPaths(schema)
      .filter((name) => values[name] !== undefined)
      .map((name) => [name, resolved[name] !== undefined]),
  );
};
