import { readFileSync, existsSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

const problems = [];
const note = (message) => console.log(`  ${message}`);

// spec/plugin-manifest.schema.json — the plugin contract (CONCEPT.md §5.13). It must be
// valid JSON, must declare draft 2020-12, must validate against that meta-schema and must
// compile, because the host compiles it at install time and at every activation.
const schemaPath = 'spec/plugin-manifest.schema.json';
console.log(`Checking ${schemaPath}`);
if (!existsSync(schemaPath)) {
  problems.push(`${schemaPath} is missing`);
} else {
  let schema;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    note('valid JSON');
  } catch (error) {
    problems.push(`${schemaPath} is not valid JSON: ${error.message}`);
  }
  if (schema) {
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
      problems.push(`${schemaPath} does not declare the draft 2020-12 $schema`);
    }
    if (typeof schema.$id !== 'string') {
      problems.push(`${schemaPath} has no $id`);
    }
    // strictRequired is off: `anyOf: [{ required: ["main"] }, { required: ["ui"] }]` is a
    // deliberate either-or in the manifest, not a mistake.
    const ajv = new Ajv2020({
      strict: true,
      strictRequired: false,
      allErrors: true,
      allowUnionTypes: true,
    });
    addFormats(ajv);
    try {
      if (!ajv.validateSchema(schema)) {
        for (const error of ajv.errors ?? []) {
          problems.push(`${schemaPath} ${error.instancePath || '/'}: ${error.message}`);
        }
      } else {
        note('validates against the draft 2020-12 meta-schema');
      }
      ajv.compile(schema);
      note('compiles under Ajv strict mode');
    } catch (error) {
      problems.push(`${schemaPath} does not compile: ${error.message}`);
    }
  }
}

// spec/openapi.yaml — the API contract (P6). This checks that it parses and is shaped like
// an OpenAPI 3.x document. Full linting against the OpenAPI meta-schema belongs with the
// generator once the Zod schemas produce this file rather than a human editing it.
const apiPath = 'spec/openapi.yaml';
console.log(`Checking ${apiPath}`);
if (!existsSync(apiPath)) {
  problems.push(`${apiPath} is missing`);
} else {
  let document;
  try {
    document = parseYaml(readFileSync(apiPath, 'utf8'));
    note('parses as YAML');
  } catch (error) {
    problems.push(`${apiPath} is not valid YAML: ${error.message}`);
  }
  if (document) {
    if (typeof document.openapi !== 'string' || !document.openapi.startsWith('3.')) {
      problems.push(`${apiPath} has no OpenAPI 3.x version string`);
    } else {
      note(`declares OpenAPI ${document.openapi}`);
    }
    for (const key of ['info', 'paths']) {
      if (!document[key]) {
        problems.push(`${apiPath} has no top-level '${key}'`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('\nSpecification checks failed:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
console.log('\nSpecification checks passed.');
