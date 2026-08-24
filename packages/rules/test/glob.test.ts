import { describe, expect, it } from 'vitest';

import { globRegex, globToPattern } from '../src/glob.js';
import { basename, normalisePath } from '../src/path.js';
import { RegexSyntaxError } from '../src/regex/index.js';

const matches = (glob: string, path: string): boolean => globRegex(glob).test(path);

describe('globs', () => {
  const cases: readonly (readonly [string, string, boolean])[] = [
    ['**/*.pdf', 'a.pdf', true],
    ['**/*.pdf', 'x/y/a.pdf', true],
    ['**/*.pdf', 'x/y/a.txt', false],
    ['*.pdf', 'x/a.pdf', false],
    ['Scans/**', 'Scans', true],
    ['Scans/**', 'Scans/2026/a.pdf', true],
    ['Scans/**', 'Other/a.pdf', false],
    ['Scans/*/*.pdf', 'Scans/2026/a.pdf', true],
    ['Scans/*/*.pdf', 'Scans/2026/07/a.pdf', false],
    ['*.{pdf,PDF}', 'a.PDF', true],
    ['*.{pdf,tif{f,}}', 'a.tiff', true],
    ['*.{pdf,tif{f,}}', 'a.tif', true],
    ['*.{pdf,tif{f,}}', 'a.png', false],
    ['report-?.pdf', 'report-1.pdf', true],
    ['report-?.pdf', 'report-12.pdf', false],
    ['[abc]*.pdf', 'b1.pdf', true],
    ['[!abc]*.pdf', 'z1.pdf', true],
    ['[!abc]*.pdf', 'a1.pdf', false],
    ['inbox/**/scan-*.pdf', 'inbox/scan-1.pdf', true],
    ['inbox/**/scan-*.pdf', 'inbox/2026/08/scan-1.pdf', true],
    ['a b/*.pdf', 'a b/c.pdf', true],
    ['Belege/Rechnungen/*.pdf', 'Belege/Rechnungen/märz.pdf', true],
    ['a.pdf', 'xa.pdf', false],
    ['a.pdf', 'a.pdfx', false],
    ['a+b.pdf', 'a+b.pdf', true],
    ['a.pdf', 'aXpdf', false],
  ];

  for (const [glob, path, want] of cases) {
    it(`${glob} ${want ? 'matches' : 'does not match'} ${path}`, () => {
      expect(matches(glob, path)).toBe(want);
    });
  }

  it('never lets `*` cross a directory boundary', () => {
    expect(matches('Scans/*', 'Scans/2026/a.pdf')).toBe(false);
    expect(matches('Scans/*', 'Scans/a.pdf')).toBe(true);
  });

  it('never lets a negated class cross one either', () => {
    expect(matches('a/[!x]/b', 'a//b')).toBe(false);
  });

  it('anchors: a glob describes the whole path', () => {
    expect(globToPattern('a').startsWith('^')).toBe(true);
    expect(globToPattern('a').endsWith('$')).toBe(true);
  });

  it('refuses a malformed glob rather than matching something unintended', () => {
    expect(() => globToPattern('a{b')).toThrowError(RegexSyntaxError);
    expect(() => globToPattern('a}b')).toThrowError(RegexSyntaxError);
    expect(() => globToPattern('a[b')).toThrowError(RegexSyntaxError);
    expect(() => globToPattern('{'.repeat(20))).toThrowError(/nested more than/u);
  });
});

describe('path normalisation', () => {
  const cases: readonly (readonly [string, string, boolean])[] = [
    ['photos/../../etc/shadow', '../etc/shadow', true],
    ['/root/a/./b//c', '/root/a/b/c', false],
    ['a\\..\\b', 'b', false],
    ['x/y/../z', 'x/z', false],
    ['/..', '/', true],
    ['a/b/', 'a/b', false],
    ['./a', 'a', false],
    ['', '', false],
  ];

  for (const [raw, path, escaped] of cases) {
    it(`${JSON.stringify(raw)} normalises to ${JSON.stringify(path)}`, () => {
      const result = normalisePath(raw);
      expect(result.path).toBe(path);
      expect(result.escaped).toBe(escaped);
    });
  }

  it('treats a backslash as a separator, so a Windows-shaped traversal cannot slip through', () => {
    expect(normalisePath('Scans\\..\\..\\etc\\shadow').path).toBe('../etc/shadow');
    expect(matches('Scans/**', normalisePath('Scans\\..\\..\\etc\\shadow').path)).toBe(false);
  });

  it('reports whether normalisation changed anything, for the trace', () => {
    expect(normalisePath('a/b').changed).toBe(false);
    expect(normalisePath('a//b').changed).toBe(true);
  });

  it('takes the last segment for a filename', () => {
    expect(basename('a/b/c.pdf')).toBe('c.pdf');
    expect(basename('c.pdf')).toBe('c.pdf');
    expect(basename('a/b/../c.pdf')).toBe('c.pdf');
  });
});
