/**
 * The dry-run report as Markdown.
 *
 * The CLI prints it and the UI renders it, which is why it is Markdown rather than a table widget:
 * it has to survive being pasted into an issue. The order is deliberate — what would change first,
 * then which rules did the changing, then what did not match, then the warnings — because the
 * question a rule author has before running a set over four thousand documents is "what am I about
 * to do to them", and the question afterwards is "which rule did that".
 */
import type { DedupSummary, DryRunReport, IngestionSummary, RuleStatistics } from './dry-run.js';
import { summariseDedup, summariseIngestion } from './dry-run.js';
import type { DedupOutcome } from './dedup/outcome.js';
import type { IngestionOutcome } from './ingestion/outcome.js';

const countTable = (title: string, counts: ReadonlyMap<string, number>, limit = 25): readonly string[] => {
  if (counts.size === 0) return [];
  const rows = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const shown = rows.slice(0, limit);
  const lines = [`### ${title}`, '', '| Value | Subjects |', '|---|---:|'];
  for (const [value, count] of shown) lines.push(`| ${value.replaceAll('|', '\\|')} | ${count} |`);
  if (rows.length > shown.length) lines.push(`| … and ${rows.length - shown.length} more | |`);
  lines.push('');
  return lines;
};

const ruleTable = (rules: readonly RuleStatistics[]): readonly string[] => {
  const lines = ['### Rules, in evaluation order', '', '| # | Rule | Priority | Matched | Not matched | Not reached | Disabled | Errors |', '|---:|---|---:|---:|---:|---:|---:|---:|'];
  for (const rule of rules) {
    lines.push(
      `| ${rule.order} | ${rule.ruleId} | ${rule.priority} | ${rule.matched} | ${rule.notMatched} | ${rule.notReached} | ${rule.disabled} | ${rule.errors} |`,
    );
  }
  lines.push('');
  const idle = rules.filter((rule) => rule.matched === 0 && rule.disabled === 0);
  if (idle.length > 0) {
    lines.push(`${idle.length} rule${idle.length === 1 ? '' : 's'} matched nothing: ${idle.map((rule) => rule.ruleId).join(', ')}.`, '');
  }
  return lines;
};

const header = (report: DryRunReport<unknown>): readonly string[] => [
  `# Dry run — ${report.ruleSet}`,
  '',
  `${report.kind} rule set, ${report.mode} mode, over ${report.subjectCount} subject${report.subjectCount === 1 ? '' : 's'}.`,
  'Nothing was written: the evaluator is a pure function and has no handle with which it could write.',
  '',
];

const tail = (report: DryRunReport<unknown>, unmatchedLabel: string): readonly string[] => {
  const lines: string[] = [];
  if (report.unmatchedSubjectIds.length > 0) {
    const shown = report.unmatchedSubjectIds.slice(0, 25);
    lines.push(
      `### ${unmatchedLabel}`,
      '',
      `${report.unmatchedSubjectIds.length} of ${report.subjectCount}: ${shown.join(', ')}${report.unmatchedSubjectIds.length > shown.length ? ', …' : ''}`,
      '',
    );
  }
  if (report.erroredSubjectIds.length > 0) {
    lines.push('### Subjects a rule could not decide', '', report.erroredSubjectIds.slice(0, 25).join(', '), '');
  }
  if (report.warnings.length > 0) {
    lines.push('### Warnings', '');
    for (const warning of report.warnings.slice(0, 50)) lines.push(`- ${warning}`);
    if (report.warnings.length > 50) lines.push(`- … and ${report.warnings.length - 50} more`);
    lines.push('');
  }
  return lines;
};

/** Render an ingestion dry run. */
export const renderIngestionReport = (report: DryRunReport<IngestionOutcome>, summary: IngestionSummary = summariseIngestion(report)): string =>
  [
    ...header(report),
    ...countTable('Item types', summary.itemTypes),
    ...countTable('Collections', summary.collections),
    ...countTable('Tags', summary.tags),
    ...countTable('Correspondents', summary.correspondents),
    ...countTable('Custom fields', summary.customFields),
    ...countTable('Routed to review', summary.reviewReasons),
    ...(summary.conflictCount > 0
      ? [`${summary.conflictCount} value${summary.conflictCount === 1 ? ' was' : 's were'} overwritten by a later rule; see the traces.`, '']
      : []),
    ...ruleTable(report.rules),
    ...tail(report, 'Subjects no rule matched'),
  ].join('\n');

/** Render a dedup dry run. */
export const renderDedupReport = (report: DryRunReport<DedupOutcome>, summary: DedupSummary = summariseDedup(report)): string =>
  [
    ...header(report),
    ...countTable('Decisions', summary.decisions),
    ...countTable('Merge winners', summary.winners),
    ...countTable('Routed to review', summary.reviewReasons),
    ...(summary.undecidedCount > 0 ? [`${summary.undecidedCount} pair${summary.undecidedCount === 1 ? '' : 's'} were left undecided.`, ''] : []),
    ...ruleTable(report.rules),
    ...tail(report, 'Pairs no rule matched'),
  ].join('\n');
