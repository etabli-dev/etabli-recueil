/**
 * `recueil sr` — systematic reviews (CONCEPT §5.10, `spec/systematic-review.md`).
 *
 *   recueil sr create "<title>" [--reason code=Label[@stage]] [--disclose-automation]
 *   recueil sr list | show <review>
 *   recueil sr search <review> <file> --source pubmed --query '<verbatim>' [--returned n]
 *   recueil sr dedup <review> [--dry-run]
 *   recueil sr screen <review> [--stage full_text]                 keyboard loop on a terminal
 *   recueil sr screen <review> --record <id> --decide exclude --reason wrong_population
 *   recueil sr retrieve <review> <record> --status retrieved|not_retrieved
 *   recueil sr prisma <review> [--freeze <label>] [--format table|csv|svg|json]
 *   recueil sr form <review> --template rct
 *   recueil sr extract <review> <record> --form <id> --field sr_n_treatment --group outcome:mortality --value 100
 *   recueil sr rob <review> <record> --tool rob2 --domain D1=low --domain D2=some_concerns …
 *   recueil sr export <review> --what extraction|included|audit|robvis|prisma
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import type { ExclusionReason, Recueil, ScreeningStage } from '@recueil/core';
import { extractionCsv, includedStudiesCsv, prismaCsv, prismaSvg, robvisCsv, screeningAuditCsv, storeAndImportSearchFile } from '@recueil/sr';
import type { SearchFileFormat } from '@recueil/sr';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { resolveLibraryLocation, withLibrary } from '../library.js';
import type { LibraryFlags } from '../library.js';
import type { Ui } from '../ui.js';

const choice =
  <T extends string>(values: readonly T[]) =>
  (value: string): T => {
    if (!(values as readonly string[]).includes(value)) throw new InvalidArgumentError(values.join(' | '));
    return value as T;
  };

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

const lib = (command: Command): Command =>
  command
    .option('-d, --database <url>', 'the Recueil library (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)');

const open = <T>(flags: LibraryFlags, body: (recueil: Recueil) => Promise<T>) => withLibrary(resolveLibraryLocation(flags), { mustExist: true }, body);

const emit = (text: string, output: string | undefined, ui: Ui): void => {
  if (output === undefined) process.stdout.write(text);
  else {
    writeFileSync(output, text);
    ui.info(`wrote ${output}`);
  }
};

const STAGES = { ta: 'title_abstract', title_abstract: 'title_abstract', ft: 'full_text', full_text: 'full_text' } as const;
const stageOf = (value: string | undefined): ScreeningStage => {
  if (value === undefined) return 'title_abstract';
  const stage = (STAGES as Record<string, ScreeningStage>)[value];
  if (stage === undefined) throw new CliError(`--stage is ta | ft, not '${value}'`, { exitCode: ExitCode.Usage });
  return stage;
};

/** `wrong_population=Wrong population@any`. */
const parseReason = (value: string): ExclusionReason => {
  const match = /^([a-z0-9_.-]+)=([^@]+)(?:@(title_abstract|full_text|any))?$/u.exec(value);
  if (match === null) throw new CliError(`--reason is code=Label[@title_abstract|full_text|any], not '${value}'`, { exitCode: ExitCode.Usage });
  return { code: match[1]!, label: match[2]!.trim(), stage: (match[3] as ExclusionReason['stage'] | undefined) ?? 'any' };
};

const count = (recueil: Recueil, reviewId: string, key: string): number =>
  recueil.reviews.prisma(reviewId).cells.find((cell) => cell.stageKey === key && cell.sourceLabel === null && cell.exclusionReasonCode === null)?.count ?? 0;

