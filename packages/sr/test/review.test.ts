import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRecueil, schema } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectFormat, extractionCsv, importSearchFile, prismaCsv, prismaData, prismaSvg, robvisCsv, screeningAuditCsv } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../../clients/r/tests/testthat/fixtures');

let dir: string;
let recueil: Recueil;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recueil-sr-'));
  recueil = createRecueil({ databaseUrl: join(dir, 'lib.sqlite'), storagePath: join(dir, 'store') });
});
afterEach(() => {
  recueil.close();
  rmSync(dir, { recursive: true, force: true });
});

const MEDLINE = `PMID- 31000001
OWN - NLM
DP  - 2019 Mar 15
TI  - Tranexamic acid in hip fracture surgery: a randomised
      controlled trial.
PG  - 101-9
AB  - Background. We randomised 200 patients.
FAU - Lovelace, Ada
AU  - Lovelace A
FAU - Babbage, Charles
AU  - Babbage C
LA  - eng
PT  - Journal Article
PT  - Randomized Controlled Trial
TA  - Injury
JT  - Injury
VI  - 50
IP  - 3
AID - 10.1000/txa.2019 [doi]
MH  - *Hip Fractures/surgery
OT  - tranexamic acid

PMID- 31000002
DP  - 2020
TI  - Cemented versus uncemented hemiarthroplasty.
FAU - Curie, Marie
LA  - eng
PT  - Journal Article
TA  - Bone Joint J
JT  - The bone & joint journal
AID - 10.1000/hemi.2020 [doi]

PMID- 31000003
DP  - 2021 Jan
TI  - Early mobilisation after hip fracture surgery: a cohort study.
FAU - Franklin, Rosalind
LA  - eng
PT  - Journal Article
TA  - Injury
JT  - Injury
`;

// Embase's RIS: the first record is the PubMed one again (same DOI); the second is the cohort study
// without a DOI and with a slightly different title — the fuzzy pass's job; the third is new.
const RIS = `TY  - JOUR
TI  - Tranexamic acid in hip fracture surgery: a randomised controlled trial
AU  - Lovelace, Ada
PY  - 2019
DO  - 10.1000/txa.2019
T2  - Injury
ER  -

TY  - JOUR
TI  - Early mobilisation after hip fracture surgery: a cohort study
AU  - Franklin, Rosalind
PY  - 2021
T2  - Injury
ER  -

TY  - JOUR
TI  - Nerve blocks for hip fracture analgesia
AU  - Hopper, Grace
PY  - 2018
DO  - 10.1000/block.2018
T2  - Anaesthesia
ER  -
`;

const setup = () => {
  const review = recueil.reviews.create(
    {
      title: 'Hip fracture care',
      question: 'What improves outcomes after hip fracture surgery?',
      protocol: { population: 'adults with hip fracture' },
      exclusionReasons: [
        { code: 'wrong_population', label: 'Wrong population', stage: 'any' },
        { code: 'wrong_design', label: 'Wrong study design', stage: 'full_text' },
      ],
      automationDisclosure: true,
    },
    recueil.actor,
  );
  const pubmed = recueil.reviews.addSearchRun(review.id, { sourceDatabase: 'pubmed', interface: 'native', queryString: '"hip fractures"[MeSH]', recordsReturned: 3 }, recueil.actor);
  const embase = recueil.reviews.addSearchRun(review.id, { sourceDatabase: 'embase', interface: 'Ovid', queryString: 'exp hip fracture/', recordsReturned: 4 }, recueil.actor);
  return { review, pubmed, embase };
};

const cell = (flow: ReturnType<Recueil['reviews']['prisma']>, key: string) => flow.cells.find((c) => c.stageKey === key && c.sourceLabel === null && c.exclusionReasonCode === null)!.count;

