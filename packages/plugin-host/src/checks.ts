/**
 * The checks engine (CONCEPT §5.5, spec/hooks.md §6.2, `spec/data-model.md` §6.2).
 *
 * - Every enabled check runs over every subject of a type it declares. A check that throws is
 *   contained: the subject gets one `skipped` result carrying the message, and the run goes on.
 * - A check that finds nothing writes `pass` (CK1): absence of a row means "not checked".
 * - One current result per check per subject per scope (`ux_check_results_current`); a re-run
 *   replaces it. An acknowledged result keeps its acknowledgement while the verdict is unchanged.
 * - Bibliography audit mode runs the same checks over parsed references that are not in the
 *   library, grouped by an audit run id.
 */
import { newId, schema } from '@recueil/core';
import type { Actor, Recueil } from '@recueil/core';
import type { Check, CheckResult, CheckSubject, WorkStub } from '@recueil/plugin-sdk';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { PluginHost, RegisteredHook } from './host.js';
import { snapshotItem } from './host.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [k: string]: JsonValue };

export interface RunChecksOptions {
  /** Item ids; default every live item. */
  itemIds?: readonly string[];
  /** Restrict to these check ids. */
  checkIds?: readonly string[];
  /** Skip checks that need the network. */
  offline?: boolean;
  dryRun?: boolean;
  actor?: Actor;
  concurrency?: number;
}

export interface ChecksRun {
  auditRunId: string | null;
  results: (CheckResult & { title: string; explanation: string })[];
  subjects: number;
}

const toDbSubject = (type: CheckResult['subjectType']): (typeof schema.CHECK_SUBJECT_TYPES)[number] =>
  type === 'reference' ? 'audit_reference' : type;

export class ChecksEngine {
  constructor(
    private readonly recueil: Recueil,
    private readonly host: PluginHost,
  ) {}

  private selected(options: RunChecksOptions): RegisteredHook<Check>[] {
    return this.host
      .checks()
      .filter((hook) => options.checkIds === undefined || options.checkIds.includes(hook.impl.id))
      .filter((hook) => !(options.offline === true && hook.impl.requires?.network === true));
  }

  private async runOne(
    hook: RegisteredHook<Check>,
    subject: CheckSubject,
    subjectId: string,
    itemId: string | undefined,
    options: RunChecksOptions,
  ): Promise<CheckResult[]> {
    try {
      const results = await this.host.call<CheckResult[]>(hook as RegisteredHook<object>, 'run', [subject], {
        defaultTimeoutMs: 60_000,
        ceilingTimeoutMs: 300_000,
        dryRun: options.dryRun ?? false,
        ...(options.actor === undefined ? {} : { actor: options.actor }),
      });
      if (results.length > 0) return results;
      return [
        {
          checkId: hook.impl.id,
          subjectType: subject.type,
          subjectId,
          ...(itemId === undefined ? {} : { itemId }),
          status: 'pass',
          severity: 'info',
          message: 'nothing found',
          autoFixable: false,
        },
      ];
    } catch (error) {
      return [
        {
          checkId: hook.impl.id,
          subjectType: subject.type,
          subjectId,
          ...(itemId === undefined ? {} : { itemId }),
          status: 'skipped',
          severity: 'info',
          message: `the check could not run: ${error instanceof Error ? error.message : String(error)}`,
          autoFixable: false,
        },
      ];
    }
  }

