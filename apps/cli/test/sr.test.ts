import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from './support.js';

let dir: string;
let lib: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recueil-cli-sr-'));
  lib = ['--database', join(dir, 'lib.sqlite'), '--storage', join(dir, 'store')];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MEDLINE = `PMID- 31000001
DP  - 2019 Mar
TI  - Tranexamic acid in hip fracture surgery.
FAU - Lovelace, Ada
AID - 10.1000/txa.2019 [doi]
JT  - Injury

PMID- 31000002
DP  - 2020
TI  - Cemented versus uncemented hemiarthroplasty.
FAU - Curie, Marie
JT  - The bone & joint journal
`;

describe('recueil sr', () => {
  it('runs a review from search to PRISMA counts', async () => {
    const created = await runCli(['sr', 'create', 'Hip fracture care', '--reason', 'wrong_population=Wrong population', '--reason', 'wrong_design=Wrong design@full_text', ...lib]);
    expect(created.code, created.stderr).toBe(0);
    const reviewId = created.stdout.trim();

    writeFileSync(join(dir, 'pubmed.nbib'), MEDLINE);
    const search = await runCli(['--json', 'sr', 'search', reviewId, join(dir, 'pubmed.nbib'), '--database', 'pubmed', '--query', '"hip fractures"[MeSH]', '--returned', '2', ...lib]);
    expect(search.code, search.stderr).toBe(0);
    const payload = JSON.parse(search.stdout) as { summary: { parsed: number; added: number; documentId: string } };
    expect(payload.summary).toMatchObject({ parsed: 2, added: 2 });
    expect(payload.summary.documentId).toMatch(/^[0-9A-Z]{26}$/u);

    const show = await runCli(['--json', 'sr', 'show', reviewId, ...lib]);
    const shown = JSON.parse(show.stdout) as { pending: { titleAbstract: number } };
    expect(shown.pending.titleAbstract).toBe(2);

    const list = await runCli(['--json', 'sr', 'prisma', reviewId, ...lib]);
    const flow = JSON.parse(list.stdout) as { cells: { stageKey: string; count: number; sourceLabel: string | null }[] };
    expect(flow.cells.find((cell) => cell.stageKey === 'records_screened')!.count).toBe(2);

    // Script-mode screening: one decision per call, the reason checked against the review's list.
    const records = (await runCli(['--json', 'sr', 'show', reviewId, ...lib])).stdout;
    expect(records).toContain('Hip fracture care');
    const csv = await runCli(['sr', 'export', reviewId, '--what', 'prisma', ...lib]);
    expect(csv.code).toBe(0);
    expect(csv.stdout.split('\n')[0]).toBe('data,n');
    expect(csv.stdout).toContain('records_screened,2');
  });

  it('refuses the interactive loop without a terminal, and says how to script it', async () => {
    const created = await runCli(['sr', 'create', 'R', ...lib]);
    const result = await runCli(['sr', 'screen', created.stdout.trim(), ...lib]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--record and --decide');
  });
});