export const registerSr = (parent: Command, describe: (name: string) => string, ui: () => Ui): Command => {
  const sr = parent.command('sr').description(describe('sr'));

  lib(
    sr
      .command('create')
      .description('Start a review')
      .argument('<title>')
      .option('--question <text>', 'the review question')
      .option('--registration <id>', 'PROSPERO or OSF id')
      .option('--reason <code=Label[@stage]>', 'an exclusion reason, in the order PRISMA reports them (repeatable)', collect)
      .option('--disclose-automation', 'record and export which decisions were tool-assisted (ADR-020)'),
  ).action(async (title: string, flags: LibraryFlags & { question?: string; registration?: string; reason?: string[]; discloseAutomation?: boolean }) => {
    await withLibrary(resolveLibraryLocation(flags), {}, async (recueil) => {
      const review = recueil.reviews.create(
        {
          title,
          ...(flags.question === undefined ? {} : { question: flags.question }),
          ...(flags.registration === undefined ? {} : { registrationId: flags.registration }),
          exclusionReasons: (flags.reason ?? []).map(parseReason),
          automationDisclosure: flags.discloseAutomation === true,
        },
        recueil.actor,
      );
      if (ui().json) return ui().outJson({ command: 'sr.create', review });
      ui().out(review.id);
      ui().info(`Created review '${review.title}'. Next: \`recueil sr search ${review.id} <export file> --source pubmed --query '…'\`.`);
    });
  });

  lib(sr.command('list').description('The reviews in this library')).action(async (flags: LibraryFlags) => {
    await open(flags, async (recueil) => {
      const reviews = recueil.reviews.list();
      if (ui().json) return ui().outJson({ command: 'sr.list', reviews });
      for (const review of reviews) ui().out(`${review.id}  ${review.status.padEnd(10)}  ${review.title}`);
    });
  });

  lib(sr.command('show').description('A review: its searches and where screening stands').argument('<review>')).action(async (reviewId: string, flags: LibraryFlags) => {
    await open(flags, async (recueil) => {
      const review = recueil.reviews.get(reviewId);
      const runs = recueil.reviews.searchRuns(reviewId);
      const flow = recueil.reviews.prisma(reviewId);
      const ta = recueil.reviews.worklist(reviewId, 'title_abstract', { limit: 1 });
      const ft = recueil.reviews.worklist(reviewId, 'full_text', { limit: 1 });
      if (ui().json) return ui().outJson({ command: 'sr.show', review, searchRuns: runs, prisma: flow, pending: { titleAbstract: ta.pending, fullText: ft.pending } });
      ui().out(`${review.title}  [${review.status}]`);
      for (const run of runs) ui().out(`  ${run.sourceDatabase}${run.interface === null ? '' : ` (${run.interface})`}  ${run.executedAt.slice(0, 10)}  returned ${run.recordsReturned ?? '?'}, imported ${run.recordsImported ?? 0}, duplicates ${run.duplicatesRemoved ?? 0}`);
      ui().out(`  title/abstract: ${ta.total - ta.pending} of ${ta.total} screened; full text: ${ft.total - ft.pending} of ${ft.total}; included ${count(recueil, reviewId, 'studies_included')} studies`);
    });
  });

  lib(
    sr
      .command('search')
      .description('Record a search run and import its export file (RIS, MEDLINE/NBIB, BibTeX, CSL-JSON)')
      .argument('<review>')
      .argument('<file>')
      .requiredOption('--source <name>', 'the database searched: pubmed | embase | web_of_science | scopus | cochrane | registry | citation_search | …')
      .requiredOption('--query <text>', 'the query, verbatim, in the syntax of the interface (PRISMA-S)')
      .option('--interface <name>', 'Ovid, EBSCOhost, native …')
      .option('--returned <n>', 'the number of records the database reported', Number)
      .option('--executed-at <iso>', 'when the search ran (default now)')
      .option('--format <format>', 'ris | medline | bibtex | csl-json (detected by default)', choice(['ris', 'medline', 'bibtex', 'csl-json'] as const)),
  ).action(async (reviewId: string, file: string, flags: LibraryFlags & { source: string; query: string; interface?: string; returned?: number; executedAt?: string; format?: SearchFileFormat }) => {
    await open(flags, async (recueil) => {
      const text = readFileSync(file, 'utf8');
      const run = recueil.reviews.addSearchRun(
        reviewId,
        {
          sourceDatabase: flags.source,
          queryString: flags.query,
          ...(flags.interface === undefined ? {} : { interface: flags.interface }),
          ...(flags.returned === undefined ? {} : { recordsReturned: flags.returned }),
          ...(flags.executedAt === undefined ? {} : { executedAt: flags.executedAt }),
        },
        recueil.actor,
      );
      const summary = await storeAndImportSearchFile(recueil, run.id, text, { filename: file.split('/').at(-1)!, ...(flags.format === undefined ? {} : { format: flags.format }) });
      if (ui().json) return ui().outJson({ command: 'sr.search', searchRunId: run.id, summary: { ...summary, losses: summary.losses.length } });
      ui().out(`search run ${run.id}: ${summary.parsed} records parsed (${summary.format}), ${summary.added} new, ${summary.sourceAdded} already found by another search, ${summary.repeated} repeated`);
      if (summary.returnedDiffers) ui().warn(`the database reported ${flags.returned} records; ${summary.parsed - summary.failures.length} arrived (SR1: report the difference)`);
      for (const failure of summary.failures) ui().warn(`record ${failure.index + 1} (${failure.title ?? 'untitled'}): ${failure.reason}`);
      process.exitCode = summary.failures.length > 0 ? ExitCode.Review : ExitCode.Success;
    });
  });

  lib(sr.command('dedup').description('Mark the duplicates identifiers could not catch').argument('<review>').option('--dry-run', 'only list the pairs').option('--threshold <n>', 'title similarity, 0.5–1 (default 0.93)', Number)).action(
    async (reviewId: string, flags: LibraryFlags & { dryRun?: boolean; threshold?: number }) => {
      await open(flags, async (recueil) => {
        const result = recueil.reviews.dedup(reviewId, recueil.actor, { ...(flags.dryRun === true ? { dryRun: true } : {}), ...(flags.threshold === undefined ? {} : { threshold: flags.threshold }) });
        if (ui().json) return ui().outJson({ command: 'sr.dedup', ...result });
        for (const pair of result.pairs) {
          ui().out(`${pair.duplicateId} duplicates ${pair.masterId}  (${pair.similarity})  ${recueil.reviews.view(pair.masterId).title ?? ''}`);
        }
        ui().info(`${result.pairs.length} duplicates ${flags.dryRun === true ? 'found (dry run)' : 'marked; undo one with the API or `recueil sr dedup` after fixing the record'}`);
      });
    },
  );

  lib(
    sr
      .command('screen')
      .description('Screen records: a keyboard loop on a terminal, or one decision with --record')
      .argument('<review>')
      .option('--stage <stage>', 'ta (default) | ft')
      .option('--record <id>', 'decide this record and exit')
      .option('--decide <decision>', 'include | exclude | maybe', choice(['include', 'exclude', 'maybe'] as const))
      .option('--reason <code>', 'the exclusion reason (required at full text)')
      .option('--note <text>', 'a note on the exclusion')
      .option('--undo', 'undo the current decision of --record'),
  ).action(async (reviewId: string, flags: LibraryFlags & { stage?: string; record?: string; decide?: 'include' | 'exclude' | 'maybe'; reason?: string; note?: string; undo?: boolean }) => {
    await open(flags, async (recueil) => {
      const stage = stageOf(flags.stage);
      if (flags.record !== undefined) {
        const record = recueil.reviews.record(flags.record);
        if (record.reviewId !== reviewId) throw new CliError(`record ${flags.record} is not in review ${reviewId}`, { exitCode: ExitCode.Usage });
        if (flags.undo === true) recueil.reviews.undo(flags.record, stage, recueil.actor);
        else {
          if (flags.decide === undefined) throw new CliError('--record needs --decide or --undo', { exitCode: ExitCode.Usage });
          recueil.reviews.decide(flags.record, { stage, decision: flags.decide, ...(flags.reason === undefined ? {} : { reasonCode: flags.reason }), ...(flags.note === undefined ? {} : { reasonNote: flags.note }) }, recueil.actor);
        }
        const view = recueil.reviews.view(flags.record);
        if (ui().json) return ui().outJson({ command: 'sr.screen', record: view.record });
        ui().out(`${flags.record}: ${view.record.screeningStatus} (${view.record.stage})`);
        return;
      }
      if (!process.stdin.isTTY || ui().json) throw new CliError('the screening loop needs a terminal; use --record and --decide in scripts', { exitCode: ExitCode.Usage });
      await screeningLoop(recueil, reviewId, stage, ui());
    });
  });

  lib(
    sr
      .command('retrieve')
      .description('Record whether the full text was found')
      .argument('<review>')
      .argument('<record>')
      .requiredOption('--status <status>', 'sought | retrieved | not_retrieved', choice(['not_attempted', 'sought', 'retrieved', 'not_retrieved'] as const))
      .option('--note <text>', 'why it could not be retrieved, for instance'),
  ).action(async (reviewId: string, recordId: string, flags: LibraryFlags & { status: 'not_attempted' | 'sought' | 'retrieved' | 'not_retrieved'; note?: string }) => {
    await open(flags, async (recueil) => {
      if (recueil.reviews.record(recordId).reviewId !== reviewId) throw new CliError(`record ${recordId} is not in review ${reviewId}`, { exitCode: ExitCode.Usage });
      const record = recueil.reviews.setRetrieval(recordId, { status: flags.status, ...(flags.note === undefined ? {} : { note: flags.note }) }, recueil.actor);
      ui().out(`${recordId}: ${record.retrievalStatus}`);
    });
  });

  lib(
    sr
      .command('prisma')
      .description('The PRISMA 2020 counts, live; --freeze keeps them as a snapshot')
      .argument('<review>')
      .option('--freeze <label>', 'freeze the current numbers under this label (submission, revision 1 …)')
      .option('--format <format>', 'table (default) | csv | svg | json', choice(['table', 'csv', 'svg', 'json'] as const))
      .option('-o, --output <file>', 'write here instead of stdout'),
  ).action(async (reviewId: string, flags: LibraryFlags & { freeze?: string; format?: 'table' | 'csv' | 'svg' | 'json'; output?: string }) => {
    await open(flags, async (recueil) => {
      if (flags.freeze !== undefined) {
        const snapshot = recueil.reviews.freezePrisma(reviewId, flags.freeze, recueil.actor);
        ui().info(`froze ${snapshot.cells.length} counts at ${snapshot.snapshotAt}`);
      }
      const flow = recueil.reviews.prisma(reviewId);
      const labels = Object.fromEntries(recueil.reviews.reasons(reviewId).map((reason) => [reason.code, reason.label]));
      const format = ui().json ? 'json' : (flags.format ?? 'table');
      if (format === 'json') return emit(`${JSON.stringify(flow, null, 2)}\n`, flags.output, ui());
      if (format === 'csv') return emit(prismaCsv(flow, labels), flags.output, ui());
      if (format === 'svg') return emit(prismaSvg(flow, recueil.reviews.get(reviewId).title, labels), flags.output, ui());
      const lines = flow.cells.map((cell) => `${cell.stageKey.padEnd(30)} ${String(cell.count).padStart(6)}  ${cell.sourceLabel ?? (cell.exclusionReasonCode === null ? '' : (labels[cell.exclusionReasonCode] ?? cell.exclusionReasonCode))}`);
      emit(`${lines.join('\n')}\n`, flags.output, ui());
    });
  });

  lib(sr.command('form').description('Create an extraction form from a template').argument('<review>').requiredOption('--template <name>', 'rct | observational | diagnostic', choice(['rct', 'observational', 'diagnostic'] as const)).option('--name <name>', 'the form name')).action(
    async (reviewId: string, flags: LibraryFlags & { template: 'rct' | 'observational' | 'diagnostic'; name?: string }) => {
      await open(flags, async (recueil) => {
        const form = recueil.extraction.createFromTemplate(reviewId, flags.template, recueil.actor, flags.name);
        if (ui().json) return ui().outJson({ command: 'sr.form', form: { ...form, definition: recueil.extraction.definition(form) } });
        ui().out(form.id);
        for (const section of recueil.extraction.definition(form).sections) ui().info(`  ${section.title}: ${section.fields.map((field) => (field.group === undefined ? field.fieldKey : `${field.fieldKey} [${field.group}]`)).join(', ')}`);
      });
    },
  );

  lib(
    sr
      .command('extract')
      .description('Write one extracted value, or complete a record')
      .argument('<review>')
      .argument('<record>')
      .option('--form <id>', 'the extraction form')
      .option('--field <key>', 'the field key')
      .option('--group <key>', 'the group instance, e.g. outcome:mortality_30d')
      .option('--value <value>', 'the value, parsed by the field type')
      .option('--blank', 'record "not reported"')
      .option('--complete', 'mark the extraction complete; the forms used lock'),
  ).action(async (reviewId: string, recordId: string, flags: LibraryFlags & { form?: string; field?: string; group?: string; value?: string; blank?: boolean; complete?: boolean }) => {
    await open(flags, async (recueil) => {
      if (recueil.reviews.record(recordId).reviewId !== reviewId) throw new CliError(`record ${recordId} is not in review ${reviewId}`, { exitCode: ExitCode.Usage });
      if (flags.complete === true) {
        recueil.extraction.complete(recordId, recueil.actor);
        return ui().out(`${recordId}: extraction complete`);
      }
      if (flags.form === undefined || flags.field === undefined) throw new CliError('--form and --field are required to write a value', { exitCode: ExitCode.Usage });
      if ((flags.value === undefined) === (flags.blank !== true)) throw new CliError('give --value or --blank, not both', { exitCode: ExitCode.Usage });
      const field = recueil.customFields.getFieldByKey(flags.field);
      const content = flags.value === undefined ? undefined : contentFor(field.dataType, flags.value);
      recueil.extraction.setValue(recordId, flags.form, { fieldKey: flags.field, ...(flags.group === undefined ? {} : { groupKey: flags.group }), ...(content === undefined ? { isBlank: true } : { content }) }, recueil.actor);
      ui().out(`${recordId}: ${flags.field}${flags.group === undefined ? '' : ` [${flags.group}]`} = ${flags.value ?? 'not reported'}`);
    });
  });

  lib(
    sr
      .command('rob')
      .description('Assess risk of bias for an included study')
      .argument('<review>')
      .argument('<record>')
      .requiredOption('--tool <tool>', 'rob2 | robins_i | quadas2 | newcastle_ottawa')
      .option('--domain <D=judgement>', 'a domain judgement, e.g. D1=low (repeatable)', collect)
      .option('--overall <judgement>', 'the overall judgement (proposed from the domains when omitted)')
      .option('--outcome <label>', 'the outcome assessed (RoB 2 is per outcome)'),
  ).action(async (reviewId: string, recordId: string, flags: LibraryFlags & { tool: string; domain?: string[]; overall?: string; outcome?: string }) => {
    await open(flags, async (recueil) => {
      if (recueil.reviews.record(recordId).reviewId !== reviewId) throw new CliError(`record ${recordId} is not in review ${reviewId}`, { exitCode: ExitCode.Usage });
      const domainJudgements: Record<string, { judgement: string }> = {};
      for (const entry of flags.domain ?? []) {
        const [key, judgement] = entry.split('=');
        if (key === undefined || judgement === undefined) throw new CliError(`--domain is D=judgement, not '${entry}'`, { exitCode: ExitCode.Usage });
        domainJudgements[key] = { judgement };
      }
      const row = recueil.extraction.assess(recordId, { tool: flags.tool, domainJudgements, ...(flags.overall === undefined ? {} : { overallJudgement: flags.overall }), ...(flags.outcome === undefined ? {} : { outcomeLabel: flags.outcome }) }, recueil.actor);
      ui().out(`${recordId}: ${row.tool} overall ${row.overallJudgement ?? '—'}`);
    });
  });

  lib(
    sr
      .command('export')
      .description('The tables R reads: extraction (metafor), included studies, the audit trail, robvis, PRISMA2020')
      .argument('<review>')
      .requiredOption('--what <table>', 'extraction | included | audit | robvis | prisma', choice(['extraction', 'included', 'audit', 'robvis', 'prisma'] as const))
      .option('--shape <shape>', 'for extraction: long (default) | wide', choice(['long', 'wide'] as const))
      .option('--tool <tool>', 'for robvis: rob2 (default) | robins_i | quadas2 | newcastle_ottawa')
      .option('-o, --output <file>', 'write here instead of stdout'),
  ).action(async (reviewId: string, flags: LibraryFlags & { what: 'extraction' | 'included' | 'audit' | 'robvis' | 'prisma'; shape?: 'long' | 'wide'; tool?: string; output?: string }) => {
    await open(flags, async (recueil) => {
      recueil.reviews.get(reviewId);
      const labels = Object.fromEntries(recueil.reviews.reasons(reviewId).map((reason) => [reason.code, reason.label]));
      const text =
        flags.what === 'extraction'
          ? extractionCsv(recueil, reviewId, flags.shape ?? 'long')
          : flags.what === 'included'
            ? includedStudiesCsv(recueil, reviewId)
            : flags.what === 'audit'
              ? screeningAuditCsv(recueil, reviewId)
              : flags.what === 'robvis'
                ? robvisCsv(recueil, reviewId, flags.tool ?? 'rob2')
                : prismaCsv(recueil.reviews.prisma(reviewId), labels);
      emit(text, flags.output, ui());
    });
  });

  return sr;
};