describe('import with source tracking', () => {
  it('detects the formats of database exports', () => {
    expect(detectFormat(MEDLINE)).toBe('medline');
    expect(detectFormat(RIS)).toBe('ris');
    expect(detectFormat('@article{a, title={x}}')).toBe('bibtex');
    expect(detectFormat('[{"type":"article-journal"}]')).toBe('csl-json');
  });

  it('reads MEDLINE, and attributes a record found twice to both databases', () => {
    const { review, pubmed, embase } = setup();
    const first = importSearchFile(recueil, pubmed.id, MEDLINE);
    expect(first).toMatchObject({ format: 'medline', parsed: 3, added: 3, itemsCreated: 3, failures: [] });
    const txa = recueil.reviews.records(review.id).map((r) => recueil.reviews.view(r.id)).find((v) => v.doi === '10.1000/txa.2019')!;
    expect(txa.title).toBe('Tranexamic acid in hip fracture surgery: a randomised controlled trial');
    expect(txa.pmid).toBe('31000001');
    expect(txa.authors).toEqual(['Ada Lovelace', 'Charles Babbage']);

    const second = importSearchFile(recueil, embase.id, RIS);
    expect(second).toMatchObject({ format: 'ris', parsed: 3, added: 2, sourceAdded: 1, itemsReused: 1, returnedDiffers: true });
    expect(recueil.reviews.view(txa.record.id).sources.sort()).toEqual(['embase', 'pubmed']);
    // Importing the same file again changes nothing.
    expect(importSearchFile(recueil, embase.id, RIS)).toMatchObject({ added: 0, sourceAdded: 0, repeated: 3 });
    expect(recueil.reviews.records(review.id)).toHaveLength(5);
  });

  it('refuses to delete a search run once records cite it (SR2)', () => {
    const { pubmed } = setup();
    importSearchFile(recueil, pubmed.id, MEDLINE);
    expect(() => recueil.reviews.deleteSearchRun(pubmed.id, recueil.actor)).toThrow(/SR2/u);
  });
});

