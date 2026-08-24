/**
 * The JSON Schema for a rule set, generated from the Zod schema.
 *
 * The UI validates a rule set in the editor before it is sent, and the API validates it again on
 * arrival; both must agree with the engine that will run it. Generating the schema from the same
 * Zod definitions the engine imports is what makes that true by construction rather than by
 * discipline. `packages/rules/schema/rule-set.schema.json` is the generated artefact, checked in so
 * the web app can import it without a build step, and a test asserts it still matches what this
 * function produces — the drift check the schemas package makes for the OpenAPI document.
 */
import * as z from 'zod';

import { RuleSetSchema } from './schema/index.js';

export const RULE_SET_SCHEMA_ID = 'https://recueil.etabli.dev/schema/rule-set.schema.json';

type JsonSchemaObject = Record<string, unknown>;

/**
 * Zod names an anonymous `$defs` entry `__schema0`. Where such an entry is nothing but a `$ref` to
 * a named one — which is what a `z.lazy` wrapper around a named union becomes — collapse it, so the
 * published schema has no generated names in it.
 */
const inlineAliasDefs = (schema: JsonSchemaObject): JsonSchemaObject => {
  const defs = schema['$defs'] as Record<string, JsonSchemaObject> | undefined;
  if (defs === undefined) return schema;

  const aliases = new Map<string, string>();
  for (const [name, definition] of Object.entries(defs)) {
    const keys = Object.keys(definition);
    const target = definition['$ref'];
    if (keys.length === 1 && typeof target === 'string') aliases.set(`#/$defs/${name}`, target);
  }
  if (aliases.size === 0) return schema;

  const resolve = (ref: string): string => {
    let current = ref;
    for (let hop = 0; hop < aliases.size + 1; hop += 1) {
      const next = aliases.get(current);
      if (next === undefined) return current;
      current = next;
    }
    return current;
  };

  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (typeof node !== 'object' || node === null) return node;
    const out: JsonSchemaObject = {};
    for (const [key, value] of Object.entries(node as JsonSchemaObject)) {
      out[key] = key === '$ref' && typeof value === 'string' ? resolve(value) : rewrite(value);
    }
    return out;
  };

  const rewritten = rewrite(schema) as JsonSchemaObject;
  const keptDefs: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(rewritten['$defs'] as Record<string, JsonSchemaObject>)) {
    if (!aliases.has(`#/$defs/${name}`)) keptDefs[name] = definition;
  }
  return { ...rewritten, $defs: keptDefs };
};

/**
 * Build the JSON Schema.
 *
 * `io: 'input'` is deliberate: the schema describes what a rule author may write, so an optional
 * field with a default is optional in it. The output type — what the engine sees after parsing — is
 * the TypeScript type, and is nobody's wire format.
 */
export const ruleSetJsonSchema = (): JsonSchemaObject => {
  const generated = z.toJSONSchema(RuleSetSchema, { target: 'draft-2020-12', io: 'input' }) as JsonSchemaObject;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: RULE_SET_SCHEMA_ID,
    ...inlineAliasDefs(generated),
  };
};
