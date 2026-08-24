import { describe, expect, it } from 'vitest';

import { SafeRegex } from '../src/regex/index.js';

/**
 * A seeded differential test against the platform's own `RegExp`.
 *
 * The linear engine is a reimplementation, and a reimplementation is only as good as the evidence
 * that it agrees with the thing everyone already knows. The generator below builds patterns from
 * the supported subset and compares position, matched text and every capture against `RegExp` on
 * the same input. The seed is fixed, so a failure is reproducible and a passing run is not luck.
 *
 * Patterns outside the subset are skipped rather than counted as agreement — refusing them is
 * tested separately, in `regex.test.ts`.
 */
const ATOMS = [
  'a',
  'b',
  'c',
  '.',
  '\\d',
  '\\w',
  '\\s',
  '[ab]',
  '[^a]',
  '[a-c]',
  '[\\s\\S]',
  '[\\d.]',
  '(a|b)',
  '(?:ab)',
  '(?<g>c)',
  '\\b',
] as const;

const QUANTIFIERS = ['', '*', '+', '?', '{2}', '{1,3}', '*?', '+?', '??', '{1,2}?', '{0,2}'] as const;

const INPUTS = ['', 'a', 'ab', 'abc', 'aab', 'ccc', 'abcabc', 'a1b2', 'zz', 'aaaa', 'a\nb', 'b-c', 'a.c', ' a ', 'ÄÖü'] as const;

const FLAGS = ['', 'i', 'm', 's', 'im'] as const;

/** A 32-bit linear congruential generator: small, seedable, and good enough to shuffle a grammar. */
const generator = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

describe('the linear engine against RegExp, over generated patterns', () => {
  it('agrees on position, text and every capture', () => {
    const random = generator(20_260_822);
    const pick = <Value>(values: readonly Value[]): Value => values[Math.floor(random() * values.length)]!;

    let compared = 0;
    let skipped = 0;
    const disagreements: string[] = [];

    for (let round = 0; round < 1500; round += 1) {
      const parts: string[] = [];
      for (let part = 0, count = 1 + Math.floor(random() * 3); part < count; part += 1) {
        const atom = pick(ATOMS);
        parts.push(atom === '\\b' ? atom : `${atom}${pick(QUANTIFIERS)}`);
      }
      let pattern = parts.join('');
      if (random() < 0.25) pattern = `^${pattern}`;
      if (random() < 0.25) pattern = `${pattern}$`;
      const flags = pick(FLAGS);

      let mine: SafeRegex;
      let native: RegExp;
      try {
        mine = SafeRegex.compile(pattern, { flags });
        native = new RegExp(pattern, flags);
      } catch {
        skipped += 1;
        continue;
      }

      for (const input of INPUTS) {
        compared += 1;
        const ours = mine.exec(input);
        const theirs = native.exec(input);
        const left = ours === undefined ? null : [ours.start, ours.text, ours.captures];
        const right = theirs === null ? null : [theirs.index, theirs[0], theirs.slice(1).map((value) => value ?? undefined)];
        if (JSON.stringify(left) !== JSON.stringify(right)) {
          disagreements.push(`/${pattern}/${flags} on ${JSON.stringify(input)}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
        }
      }
    }

    expect(disagreements).toEqual([]);
    expect(compared).toBeGreaterThan(10_000);
    // If nearly everything were skipped the comparison would be vacuous, so bound that too.
    expect(skipped).toBeLessThan(200);
  });
});
