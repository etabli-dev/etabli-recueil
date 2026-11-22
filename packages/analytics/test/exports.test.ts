import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecueil } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyticsTables, citedReference, describeNetwork, toCsv, toGexf, toGraphml, toVosviewerJson, toWosPlaintext } from '../src/index.js';

let dir: string;
let recueil: Recueil;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recueil-analytics-'));
  recueil = createRecueil({ databaseUrl: join(dir, 'lib.sqlite'), storagePath: join(dir, 'store') });
});
afterEach(() => {
  recueil.close();
  rmSync(dir, { recursive: true, force: true });
});

const seed = () => {
  const a = recueil.library.createItem(
    { itemType: 'article', title: 'Hip & knee', bibliographic: { title: 'Hip & knee', doi: '10.1000/a', containerTitle: 'Injury', issuedYear: 2020, volume: '12', pageFirst: 101, pageLast: 110 } },
    recueil.actor,
  ).item.id;
  const creator = recueil.creators.create({ kind: 'person', familyName: 'Lovelace', givenName: 'Ada' }, recueil.actor);
  recueil.creators.setItemCreators(a, [{ creatorId: creator.id, role: 'author' }], recueil.actor);
  recueil.graph.addCitation(a, { source: 'crossref', sourceId: '10.1000/x', doi: '10.1000/x', title: 'Old work', containerTitle: 'Bone', issuedYear: 1999, authors: [{ family: 'Babbage', given: 'Charles' }] }, { source: 'crossref' });
  return a;
};

describe('exports', () => {
  it('writes Web of Science plain text bibliometrix reads', () => {
    const a = seed();
    const text = toWosPlaintext(recueil, [a]);
    expect(text.startsWith('FN Clarivate Analytics Web of Science\nVR 1.0\nPT J\n')).toBe(true);
    expect(text).toContain('AU Lovelace, A\n');
    expect(text).toContain('AF Lovelace, Ada\n');
    expect(text).toContain('SO INJURY\n');
    expect(text).toContain('C1 NA\n');
    expect(text).toContain('CR BABBAGE C, 1999, BONE, DOI 10.1000/X\n');
    expect(text).toContain('NR 1\n');
    expect(text).toContain('PY 2020\nVL 12\n');
    expect(text).toContain('BP 101\nEP 110\nDI 10.1000/a\n');
    expect(text.trimEnd().endsWith('ER\n\nEF')).toBe(true);
    expect(citedReference({ firstAuthor: null, year: null, source: null, doi: null })).toBe('ANONYMOUS, UNKNOWN');
  });

  it('writes GraphML, GEXF and VOSviewer JSON with escaped labels', () => {
    seed();
    const network = describeNetwork(recueil, recueil.graph.citationNetwork(), 'citations');
    expect(network.nodes).toHaveLength(2);
    const graphml = toGraphml(network);
    expect(graphml).toContain('<data key="label">Hip &amp; knee</data>');
    expect(graphml).toContain('edgedefault="directed"');
    expect(toGexf(network)).toContain('defaultedgetype="directed"');
    const vos = JSON.parse(toVosviewerJson(network)) as { network: { items: unknown[]; links: { source_id: number }[] } };
    expect(vos.network.items).toHaveLength(2);
    expect(vos.network.links[0]?.source_id).toBeTypeOf('number');
  });

  it('flattens the analytics tables and writes RFC 4180 CSV', () => {
    const a = seed();
    const works = analyticsTables(recueil, 'works');
    expect(works[0]).toMatchObject({ work_id: a, doi: '10.1000/a', issued_year: 2020 });
    expect(analyticsTables(recueil, 'edges')).toHaveLength(1);
    expect(toCsv([{ a: 'x,y', b: null, c: true }])).toBe('a,b,c\r\n"x,y",,true\r\n');
    expect(toCsv([], ['a'])).toBe('a\r\n');
  });
});