const contentFor = (dataType: string, value: string) => {
  switch (dataType) {
    case 'integer': {
      const n = Number(value);
      if (!Number.isInteger(n)) throw new CliError(`'${value}' is not an integer`, { exitCode: ExitCode.Usage });
      return { type: 'integer' as const, value: n };
    }
    case 'number': {
      const n = Number(value);
      if (Number.isNaN(n)) throw new CliError(`'${value}' is not a number`, { exitCode: ExitCode.Usage });
      return { type: 'number' as const, value: n };
    }
    case 'boolean':
      return { type: 'boolean' as const, value: /^(true|yes|1)$/iu.test(value) };
    case 'choice':
      return { type: 'choice' as const, value };
    case 'long_text':
      return { type: 'long_text' as const, value };
    case 'date':
      return { type: 'date' as const, value };
    default:
      return { type: 'text' as const, value };
  }
};

/** The keyboard loop: i include, e exclude, m maybe, u undo the last, s skip, q quit. */
const screeningLoop = async (recueil: Recueil, reviewId: string, stage: ScreeningStage, ui: Ui): Promise<void> => {
  const reasons = recueil.reviews.reasons(reviewId).filter((reason) => reason.stage === 'any' || reason.stage === stage);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const history: string[] = [];
  const skipped = new Set<string>();
  try {
    for (;;) {
      const list = recueil.reviews.worklist(reviewId, stage, { status: 'pending', limit: 50 });
      const next = list.records.find((view) => !skipped.has(view.record.id));
      if (next === undefined) {
        ui.info(`${stage === 'title_abstract' ? 'Title/abstract' : 'Full-text'} screening: nothing pending.`);
        return;
      }
      ui.info('');
      ui.info(`[${list.total - list.pending + 1}/${list.total}] ${next.title ?? '(untitled)'}`);
      ui.info(`${next.authors.slice(0, 3).join(', ')}${next.authors.length > 3 ? ' et al.' : ''} · ${next.year ?? 'n.d.'} · ${next.venue ?? ''} · ${next.sources.join(', ')}`);
      if (next.abstract !== null) ui.info(next.abstract);
      const key = (await rl.question('i include · e exclude · m maybe · u undo · s skip · q quit > ')).trim().toLowerCase();
      if (key === 'q') return;
      if (key === 's') {
        skipped.add(next.record.id);
        continue;
      }
      if (key === 'u') {
        const last = history.pop();
        if (last === undefined) ui.warn('nothing to undo in this session');
        else recueil.reviews.undo(last, stage, recueil.actor);
        continue;
      }
      const decision = key === 'i' ? 'include' : key === 'e' ? 'exclude' : key === 'm' ? 'maybe' : null;
      if (decision === null) continue;
      let reasonCode: string | undefined;
      if (decision === 'exclude' && reasons.length > 0) {
        reasons.forEach((reason, index) => ui.info(`  ${index + 1} ${reason.label}`));
        const answer = (await rl.question(stage === 'full_text' ? 'reason > ' : 'reason (enter for none) > ')).trim();
        const index = Number(answer) - 1;
        if (answer !== '' && reasons[index] === undefined) continue;
        reasonCode = answer === '' ? undefined : reasons[index]!.code;
      }
      try {
        recueil.reviews.decide(next.record.id, { stage, decision, ...(reasonCode === undefined ? {} : { reasonCode }) }, recueil.actor);
        history.push(next.record.id);
      } catch (error) {
        ui.warn(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    rl.close();
  }
};