describe('deduplication, screening and PRISMA', () => {
  const screened = () => {
    const ctx = setup();
    importSearchFile(recueil, ctx.pubmed.id, MEDLINE);
    importSearchFile(recueil, ctx.embase.id, RIS);
    const dedup = recueil.reviews.dedup(ctx.review.id, recueil.actor);
    return { ...ctx, dedup };
  };
  const byTitle = (reviewId: string, fragment: string) => recueil.reviews.records(reviewId).map((r) => recueil.reviews.view(r.id)).filter((v) => v.title?.includes(fragment));

  it('marks the near-identical cohort record as a duplicate, keeps it, and can undo it (RR3)', () => {
    const { review, dedup } = screened();
    expect(dedup.pairs).toHaveLength(1);
    const [master, duplicate] = byTitle(review.id, 'Early mobilisation');
    expect(master!.record.dedupStatus).toBe('merged_master');
    expect(duplicate!.record).toMatchObject({ dedupStatus: 'duplicate', duplicateOfId: master!.record.id });
    expect(() => recueil.reviews.decide(duplicate!.record.id, { stage: 'title_abstract', decision: 'include' }, recueil.actor)).toThrow(/Duplicates are not screened/u);
    recueil.reviews.undoDuplicate(duplicate!.record.id, recueil.actor);
    expect(recueil.reviews.record(duplicate!.record.id).dedupStatus).toBe('unique');
    expect(recueil.reviews.record(master!.record.id).dedupStatus).toBe('unique');
  });

  it('screens with reasons, supersedes on change and undo (SD1), and counts the flow live (RR1)', () => {
    const { review } = screened();
    const txa = byTitle(review.id, 'Tranexamic')[0]!.record.id;
    const hemi = byTitle(review.id, 'hemiarthroplasty')[0]!.record.id;
    const cohort = byTitle(review.id, 'Early mobilisation')[0]!.record.id;
    const block = byTitle(review.id, 'Nerve blocks')[0]!.record.id;

    expect(recueil.reviews.worklist(review.id, 'title_abstract')).toMatchObject({ total: 4, pending: 4 });
    recueil.reviews.decide(txa, { stage: 'title_abstract', decision: 'include' }, recueil.actor);
    recueil.reviews.decide(hemi, { stage: 'title_abstract', decision: 'maybe' }, recueil.actor);
    recueil.reviews.decide(cohort, { stage: 'title_abstract', decision: 'include' }, recueil.actor);
    recueil.reviews.decide(block, { stage: 'title_abstract', decision: 'include' }, recueil.actor);
    // Change of mind, then undo: three rows, one current.
    recueil.reviews.decide(block, { stage: 'title_abstract', decision: 'exclude', reasonCode: 'wrong_population' }, recueil.actor);
    expect(() => recueil.reviews.decide(block, { stage: 'title_abstract', decision: 'exclude', reasonCode: 'wrong_design' }, recueil.actor)).toThrow(/belongs to full_text/u);
    recueil.reviews.undo(block, 'title_abstract', recueil.actor);
    expect(recueil.reviews.currentDecision(block, 'title_abstract')!.decision).toBe('include');
    recueil.reviews.decide(block, { stage: 'title_abstract', decision: 'exclude', reasonCode: 'wrong_population' }, recueil.actor);
    expect(recueil.reviews.decisions(block)).toHaveLength(4);
    expect(recueil.reviews.decisions(block).filter((d) => d.isCurrent)).toHaveLength(1);

    // Full text needs the text, and an exclusion needs a reason.
    expect(() => recueil.reviews.decide(txa, { stage: 'full_text', decision: 'include' }, recueil.actor)).toThrow(/retrieved/u);
    expect(() => recueil.reviews.setRetrieval(block, { status: 'sought' }, recueil.actor)).toThrow(/passed title\/abstract/u);
    for (const id of [txa, cohort]) recueil.reviews.setRetrieval(id, { status: 'retrieved' }, recueil.actor);
    recueil.reviews.setRetrieval(hemi, { status: 'not_retrieved', note: 'no access' }, recueil.actor);
    expect(() => recueil.reviews.decide(cohort, { stage: 'full_text', decision: 'exclude' }, recueil.actor)).toThrow(/needs a reason/u);
    recueil.reviews.decide(cohort, { stage: 'full_text', decision: 'exclude', reasonCode: 'wrong_design' }, recueil.actor);
    recueil.reviews.decide(txa, { stage: 'full_text', decision: 'include' }, recueil.actor);
    expect(() => recueil.reviews.undo(txa, 'title_abstract', recueil.actor)).toThrow(/full-text decision depends/u);

    expect(recueil.reviews.verifyCaches(review.id)).toEqual([]);
    expect(recueil.reviews.record(txa)).toMatchObject({ stage: 'included', screeningStatus: 'included' });
    expect(recueil.reviews.record(cohort)).toMatchObject({ stage: 'excluded', exclusionReasonCode: 'wrong_design' });

    const flow = recueil.reviews.prisma(review.id);
    expect(cell(flow, 'records_identified_databases')).toBe(6);
    expect(cell(flow, 'records_removed_duplicates')).toBe(2);
    expect(cell(flow, 'records_screened')).toBe(4);
    expect(cell(flow, 'records_excluded')).toBe(1);
    expect(cell(flow, 'reports_sought')).toBe(3);
    expect(cell(flow, 'reports_not_retrieved')).toBe(1);
    expect(cell(flow, 'reports_assessed')).toBe(2);
    expect(cell(flow, 'reports_excluded')).toBe(1);
    expect(cell(flow, 'studies_included')).toBe(1);
    expect(flow.cells.filter((c) => c.stageKey === 'records_identified_databases' && c.sourceLabel !== null).map((c) => c.count)).toEqual([3, 3]);
    expect(recueil.reviews.searchRuns(review.id).map((run) => run.duplicatesRemoved)).toEqual([0, 2]);

    // PC2: a snapshot taken now equals the live numbers; PC1: it does not move afterwards.
    const frozen = recueil.reviews.freezePrisma(review.id, 'submission', recueil.actor);
    const sort = (cells: typeof flow.cells) => [...cells].sort((a, b) => `${a.stageKey}${a.sourceLabel}${a.exclusionReasonCode}`.localeCompare(`${b.stageKey}${b.sourceLabel}${b.exclusionReasonCode}`));
    expect(sort(recueil.reviews.snapshot(review.id, frozen.snapshotAt))).toEqual(sort(flow.cells));
    recueil.reviews.undo(txa, 'full_text', recueil.actor);
    expect(cell(recueil.reviews.prisma(review.id), 'studies_included')).toBe(0);
    expect(recueil.reviews.snapshot(review.id, frozen.snapshotAt).find((c) => c.stageKey === 'studies_included')!.count).toBe(1);
    recueil.reviews.decide(txa, { stage: 'full_text', decision: 'include' }, recueil.actor);

    const labels = { wrong_design: 'Wrong study design' };
    const data = Object.fromEntries(prismaData(recueil.reviews.prisma(review.id), labels));
    expect(data).toMatchObject({ database_results: '6', duplicates: '2', records_screened: '4', dbr_excluded: 'Wrong study design, 1', new_studies: '1' });
    expect(data['database_specific_results']).toMatch(/^pubmed \(native\) \d{4}-\d\d-\d\d, 3; embase \(Ovid\) \d{4}-\d\d-\d\d, 3$/u);
    expect(prismaSvg(recueil.reviews.prisma(review.id), 'Hip fracture care')).toContain('Records screened (n = 4)');

    // The audit trail carries the tool flag because the review discloses automation (ADR-020).
    const audit = screeningAuditCsv(recueil, review.id);
    expect(audit.split('\n')[0]).toContain('tool_assisted');
    expect(audit.split('\n').filter((line) => line !== '').length).toBe(1 + recueil.reviews.reviewDecisions(review.id).length);

    // The R client's fixture is this writer's output; the R tests read it with PRISMA2020.
    writeOrCompare('prisma_counts.csv', prismaCsv(recueil.reviews.prisma(review.id), labels).replace(/ \d{4}-\d\d-\d\d,/gu, ','));
  });

  it('marks decisions written by an MCP token as tool-assisted (SD2)', () => {
    const { review } = screened();
    const now = new Date().toISOString();
    recueil.db.insert(schema.apiTokens).values({ id: 'tok_mcp_0000000000000', userId: recueil.user.id, name: 'mcp', tokenPrefix: 'rc_test', tokenHash: 'x', client: 'mcp', createdAt: now }).run();
    const id = byTitle(review.id, 'Tranexamic')[0]!.record.id;
    const decision = recueil.reviews.decide(id, { stage: 'title_abstract', decision: 'include', toolDetail: { model: 'screening-assistant', suggested: 'include' } }, { type: 'token', userId: recueil.user.id, tokenId: 'tok_mcp_0000000000000' });
    expect(decision.toolAssisted).toBe(true);
    expect(JSON.parse(decision.toolDetail!)).toMatchObject({ suggested: 'include' });
    const manual = recueil.reviews.decide(byTitle(review.id, 'Nerve')[0]!.record.id, { stage: 'title_abstract', decision: 'include', toolDetail: { ignored: true } }, recueil.actor);
    expect(manual).toMatchObject({ toolAssisted: false, toolDetail: null });
  });

  it('keeps an exclusion reason that decisions use', () => {
    const { review } = screened();
    recueil.reviews.decide(byTitle(review.id, 'Nerve')[0]!.record.id, { stage: 'title_abstract', decision: 'exclude', reasonCode: 'wrong_population' }, recueil.actor);
    expect(() => recueil.reviews.update(review.id, { exclusionReasons: [] }, recueil.actor)).toThrow(/still in use/u);
  });
});

