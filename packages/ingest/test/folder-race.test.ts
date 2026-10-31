import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// The files and directory operations are real. The hook only makes the timing
// between containment checks and stat calls deterministic.
const hooks = vi.hoisted(() => ({
  beforeStat: undefined as ((path: unknown) => void) | undefined,
  afterStat: undefined as ((path: unknown) => void) | undefined,
  afterRealpath: undefined as ((path: unknown) => void) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const resolved = await actual.realpath(...args);
      hooks.afterRealpath?.(args[0]);
      return resolved;
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      hooks.beforeStat?.(args[0]);
      const info = await actual.stat(...args);
      hooks.afterStat?.(args[0]);
      return info;
    },
  };
});

import { folderCandidates } from '../src/sources/local.js';

afterEach(() => {
  hooks.beforeStat = undefined;
  hooks.afterStat = undefined;
  hooks.afterRealpath = undefined;
});

describe('folder containment while scan metadata is collected', () => {
  it.each(['before', 'after'] as const)('rejects an ancestor symlink swapped %s the scan stat', async (phase) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'recueil-folder-race-')));
    try {
      const watched = join(root, 'watched');
      const parent = join(watched, 'sub');
      const outside = join(root, 'outside');
      mkdirSync(parent, { recursive: true });
      mkdirSync(outside);
      const source = join(parent, 'scan.txt');
      const outsideBytes = Buffer.from('outside-secret');
      writeFileSync(source, 'inside-source');
      writeFileSync(join(outside, 'scan.txt'), outsideBytes);
      let swapped = false;
      const swapParent = (path: unknown) => {
        if (path !== source || swapped) return;
        swapped = true;
        renameSync(parent, join(watched, 'original-sub'));
        symlinkSync(outside, parent, 'dir');
      };
      if (phase === 'before') hooks.beforeStat = swapParent;
      else hooks.afterStat = swapParent;

      const scan = await folderCandidates(watched, { maxBytes: 1024 });
      const imported = await Promise.all(scan.candidates.map((candidate) => candidate.read()));
      expect(swapped).toBe(true);
      expect(imported).not.toContainEqual(outsideBytes);
      expect(scan.candidates).toEqual([]);
      expect(scan.skipped.some((entry) => entry.path === source && /outside the watched folder/u.test(entry.reason))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains the checked identity when an ancestor changes after the containment recheck', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'recueil-folder-identity-')));
    try {
      const watched = join(root, 'watched');
      const parent = join(watched, 'sub');
      const outside = join(root, 'outside');
      mkdirSync(parent, { recursive: true });
      mkdirSync(outside);
      const source = join(parent, 'scan.txt');
      writeFileSync(source, 'inside-source');
      writeFileSync(join(outside, 'scan.txt'), 'outside-secret');
      let sourceResolutions = 0;
      hooks.afterRealpath = (path) => {
        if (path !== source || ++sourceResolutions !== 2) return;
        renameSync(parent, join(watched, 'original-sub'));
        symlinkSync(outside, parent, 'dir');
      };

      const scan = await folderCandidates(watched, { maxBytes: 1024 });
      expect(sourceResolutions).toBe(2);
      expect(scan.candidates).toHaveLength(1);
      await expect(scan.candidates[0]!.read()).rejects.toMatchObject({ code: 'source_changed_before_read' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
