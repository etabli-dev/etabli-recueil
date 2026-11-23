import { describe, expect, it } from 'vitest';
import type { DedupSubject } from '@recueil/plugin-sdk';

import { fuzzyRule, identifierRule } from '../src/index.js';

const ctx = {} as never;
const subject = (id: string, overrides: Partial<Extract<DedupSubject, { layer: 'record' }>> = {}, extra: Record<string, unknown> = {}): DedupSubject => ({
  layer: 'record',
  itemId: id,
  itemType: 'article',
  identifiers: [],
  normalisedTitle: '',
  snapshot: { title: 'Fracture healing in the elderly patient', firstAuthor: 'Lovelace', ...extra } as never,
  issuedYear: 2020,
  ...overrides,
});

describe('identifier rule', () => {
  it('is a duplicate on a shared DOI and distinct on disagreeing DOIs', async () => {
    const a = subject('a', { identifiers: [{ scheme: 'doi', value: '10.1/x' }] });
    const b = subject('b', { identifiers: [{ scheme: 'doi', value: '10.1/x' }, { scheme: 'pmid', value: '1' }] });
    const c = subject('c', { identifiers: [{ scheme: 'doi', value: '10.1/y' }] });
    expect((await identifierRule.compare(a, b, ctx)).action).toBe('duplicate');
    expect((await identifierRule.compare(a, b, ctx)).score).toBe(1);
    expect((await identifierRule.compare(a, c, ctx)).action).toBe('distinct');
    expect(await identifierRule.blockingKeys(b, ctx)).toEqual(['doi:10.1/x', 'pmid:1']);
  });

  it('is symmetric', async () => {
    const a = subject('a', { identifiers: [{ scheme: 'doi', value: '10.1/x' }, { scheme: 'pmid', value: '1' }] });
    const b = subject('b', { identifiers: [{ scheme: 'doi', value: '10.1/x' }, { scheme: 'pmid', value: '2' }] });
    expect(await identifierRule.compare(a, b, ctx)).toEqual(await identifierRule.compare(b, a, ctx));
    expect((await identifierRule.compare(a, b, ctx)).action).toBe('distinct');
  });
});

describe('fuzzy rule', () => {
  it('proposes near-identical titles by the same author, and never at score 1', async () => {
    const a = subject('a');
    const b = subject('b', {}, { title: 'Fracture Healing in the Elderly Patient.' });
    const verdict = await fuzzyRule.compare(a, b, ctx);
    expect(verdict.action).toBe('duplicate');
    expect(verdict.score).toBeLessThan(1);
    expect(await fuzzyRule.blockingKeys(a, ctx)).toEqual(await fuzzyRule.blockingKeys(b, ctx));
  });

  it('keeps years further apart than one, and different authors, from merging', async () => {
    expect((await fuzzyRule.compare(subject('a'), subject('b', { issuedYear: 2023 }), ctx)).action).toBe('distinct');
    expect((await fuzzyRule.compare(subject('a'), subject('b', {}, { firstAuthor: 'Babbage' }), ctx)).action).toBe('undecided');
  });

  it('is symmetric', async () => {
    const a = subject('a');
    const b = subject('b', { issuedYear: 2021 }, { title: 'Fracture healing in elderly patients' });
    expect(await fuzzyRule.compare(a, b, ctx)).toEqual(await fuzzyRule.compare(b, a, ctx));
  });
});