  private async pool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
    const out: T[] = new Array(tasks.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (next < tasks.length) {
        const index = next++;
        out[index] = await tasks[index]!();
      }
    });
    await Promise.all(workers);
    return out;
  }

  async runLibrary(options: RunChecksOptions = {}): Promise<ChecksRun> {
    const checks = this.selected(options);
    const itemIds =
      options.itemIds ??
      this.recueil.db
        .select({ id: schema.items.id })
        .from(schema.items)
        .where(isNull(schema.items.trashedAt))
        .all()
        .map((row) => row.id);

    const tasks: (() => Promise<CheckResult[]>)[] = [];
    for (const itemId of itemIds) {
      const snapshot = snapshotItem(this.recueil, itemId);
      if (snapshot === null) continue;
      const subject: CheckSubject = { type: 'item', itemId, snapshot: snapshot as unknown as JsonObject };
      for (const hook of checks) {
        if (hook.impl.subjectTypes.includes('item')) tasks.push(() => this.runOne(hook, subject, itemId, itemId, options));
        if (hook.impl.subjectTypes.includes('attachment')) {
          for (const attachment of snapshot.attachments) {
            const attachmentSubject: CheckSubject = {
              type: 'attachment',
              attachmentId: attachment.id,
              itemId,
              snapshot: { ...attachment } as unknown as JsonObject,
            };
            tasks.push(() => this.runOne(hook, attachmentSubject, attachment.id, itemId, options));
          }
        }
      }
    }
    for (const hook of checks) {
      if (!hook.impl.subjectTypes.includes('library')) continue;
      const subject: CheckSubject = { type: 'library', scope: {} };
      tasks.push(() => this.runOne(hook, subject, 'library', undefined, options));
    }

    const results = (await this.pool(tasks, options.concurrency ?? 4)).flat();
    if (options.dryRun !== true) this.store(results, null);
    return { auditRunId: null, results: this.decorate(results, checks), subjects: itemIds.length };
  }

  /** Bibliography audit mode (CONCEPT §5.5): references that are not in the library. */
  async audit(references: readonly { stub: WorkStub; rawString?: string }[], options: RunChecksOptions = {}): Promise<ChecksRun> {
    const checks = this.selected(options).filter((hook) => hook.impl.subjectTypes.includes('reference'));
    const auditRunId = newId();
    const tasks: (() => Promise<CheckResult[]>)[] = [];
    references.forEach((reference, index) => {
      const localRef = `ref-${String(index + 1).padStart(4, '0')}`;
      const subject: CheckSubject = {
        type: 'reference',
        localRef,
        stub: reference.stub,
        ...(reference.rawString === undefined ? {} : { rawString: reference.rawString }),
      };
      for (const hook of checks) tasks.push(() => this.runOne(hook, subject, localRef, undefined, options));
    });
    const results = (await this.pool(tasks, options.concurrency ?? 4)).flat();
    if (options.dryRun !== true) this.store(results, auditRunId);
    return { auditRunId, results: this.decorate(results, checks), subjects: references.length };
  }

  private decorate(results: CheckResult[], checks: readonly RegisteredHook<Check>[]): ChecksRun['results'] {
    const byId = new Map(checks.map((hook) => [hook.impl.id, hook.impl]));
    return results.map((result) => ({
      ...result,
      title: byId.get(result.checkId)?.title ?? result.checkId,
      explanation: byId.get(result.checkId)?.explanation ?? '',
    }));
  }

  private store(results: readonly CheckResult[], auditRunId: string | null): void {
    const now = new Date().toISOString();
    const scope = auditRunId ?? '';
    this.recueil.connection.transaction(() => {
      for (const result of results) {
        const subjectType = toDbSubject(result.subjectType);
        const existing = this.recueil.db
          .select()
          .from(schema.checkResults)
          .where(
            and(
              eq(schema.checkResults.checkId, result.checkId),
              eq(schema.checkResults.subjectType, subjectType),
              eq(schema.checkResults.subjectId, result.subjectId),
              eq(schema.checkResults.runScopeKey, scope),
            ),
          )
          .get();
        const sameVerdict = existing !== undefined && existing.status === result.status && existing.message === result.message;
        const values = {
          checkId: result.checkId,
          checkVersion: null,
          subjectType,
          subjectId: result.subjectId,
          itemId: result.itemId ?? null,
          status: result.status,
          severity: result.severity,
          message: result.message,
          detail: JSON.stringify({ ...(result.detail ?? {}), ...(result.evidence === undefined ? {} : { evidence: result.evidence }) }),
          autoFixable: result.autoFixable,
          autoFixPayload: null,
          fixedAt: null,
          acknowledgedAt: sameVerdict ? existing.acknowledgedAt : null,
          acknowledgedByUserId: sameVerdict ? existing.acknowledgedByUserId : null,
          runId: null,
          auditRunId,
          runScopeKey: scope,
          checkedAt: now,
        };
        if (existing === undefined) this.recueil.db.insert(schema.checkResults).values({ id: newId(), ...values }).run();
        else this.recueil.db.update(schema.checkResults).set(values).where(eq(schema.checkResults.id, existing.id)).run();
      }
    })();
  }

  /** Accept a failure as expected (`acknowledged_at`). */
  acknowledge(resultIds: readonly string[], actor: Actor): number {
    if (resultIds.length === 0) return 0;
    return this.recueil.db
      .update(schema.checkResults)
      .set({ acknowledgedAt: new Date().toISOString(), acknowledgedByUserId: actor.userId ?? null })
      .where(inArray(schema.checkResults.id, [...resultIds]))
      .run().changes;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Reports                                                                                         */
/* -------------------------------------------------------------------------------------------- */

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  // A leading = + - @ would be a formula in a spreadsheet; quote everything and neutralise those.
  const safe = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/gu, '""')}"`;
};

export const checksReportCsv = (run: ChecksRun, subjectLabel: (subjectId: string) => string = (id) => id): string => {
  const header = ['check', 'status', 'severity', 'subject_type', 'subject', 'message'];
  const rows = run.results.map((result) =>
    [result.checkId, result.status, result.severity, result.subjectType, subjectLabel(result.subjectId), result.message].map(csvCell).join(','),
  );
  return `${header.map(csvCell).join(',')}\n${rows.join('\n')}\n`;
};

const escapeMd = (text: string): string => text.replace(/\|/gu, '\\|').replace(/\n/gu, ' ');

export const checksReportMarkdown = (
  run: ChecksRun,
  options: { title?: string; subjectLabel?: (subjectId: string) => string } = {},
): string => {
  const label = options.subjectLabel ?? ((id: string) => id);
  const problems = run.results.filter((result) => result.status === 'fail' || result.status === 'warn');
  const counts = (status: CheckResult['status']) => run.results.filter((result) => result.status === status).length;
  const lines = [
    `# ${options.title ?? 'Check report'}`,
    '',
    `${run.subjects} subjects · ${counts('fail')} failed · ${counts('warn')} warnings · ${counts('pass')} passed · ${counts('skipped')} skipped`,
    '',
  ];
  if (problems.length === 0) lines.push('No problems found.');
  const byCheck = new Map<string, typeof problems>();
  for (const result of problems) byCheck.set(result.checkId, [...(byCheck.get(result.checkId) ?? []), result]);
  for (const [, entries] of [...byCheck].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const first = entries[0]!;
    lines.push(`## ${first.title}`, '', first.explanation, '', '| Status | Subject | Problem |', '|---|---|---|');
    for (const entry of entries) lines.push(`| ${entry.status} | ${escapeMd(label(entry.subjectId))} | ${escapeMd(entry.message)} |`);
    lines.push('');
  }
  const skipped = run.results.filter((result) => result.status === 'skipped');
  if (skipped.length > 0) {
    lines.push('## Not checked', '', '| Check | Subject | Why |', '|---|---|---|');
    for (const entry of skipped) lines.push(`| ${entry.checkId} | ${escapeMd(label(entry.subjectId))} | ${escapeMd(entry.message)} |`);
    lines.push('');
  }
  return lines.join('\n');
};
