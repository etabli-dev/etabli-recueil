/**
 * Escaping, accent folding, brace protection, and the inverse of all three.
 *
 * The awkward title in `fixtures.ts` is here for a reason: braces, an ampersand, a percent sign, a
 * piece of maths and an accented name in one string is exactly the combination that a naive
 * sequence of `String.replace` calls gets wrong, usually by escaping the backslash it has just
 * written.
 */
import { describe, expect, it } from 'vitest';

import {
  collapseWhitespace,
  escapeLatex,
  needsBraceProtection,
  protectCapitals,
  residualMacros,
  unescapeLatex,
} from '../src/index.js';

describe('escaping', () => {
  const cases: Array<[string, string, string]> = [
    ['ampersand', 'Tom & Jerry', 'Tom \\& Jerry'],
    ['percent', '100% Efficiency', '100\\% Efficiency'],
    ['braces', 'On {DNA}', 'On \\{DNA\\}'],
    ['hash and underscore', 'a_b #1', 'a\\_b \\#1'],
    ['tilde and caret', 'a~b^c', 'a\\textasciitilde{}b\\textasciicircum{}c'],
    ['backslash', 'a\\b', 'a\\textbackslash{}b'],
    ['dollar outside maths', 'costs 5$', 'costs 5\\$'],
  ];

  it.each(cases)('escapes %s', (_name, input, expected) => {
    expect(escapeLatex(input, { unicode: true })).toBe(expected);
  });

  it('copies a maths span through untouched', () => {
    expect(escapeLatex('A $p < 0.05$ study & more', { unicode: true })).toBe('A $p < 0.05$ study \\& more');
  });

  it('folds accents for classic BibTeX', () => {
    expect(escapeLatex('Müller, Jörg')).toBe('M\\"{u}ller, J\\"{o}rg');
    expect(escapeLatex('Créquit')).toBe('Cr\\\'{e}quit');
    expect(escapeLatex('Szűcs')).toBe('Sz\\H{u}cs');
    expect(escapeLatex('Ångström')).toBe('\\r{A}ngstr\\"{o}m');
    expect(escapeLatex('Straße')).toBe('Stra{\\ss}e');
    expect(escapeLatex('Łódź')).toBe('{\\L}\\\'{o}d\\\'{z}');
  });

  it('leaves them alone for BibLaTeX', () => {
    expect(escapeLatex('Müller, Jörg', { unicode: true })).toBe('Müller, Jörg');
    expect(escapeLatex('Straße', { unicode: true })).toBe('Straße');
  });
});

describe('brace protection', () => {
  const cases: Array<[string, boolean]> = [
    ['DNA', true],
    ['pH', true],
    ['McDonald', true],
    ['mRNA', true],
    ['Preprints', false],
    ['the', false],
    ['A', false],
    ['2019', false],
  ];

  it.each(cases)('%s needs protection: %s', (word, expected) => {
    expect(needsBraceProtection(word)).toBe(expected);
  });

  it('protects the acronyms of a title and nothing else', () => {
    expect(protectCapitals('The Role of DNA in pH Regulation')).toBe('The Role of {DNA} in {pH} Regulation');
  });

  it('keeps trailing punctuation outside the braces', () => {
    expect(protectCapitals('Studies of DNA, mRNA and more')).toBe('Studies of {DNA}, {mRNA} and more');
  });

  it('leaves an already-braced word and a maths span alone', () => {
    expect(protectCapitals('{DNA} and $H_2O$')).toBe('{DNA} and $H_2O$');
  });
});

describe('the inverse', () => {
  const cases: Array<[string, string]> = [
    ['M\\"{u}ller', 'Müller'],
    ['M\\"uller', 'Müller'],
    ['{M\\"{u}ller}', 'Müller'],
    ["Cr\\'{e}quit", 'Créquit'],
    ['Sz\\H{u}cs', 'Szűcs'],
    ['Stra{\\ss}e', 'Straße'],
    ['Stra\\ss{}e', 'Straße'],
    ['{\\L}\\\'{o}d\\\'{z}', 'Łódź'],
    ['\\r{A}ngstr\\"{o}m', 'Ångström'],
    ['Tom \\& Jerry', 'Tom & Jerry'],
    ['100\\% Efficiency', '100% Efficiency'],
    ['On \\{DNA\\}', 'On {DNA}'],
    ['a\\textbackslash{}b', 'a\\b'],
    ['{DNA} in {pH}', 'DNA in pH'],
    ['pages 1--5', 'pages 1–5'],
    ['``quoted\'\'', '“quoted”'],
    ['non~breaking', 'non breaking'],
  ];

  it.each(cases)('reads %s as %s', (input, expected) => {
    expect(unescapeLatex(input)).toBe(expected);
  });

  it('round-trips the awkward title through both dialects', () => {
    const title = 'On {DNA} & 100% Efficiency: A $p < 0.05$ Study of pH in Ångström Scales';
    for (const unicode of [true, false]) {
      const escaped = protectCapitals(escapeLatex(title, { unicode }));
      expect(unescapeLatex(escaped)).toBe(title);
    }
  });

  it('keeps an unknown macro rather than deleting the text, and reports it', () => {
    const value = unescapeLatex('a \\noopsort{b} c');
    expect(value).toContain('\\noopsort');
    expect(residualMacros(value)).toEqual(['\\noopsort']);
  });

  it('does not call the commands inside maths residue', () => {
    expect(residualMacros(unescapeLatex('$\\alpha$ decay'))).toEqual([]);
  });
});

describe('whitespace', () => {
  it('collapses the line wrapping a .bib file applies to long values', () => {
    expect(collapseWhitespace('The Effect of Preprints on\n      Systematic Review')).toBe(
      'The Effect of Preprints on Systematic Review',
    );
  });
});
