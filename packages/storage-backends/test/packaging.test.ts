/**
 * The package's entry points, checked against the built output rather than against intent.
 *
 * One property matters: importing `@recueil/storage-backends` must not drag `vitest` into a
 * production process. The conformance suite imports it, the suite lives in `src/`, and a barrel
 * file that re-exported it for tidiness would put a test framework in the server's dependency
 * graph — the sort of thing nobody notices until a container image doubles in size.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const distributionRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const read = (relativePath: string): string =>
  readFileSync(join(distributionRoot, relativePath), 'utf8');

describe('package entry points', () => {
  it('does not reach the test framework from the root entry point', () => {
    const reachable = new Set<string>();
    const visit = (relativePath: string): void => {
      if (reachable.has(relativePath)) return;
      reachable.add(relativePath);
      const source = read(relativePath);
      for (const match of source.matchAll(/from\s+'(\.[^']+)'/gu)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        visit(join(dirname(relativePath), specifier));
      }
    };

    visit('index.js');

    expect(reachable.size).toBeGreaterThan(5);
    expect([...reachable].filter((file) => file.includes('conformance'))).toEqual([]);
    for (const file of reachable) {
      expect(read(file)).not.toContain("'vitest'");
    }
  });

  it('does expose the suite on its own subpath', () => {
    expect(read('conformance/index.js')).toContain("from 'vitest'");
    expect(read('conformance/index.js')).toContain('runStorageBackendConformance');
  });

  it('exposes the fakes without the test framework, so any package can use them', () => {
    expect(read('testing/index.js')).not.toContain("'vitest'");
    expect(read('testing/s3-server.js')).not.toContain("'vitest'");
    expect(read('testing/webdav-server.js')).not.toContain("'vitest'");
  });
});
