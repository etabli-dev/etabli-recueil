/**
 * `recueil rules` — validate a rule set, and run it over a corpus without writing anything.
 *
 * CONCEPT.md §5.6 asks for "a dry-run report before execution". The honesty of the report below
 * rests on a structural fact rather than on a flag: `@recueil/rules` evaluates a rule set as a pure
 * function of the set and a plain subject value. It is handed no database, no storage backend and
 * no HTTP client, so there is no "apply" path this command has to remember to switch off. Running
 * the corpus twice gives the same report, and running it once writes nothing, because there is
 * nothing here that could write.
 *
 * It is the *same* engine `recueil ingest --rules` puts at stage 8 (see `src/rule-engine.ts`),
 * which is the property that makes the prediction worth anything. A dry run against a different
 * engine from the real one would be a report about a program nobody runs.
 *
 * What the exit code means is worth stating, because it is the thing a CI job branches on: a rule
 * set with a fault does not evaluate at all (1), a rule that could not be evaluated over a subject
 * is a failure (5), and a corpus with subjects no rule matched is a *note* (4) — unmatched
 * documents are the normal state of an incomplete rule set, and they are exactly what the report is
 * for.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  dryRunIngestion,
  renderIngestionReport,
  renderTrace,
  summariseIngestion,
} from '@recueil/rules';
import type { DryRunReport, IngestionOutcome, IngestionSubject } from '@recueil/rules';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { loadCorpus } from '../corpus.js';
import { asIngestionRuleSet, loadRuleSetFile } from '../ingest-options.js';
import { count, renderTable } from '../table.js';
import type { Ui } from '../ui.js';

export interface RulesTestFlags {
  against?: string;
  recursive?: boolean;
  trace?: boolean;
  markdown?: string;
  limit?: number;
  full?: boolean;
}

const parsePositiveInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError('expected a positive integer.');
  return parsed;
};

const ROW_PREVIEW = 40;

const perSubjectTable = (
  report: DryRunReport<IngestionOutcome>,
  subjects: readonly IngestionSubject[],
  full: boolean,
): string[] => {
  const byId = new Map(subjects.map((subject) => [subject.id, subject]));
  const shown = full ? report.entries : report.entries.slice(0, ROW_PREVIEW);

  const lines = renderTable(
    [
      { header: 'Subject' },
      { header: 'Rules' },
      { header: 'Item type' },
      { header: 'Tags' },
      { header: 'Review' },
      { header: 'Note' },
    ],
    shown.map((entry) => {
      const outcome = entry.outcome;
      const subject = byId.get(entry.subjectId);
      return [
        entry.subjectId,
        entry.trace === undefined
          ? '(trace not kept)'
          : entry.trace.matchedRuleIds.length === 0
            ? '(none matched)'
            : entry.trace.matchedRuleIds.join(', '),
        outcome.itemType?.value ?? '—',
        outcome.tags.length === 0 ? '—' : outcome.tags.map((tag) => tag.value).join(', '),
        outcome.review.length === 0 ? '—' : outcome.review.map((review) => review.reasonCode).join(', '),
        [
          outcome.stopped ? 'stopped by a rule' : '',
          outcome.conflicts.length > 0 ? `${outcome.conflicts.length} overwrite(s)` : '',
          subject?.text === undefined ? 'no text' : '',
        ]
          .filter((part) => part.length > 0)
          .join('; ') || '—',
      ];
    }),
  );

  if (!full && report.entries.length > shown.length) {
    lines.push(`… and ${report.entries.length - shown.length} more (run again with --full)`);
  }
  return lines;
};

export const exitCodeFor = (report: DryRunReport<IngestionOutcome>): number => {
  if (report.erroredSubjectIds.length > 0) return ExitCode.JobFailed;
  return report.unmatchedSubjectIds.length > 0 ? ExitCode.Review : ExitCode.Success;
};

export const runRulesTest = async (file: string, flags: RulesTestFlags, ui: Ui): Promise<void> => {
  if (flags.against === undefined) {
    throw new CliError('`recueil rules test` needs a corpus: pass --against.', {
      exitCode: ExitCode.Usage,
      detail: [
        '',
        '  --against takes a directory of real documents, or a JSON/YAML file of subjects.',
        '',
        '  recueil rules test office.yaml --against ~/Consume',
        '  recueil rules test office.yaml --against corpus.json',
      ],
    });
  }

  const ruleFile = resolve(file);
  const ruleSet = asIngestionRuleSet(loadRuleSetFile(ruleFile), ruleFile);

  let corpus;
  try {
    corpus = await loadCorpus(flags.against, { recursive: flags.recursive !== false });
  } catch (cause) {
    throw new CliError(
      `could not read the corpus '${resolve(flags.against)}': ${cause instanceof Error ? cause.message : String(cause)}`,
      { exitCode: ExitCode.Usage, cause },
    );
  }

  const subjects =
    flags.limit === undefined ? corpus.subjects : corpus.subjects.slice(0, flags.limit);

  ui.info(`rules      ${ruleFile} (${ruleSet.rules.length} rule(s), ${ruleSet.mode ?? 'all-match'} mode)`);
  ui.info(`corpus     ${corpus.origin}`);
  ui.info(`subjects   ${subjects.length}${corpus.skipped.length === 0 ? '' : `, ${corpus.skipped.length} not offered`}`);
  ui.info('');

  if (subjects.length === 0) {
    throw new CliError('the corpus held no subjects to evaluate.', {
      exitCode: ExitCode.Usage,
      detail: ['', ...corpus.skipped.slice(0, 20).map((entry) => `  ${entry.path}: ${entry.reason}`)],
      payload: { error: 'empty_corpus', skipped: corpus.skipped },
    });
  }

  const report = dryRunIngestion(ruleSet, subjects);
  const summary = summariseIngestion(report);

  if (flags.markdown !== undefined) {
    const out = resolve(flags.markdown);
    writeFileSync(out, `${renderIngestionReport(report, summary)}\n`, 'utf8');
    ui.info(`report     ${out}`);
  }

  if (ui.json) {
    ui.outJson({
      command: 'rules.test',
      ruleSet: report.ruleSet,
      kind: report.kind,
      mode: report.mode,
      corpus: corpus.origin,
      subjectCount: report.subjectCount,
      skipped: corpus.skipped,
      exitCode: exitCodeFor(report),
      rules: report.rules,
      unmatchedSubjectIds: report.unmatchedSubjectIds,
      erroredSubjectIds: report.erroredSubjectIds,
      warnings: report.warnings,
      summary: {
        itemTypes: Object.fromEntries(summary.itemTypes),
        collections: Object.fromEntries(summary.collections),
        tags: Object.fromEntries(summary.tags),
        correspondents: Object.fromEntries(summary.correspondents),
        customFields: Object.fromEntries(summary.customFields),
        reviewReasons: Object.fromEntries(summary.reviewReasons),
        conflictCount: summary.conflictCount,
        stoppedCount: summary.stoppedCount,
      },
      entries: report.entries.map((entry) => ({
        subjectId: entry.subjectId,
        matched: entry.trace?.matchedRuleIds ?? [],
        itemType: entry.outcome.itemType?.value ?? null,
        correspondent: entry.outcome.correspondent?.value ?? null,
        tags: entry.outcome.tags.map((tag) => tag.value),
        collections: entry.outcome.collections.map((collection) => collection.value),
        customFields: entry.outcome.customFields.map((field) => ({ field: field.field, value: field.value })),
        review: entry.outcome.review.map((review) => ({
          reasonCode: review.reasonCode,
          explanation: review.explanation,
          severity: review.severity,
        })),
        stopped: entry.outcome.stopped,
        conflicts: entry.outcome.conflicts,
        ...(flags.trace === true && entry.trace !== undefined ? { trace: renderTrace(entry.trace) } : {}),
      })),
    });
    process.exitCode = exitCodeFor(report);
    return;
  }

  printSummary(ui, report, summary, subjects, {
    full: flags.full === true,
    trace: flags.trace === true || ui.verbose,
    skipped: corpus.skipped,
  });
  process.exitCode = exitCodeFor(report);
};

const printSummary = (
  ui: Ui,
  report: DryRunReport<IngestionOutcome>,
  summary: ReturnType<typeof summariseIngestion>,
  subjects: readonly IngestionSubject[],
  context: { full: boolean; trace: boolean; skipped: readonly { path: string; reason: string }[] },
): void => {
  const { bold, dim, green, red, yellow } = ui.colour;

  ui.out('');
  ui.out(bold(`Rule set ${report.ruleSet} — dry run over ${String(report.subjectCount)} subject(s)`));
  ui.out('');
  for (const line of perSubjectTable(report, subjects, context.full)) ui.out(`  ${line}`);

  ui.out('');
  for (const line of renderTable(
    [
      { header: '#', align: 'right' },
      { header: 'Rule' },
      { header: 'Priority', align: 'right' },
      { header: 'Matched', align: 'right' },
      { header: 'Not matched', align: 'right' },
      { header: 'Not reached', align: 'right' },
      { header: 'Disabled', align: 'right' },
      { header: 'Errors', align: 'right' },
    ],
    report.rules.map((rule) => [
      String(rule.order),
      rule.ruleId,
      String(rule.priority),
      count(rule.matched),
      count(rule.notMatched),
      count(rule.notReached),
      count(rule.disabled),
      count(rule.errors),
    ]),
  )) {
    ui.out(`  ${line}`);
  }

  const idle = report.rules.filter((rule) => rule.matched === 0 && rule.disabled === 0);
  if (idle.length > 0) {
    ui.out('');
    ui.out(
      `  ${yellow('idle')} — ${String(idle.length)} rule(s) matched nothing: ${idle.map((rule) => rule.ruleId).join(', ')}`,
    );
  }

  for (const [title, counts] of [
    ['item types', summary.itemTypes],
    ['collections', summary.collections],
    ['tags', summary.tags],
    ['correspondents', summary.correspondents],
    ['custom fields', summary.customFields],
    ['routed to review', summary.reviewReasons],
  ] as const) {
    if (counts.size === 0) continue;
    ui.out('');
    ui.out(`  ${title}:`);
    for (const [value, total] of [...counts.entries()].sort((left, right) => right[1] - left[1])) {
      ui.out(`    ${value}  ${count(total)}`);
    }
  }

  if (context.skipped.length > 0) {
    ui.out('');
    ui.out(`  ${dim('not offered')}:`);
    for (const entry of context.skipped.slice(0, context.full ? Infinity : 10)) {
      ui.out(`    ${entry.path}: ${entry.reason}`);
    }
  }

  if (report.warnings.length > 0) {
    ui.out('');
    ui.out(`  ${yellow('warnings')}:`);
    for (const warning of report.warnings.slice(0, context.full ? Infinity : 20)) ui.out(`    ${warning}`);
  }

  if (context.trace) {
    ui.out('');
    ui.out(bold('  Traces'));
    for (const entry of report.entries) {
      if (entry.trace === undefined) continue;
      ui.out('');
      for (const line of renderTrace(entry.trace).split('\n')) ui.out(`  ${line}`);
    }
  }

  ui.out('');
  if (report.erroredSubjectIds.length > 0) {
    ui.out(
      `  ${red('FAIL')} — ${String(report.erroredSubjectIds.length)} subject(s) had a rule that could not be evaluated.`,
    );
  } else if (report.unmatchedSubjectIds.length > 0) {
    ui.out(
      `  ${yellow('NOTE')} — ${String(report.unmatchedSubjectIds.length)} of ${String(report.subjectCount)} ` +
        'subject(s) matched no rule and would still have to be filed by hand.',
    );
  } else {
    ui.out(`  ${green('OK')} — every subject matched at least one rule.`);
  }
  ui.out('');
  ui.out(
    dim('  Nothing was written: the evaluator is a pure function and has no handle with which it could write.'),
  );
  ui.out('');
};

export const registerRules = (
  parent: Command,
  describe: (name: string) => string,
  ui: () => Ui,
): Command => {
  const command = parent
    .command('rules')
    .description(describe('rules'))
    .addHelpText(
      'after',
      [
        '',
        'A rule set is a YAML or JSON document with a `version` and a `kind` (`ingestion` for',
        'CONCEPT.md §5.3 stage 8, `dedup` for §5.6), validated against the schema `@recueil/rules`',
        'publishes and the web UI edits.',
        '',
        'The evaluator here is the same one `recueil ingest --rules` puts at stage 8, so what a dry',
        'run predicts is what an ingest does.',
      ].join('\n'),
    );

  command
    .command('test')
    .description('Run a rule set over a corpus and report what it would do')
    .argument('<file>', 'the rule set to evaluate')
    .requiredOption('--against <corpus>', 'a directory of documents, or a JSON/YAML file of subjects')
    .option('--trace', 'print the full condition-by-condition trace for every subject', false)
    .option('--markdown <file>', 'also write the report as Markdown')
    .option('--limit <n>', 'evaluate at most this many subjects', parsePositiveInteger)
    .option('--no-recursive', 'do not descend into subdirectories of a directory corpus')
    .option('--full', 'list every row rather than the first few', false)
    .addHelpText(
      'after',
      [
        '',
        'A directory corpus gives each file the media type sniffed from its bytes and, for a PDF or',
        'a text file, the text a `text` condition will actually see. No OCR engine runs, so a scan',
        'with no text layer arrives with no text and a text rule will not match it — which is the',
        'true answer for a dry run, and better than pretending a recogniser had been there.',
        '',
        'Exit codes',
        '  0  every subject matched at least one rule',
        '  1  the rule set is not valid, or the corpus could not be read',
        '  4  some subjects matched no rule and would still be filed by hand',
        '  5  a rule could not be evaluated over some subject',
        '',
        'Examples:',
        '  recueil rules test office.yaml --against ~/Consume',
        '  recueil rules test office.yaml --against fixtures/rules/cases.json --trace',
      ].join('\n'),
    )
    .action(async (file: string, flags: RulesTestFlags) => {
      await runRulesTest(file, flags, ui());
    });

  command
    .command('validate')
    .description('Check that a rule set parses and satisfies the schema')
    .argument('<file>', 'the rule set to check')
    .action((file: string) => {
      const path = resolve(file);
      // `loadRuleSetFile` throws a CliError naming every fault; reaching the next line means valid.
      const ruleSet = loadRuleSetFile(path);
      const current = ui();
      if (current.json) {
        current.outJson({
          command: 'rules.validate',
          file: path,
          kind: ruleSet.kind,
          name: ruleSet.name ?? null,
          rules: ruleSet.rules.length,
          valid: true,
        });
        return;
      }
      current.out(
        `${path}: valid ${ruleSet.kind} rule set${ruleSet.name === undefined ? '' : ` '${ruleSet.name}'`}, ` +
          `${String(ruleSet.rules.length)} rule(s).`,
      );
    });

  command.action(() => {
    command.help({ error: true });
  });

  return command;
};
