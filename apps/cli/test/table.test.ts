/**
 * The table and number formatting.
 *
 * Small, pure and worth testing directly, because the failures are the sort a screenshot hides: a
 * column that stops lining up once one cell is wider than its header, a rule that is the wrong
 * length, a byte count that says `1024 B`.
 */
import { describe, expect, it } from 'vitest';

import { bytes, count, duration, renderTable } from '../src/table.js';

describe('renderTable', () => {
  it('sizes each column to its widest cell, header included', () => {
    const lines = renderTable(
      [{ header: 'What' }, { header: 'N', align: 'right' }],
      [
        ['a very long label', '7'],
        ['short', '1234'],
      ],
    );

    expect(lines).toEqual([
      `What${' '.repeat(14)}${' '.repeat(4)}N`,
      '-----------------  ----',
      'a very long label     7',
      'short              1234',
    ]);
    // Every line is the same width, which is what "lines up" means.
    expect(new Set(lines.map((line) => line.padEnd(23).length))).toEqual(new Set([23]));
  });

  it('rules each column to its own width', () => {
    const [header, rule] = renderTable([{ header: 'Check' }, { header: 'Result' }], [['x', 'pass']]);
    expect(rule?.replace(/\s+/gu, ' ').split(' ').map((part) => part.length)).toEqual([5, 6]);
    expect(header).toBe('Check  Result');
  });

  it('tolerates a short row rather than throwing', () => {
    // The row is one cell short; the missing cell is empty rather than an exception, and the
    // column is still as wide as the value that is there.
    expect(renderTable([{ header: 'A' }, { header: 'B' }], [['only']])).toEqual([
      'A     B',
      '----  -',
      'only',
    ]);
  });
});

describe('the number formats', () => {
  it('groups digits so a six-figure count is readable', () => {
    // A narrow no-break space (U+202F), not an ordinary one: it groups the digits for a reader
    // without splitting the number into two fields for `awk`.
    const thin = '\u202f';
    expect(count(7)).toBe('7');
    expect(count(1234)).toBe(`1${thin}234`);
    expect(count(1234567)).toBe(`1${thin}234${thin}567`);
  });

  it('uses decimal units, as disks are sold', () => {
    expect(bytes(8)).toBe('8 B');
    expect(bytes(912_000)).toBe('912 kB');
    expect(bytes(1_400_000)).toBe('1.4 MB');
  });

  it('reports a duration at the precision a person cares about', () => {
    expect(duration(320)).toBe('320 ms');
    expect(duration(1400)).toBe('1.4 s');
    expect(duration(125_000)).toBe('2 min 05 s');
  });
});