describe('extraction and risk of bias', () => {
  const included = () => {
    const { review, pubmed } = setup();
    importSearchFile(recueil, pubmed.id, MEDLINE);
    const ids = recueil.reviews.records(review.id).map((r) => r.id);
    for (const id of ids.slice(0, 2)) {
      recueil.reviews.decide(id, { stage: 'title_abstract', decision: 'include' }, recueil.actor);
      recueil.reviews.setRetrieval(id, { status: 'retrieved' }, recueil.actor);
      recueil.reviews.decide(id, { stage: 'full_text', decision: 'include' }, recueil.actor);
    }
    return { review, ids };
  };

  it('extracts into a template form, scoped to the review, locks on completion, and versions (EF1, EF2)', () => {
    const { review, ids } = included();
    const form = recueil.extraction.createFromTemplate(review.id, 'rct', recueil.actor);
    expect(recueil.customFields.getFieldByKey('sr_events_treatment').scope).toBe('review');
    const [a, b] = ids as [string, string];
    expect(() => recueil.extraction.setValue(ids[2]!, form.id, { fieldKey: 'sr_country', content: { type: 'text', value: 'UK' } }, recueil.actor)).toThrow(/included studies/u);
    expect(() => recueil.extraction.setValue(a, form.id, { fieldKey: 'sr_events_treatment', content: { type: 'integer', value: 4 } }, recueil.actor)).toThrow(/repeated per outcome/u);
    recueil.extraction.setValue(a, form.id, { fieldKey: 'sr_country', content: { type: 'text', value: 'UK' } }, recueil.actor);
    for (const [key, value] of [['sr_events_treatment', 4], ['sr_n_treatment', 100], ['sr_events_control', 9], ['sr_n_control', 100]] as const) {
      recueil.extraction.setValue(a, form.id, { fieldKey: key, groupKey: 'outcome:mortality_30d', content: { type: 'integer', value } }, recueil.actor);
    }
    recueil.extraction.setValue(b, form.id, { fieldKey: 'sr_country', isBlank: true }, recueil.actor);
    expect(recueil.reviews.record(a).extractionStatus).toBe('in_progress');
    // Library values on the same item are a different slot from the review's.
    const itemId = recueil.reviews.record(a).itemId;
    recueil.customFields.setValue({ fieldKey: 'sr_country', itemId, content: { type: 'text', value: 'library value' } }, recueil.actor);
    expect(recueil.customFields.listValues(itemId).map((v) => v.content)).toEqual([{ type: 'text', value: 'library value' }]);
    expect(recueil.extraction.values(a)).toHaveLength(5);

    recueil.extraction.complete(a, recueil.actor);
    expect(recueil.extraction.form(form.id).status).toBe('locked');
    const next = recueil.extraction.updateForm(form.id, { ...recueil.extraction.definition(form), sections: [...recueil.extraction.definition(form).sections] }, recueil.actor);
    expect(next.version).toBe(2);

    const wide = extractionCsv(recueil, review.id, 'wide');
    const header = wide.split('\n')[0]!.split(',');
    expect(header.slice(0, 4)).toEqual(['study', 'record_id', 'group', 'sr_country']);
    expect(header).toEqual(expect.arrayContaining(['sr_events_treatment', 'sr_n_treatment', 'sr_events_control', 'sr_n_control']));
    expect(wide).toContain(',outcome:mortality_30d,UK,4,100,9,100');
    expect(extractionCsv(recueil, review.id, 'long').split('\n')[0]).toBe('study,record_id,item_id,group,field,value,blank,form_version');
    writeOrCompare('extraction_wide.csv', wide.replace(/,[0-9A-Za-z_]{20,},/gu, ',ID,'));
  });

  it('assesses risk of bias with RoB 2, supersedes, and writes the robvis table (RB1)', () => {
    const { review, ids } = included();
    const [a, b] = ids as [string, string];
    expect(() => recueil.extraction.assess(a, { tool: 'rob2', domainJudgements: { D9: { judgement: 'low' } } }, recueil.actor)).toThrow(/not a domain/u);
    const low = { judgement: 'low' };
    const first = recueil.extraction.assess(a, { tool: 'rob2', domainJudgements: { D1: low, D2: low, D3: low, D4: low, D5: low } }, recueil.actor);
    expect(first.overallJudgement).toBe('low');
    const second = recueil.extraction.assess(a, { tool: 'rob2', domainJudgements: { D1: low, D2: { judgement: 'some_concerns' }, D3: low, D4: low, D5: low }, signallingAnswers: { '1.1': { answer: 'Y' } } }, recueil.actor);
    expect(second.overallJudgement).toBe('some_concerns');
    recueil.extraction.assess(b, { tool: 'rob2', domainJudgements: { D1: { judgement: 'high' }, D2: low, D3: low, D4: { judgement: 'no_information' }, D5: low }, overallJudgement: 'high' }, recueil.actor);
    expect(recueil.extraction.assessments(review.id, { includeSuperseded: true })).toHaveLength(3);
    const csv = robvisCsv(recueil, review.id, 'rob2');
    expect(csv.split('\n')[0]).toBe('Study,D1,D2,D3,D4,D5,Overall,Weight');
    expect(csv).toContain('Lovelace 2019,Low,Some concerns,Low,Low,Low,Some concerns,1');
    expect(csv).toContain('Curie 2020,High,Low,Low,No information,Low,High,1');
    writeOrCompare('robvis_rob2.csv', csv);
  });

  it('leaves the library alone when a review is trashed', () => {
    const { review } = included();
    const before = recueil.db.select().from(schema.items).all().filter((item) => item.trashedAt === null).length;
    recueil.reviews.trash(review.id, recueil.actor);
    expect(() => recueil.reviews.get(review.id)).toThrow();
    expect(recueil.db.select().from(schema.items).all().filter((item) => item.trashedAt === null)).toHaveLength(before);
  });
});

/** Fixtures the R client tests read: rewritten with UPDATE_FIXTURES=1, compared otherwise. */
const writeOrCompare = (name: string, content: string): void => {
  const path = join(fixtures, name);
  if (process.env['UPDATE_FIXTURES'] === '1' || !existsSync(path)) {
    writeFileSync(path, content);
    return;
  }
  expect(content).toBe(readFileSync(path, 'utf8'));
};
