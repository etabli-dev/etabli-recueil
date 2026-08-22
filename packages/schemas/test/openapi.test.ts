import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ajv2020Module from 'ajv/dist/2020.js';
import ajvFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  OPENAPI_VERSION,
  componentSchemaNames,
  componentSchemas,
  createOpenApiDocument,
  healthPaths,
  phase1Paths,
  renderOpenApiYaml,
} from '../src/index.js';
import { validAnnotation, validDocument, validHealth, validItem } from './fixtures.js';

/**
 * Ajv is CommonJS. Under NodeNext, TypeScript types the default import as the module namespace
 * while Node hands the class itself over at runtime; these two lines reconcile the two views.
 */
const Ajv2020 = ajv2020Module as unknown as typeof ajv2020Module.default;
const addFormats = ajvFormatsModule as unknown as typeof ajvFormatsModule.default;

const document = createOpenApiDocument();

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(packageRoot, '..', '..');
const committedSpecPath = join(repositoryRoot, 'spec', 'openapi.yaml');

describe('the generated document', () => {
  it('declares OpenAPI 3.1', () => {
    expect(document.openapi).toMatch(/^3\.1\.\d+$/);
    expect(document.openapi).toBe(OPENAPI_VERSION);
  });

  it('carries the info block the specification requires', () => {
    expect(document.info.title).toBe('Recueil API');
    expect(typeof document.info.version).toBe('string');
    expect(document.info.license?.identifier).toBe('AGPL-3.0-or-later');
    expect(document.info.description).toContain('P6');
  });

  it('declares the token and session authentication schemes', () => {
    const schemes = document.components?.securitySchemes ?? {};
    expect(Object.keys(schemes).sort()).toEqual(['bearerAuth', 'sessionCookie']);
    expect(document.security).toEqual([{ bearerAuth: [] }]);
  });

  it('serves /health, unauthenticated, with a problem document on failure', () => {
    const health = document.paths?.['/health'];
    expect(health).toBeDefined();
    const operation = health?.get;
    expect(operation?.operationId).toBe('getHealth');
    // A container health check has no token, so the operation opts out of the global requirement.
    expect(operation?.security).toEqual([]);
    expect(operation?.responses?.['200']?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/HealthResponse',
    });
    expect(operation?.responses?.['503']?.content?.['application/problem+json']?.schema).toEqual({
      $ref: '#/components/schemas/ProblemDetails',
    });
  });

  it('declares only /health in Phase 0, with a wired-up extension point for Phase 1', () => {
    expect(Object.keys(document.paths ?? {})).toEqual(['/health']);
    expect(Object.keys(healthPaths)).toEqual(['/health']);
    expect(Object.keys(phase1Paths)).toEqual([]);

    const extended = createOpenApiDocument({
      paths: {
        '/api/v1/items/{id}': {
          get: {
            operationId: 'getItem',
            responses: {
              '200': { description: 'The item', content: { 'application/json': { schema: componentSchemas.Item! } } },
            },
          },
        },
      },
    });
    expect(Object.keys(extended.paths ?? {}).sort()).toEqual(['/api/v1/items/{id}', '/health']);
    expect(extended.paths?.['/api/v1/items/{id}']?.get?.responses?.['200']?.content?.['application/json']?.schema).toEqual(
      { $ref: '#/components/schemas/Item' },
    );
  });
});

describe('components.schemas', () => {
  const schemas = document.components?.schemas ?? {};

  it('contains one entry per registered schema, and nothing anonymous', () => {
    expect(Object.keys(schemas).sort()).toEqual([...componentSchemaNames].sort());
    expect(Object.keys(schemas).filter((name) => name.startsWith('__'))).toEqual([]);
    // A schema rendered twice, once per direction, means an input/output divergence crept in.
    expect(Object.keys(schemas).filter((name) => name.endsWith('Output'))).toEqual([]);
  });

  it.each([
    'Document',
    'Item',
    'ItemCreate',
    'ItemUpdate',
    'ItemType',
    'BibliographicFacet',
    'BibliographicIdentifiers',
    'OfficeFacet',
    'Attachment',
    'AttachmentRole',
    'Collection',
    'Tag',
    'CustomField',
    'FieldValue',
    'FieldValueContent',
    'Note',
    'Annotation',
    'WebAnnotation',
    'Creator',
    'ItemCreator',
    'FieldProvenance',
    'FieldProvenanceMap',
    'PageInfo',
    'ProblemDetails',
    'BulkResult',
    'IdempotencyKey',
    'HealthResponse',
  ])('declares %s', (name) => {
    expect(schemas[name]).toBeDefined();
  });

  it('resolves every internal $ref', () => {
    const serialised = JSON.stringify(document);
    const refs = [...serialised.matchAll(/"\$ref":"#\/components\/schemas\/([A-Za-z0-9_]+)"/g)].map(
      (match) => match[1] as string,
    );
    expect(refs.length).toBeGreaterThan(100);
    for (const ref of new Set(refs)) {
      expect(Object.keys(schemas)).toContain(ref);
    }
  });

  it('compiles every component under a JSON Schema 2020-12 validator', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
    addFormats(ajv);
    ajv.addSchema(document as unknown as Record<string, unknown>, 'openapi');
    for (const name of componentSchemaNames) {
      expect(() => ajv.getSchema(`openapi#/components/schemas/${name}`), name).not.toThrow();
      expect(ajv.getSchema(`openapi#/components/schemas/${name}`), name).toBeTypeOf('function');
    }
  });
});

describe('the emitted JSON Schema agrees with the Zod schema', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  ajv.addSchema(document as unknown as Record<string, unknown>, 'openapi');

  const validatorFor = (name: string) => {
    const validate = ajv.getSchema(`openapi#/components/schemas/${name}`);
    if (validate === undefined) throw new Error(`no component named ${name}`);
    return validate;
  };

  it.each([
    ['HealthResponse', validHealth],
    ['Document', validDocument],
    ['Item', validItem],
    ['Annotation', validAnnotation],
  ])('validates the %s fixture', (name, fixture) => {
    const validate = validatorFor(name);
    const valid = validate(fixture);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects the same records the Zod schemas reject', () => {
    expect(validatorFor('HealthResponse')({ ...validHealth, status: 'fine' })).toBe(false);
    expect(validatorFor('Item')({ ...validItem, itemType: 'Journal Article' })).toBe(false);
    expect(validatorFor('Document')({ ...validDocument, sha256: 'nope' })).toBe(false);
  });
});

describe('the YAML rendering', () => {
  it('round-trips to the same document', () => {
    const yaml = renderOpenApiYaml();
    expect(yaml.startsWith('# Recueil — OpenAPI 3.1 contract.')).toBe(true);
    expect(yaml).toContain('GENERATED FILE. Do not edit by hand.');
    expect(parseYaml(yaml)).toEqual(JSON.parse(JSON.stringify(document)));
  });

  it('matches the committed spec/openapi.yaml', () => {
    const committed = readFileSync(committedSpecPath, 'utf8');
    const packageJson: { version?: string } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    expect(
      committed,
      'spec/openapi.yaml is stale — regenerate it with `pnpm --filter @recueil/schemas run openapi`',
    ).toBe(renderOpenApiYaml({ version: packageJson.version ?? '0.0.0' }));
  });
});
