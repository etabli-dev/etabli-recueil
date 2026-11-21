import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PLUGIN_API_VERSION, RateLimitError, canonicalDoi, titleSimilarity } from '../src/index.js';
// @ts-expect-error -- a plain ES module without declarations
import { generate } from '../scripts/generate-types.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('the SDK', () => {
  it('carries exactly the types of spec/hooks.md', () => {
    const spec = readFileSync(join(here, '..', '..', '..', 'spec', 'hooks.md'), 'utf8');
    const committed = readFileSync(join(here, '..', 'src', 'types.generated.ts'), 'utf8');
    expect(committed).toBe((generate as (spec: string) => string)(spec));
  });

  it('tracks its own version as the plugin API version', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };
    expect(PLUGIN_API_VERSION).toBe(pkg.version);
  });

  it('marks rate limits retryable', () => {
    expect(new RateLimitError('slow').retryable).toBe(true);
  });

  it('compares titles as Metadata Mender did', () => {
    expect(titleSimilarity('A study of bones', 'a STUDY of bones!')).toBe(1);
    expect(titleSimilarity('a of in on it', 'x of in on it')).toBe(0);
    expect(canonicalDoi('doi: 10.1234/ABC')).toBe('10.1234/abc');
  });
});
