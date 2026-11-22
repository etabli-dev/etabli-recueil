/**
 * Data extraction and risk-of-bias assessment for systematic reviews (CONCEPT §5.10 items 7–8,
 * `spec/data-model.md` §8.6–8.7, `spec/systematic-review.md` §5–6).
 *
 * - A form references custom fields; it does not define them (EF1). Templates create the fields
 *   they need, with `scope = 'review'`, when they do not already exist.
 * - Values are ordinary `field_values` rows scoped to the review and the form version, so the
 *   export path is the library's own.
 * - A form locks when its first extraction is complete; a change after that is a new version, and
 *   existing values keep the version they were entered under (EF2).
 * - RoB assessments copy the instrument in, and a new assessment supersedes the current one.
 */
import { and, asc, desc, eq } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { customFields, extractionForms, fieldValues, reviewRecords, robAssessments } from '../db/schema.js';
import type { ExtractionFormRow, ReviewRecordRow, RobAssessmentRow } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../ids.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import type { AuditService } from './audit.js';
import type { CustomFieldService, DecodedFieldValue, DefineCustomFieldInput } from './custom-fields.js';
import type { ReviewService } from './review.js';
import { ROB_INSTRUMENTS, proposeOverall } from './rob-instruments.js';
import type { RobInstrument } from './rob-instruments.js';

export interface FormField {
  fieldKey: string;
  label?: string;
  help?: string;
  required?: boolean;
  /** A repeatable group key (`arm`, `outcome`); values carry `group_key` `<group>:<instance>`. */
  group?: string;
}

export interface FormSection {
  title: string;
  fields: FormField[];
}

export interface RepeatableGroup {
  key: string;
  label: string;
}

export interface FormDefinition {
  name: string;
  template?: ExtractionFormRow['template'];
  sections: FormSection[];
  groups?: RepeatableGroup[];
}

type FieldSpec = Omit<DefineCustomFieldInput, 'scope'> & { group?: string; label?: string };

/** The field sets the templates create. Field keys are prefixed `sr_` so they never clash with library fields. */
const TEMPLATE_FIELDS: Record<'rct' | 'observational' | 'diagnostic', { sections: { title: string; fields: FieldSpec[] }[]; groups: RepeatableGroup[] }> = {
  rct: {
    groups: [
      { key: 'arm', label: 'Arm' },
      { key: 'outcome', label: 'Outcome' },
    ],
    sections: [
      {
        title: 'Study',
        fields: [
          { fieldKey: 'sr_country', name: 'Country', dataType: 'text' },
          { fieldKey: 'sr_setting', name: 'Setting', dataType: 'text' },
          { fieldKey: 'sr_n_randomised', name: 'Participants randomised', dataType: 'integer' },
          { fieldKey: 'sr_follow_up_weeks', name: 'Follow-up (weeks)', dataType: 'number' },
          { fieldKey: 'sr_funding', name: 'Funding source', dataType: 'text' },
        ],
      },
      {
        title: 'Arms',
        fields: [
          { fieldKey: 'sr_arm_label', name: 'Arm', dataType: 'text', group: 'arm' },
          { fieldKey: 'sr_arm_intervention', name: 'Intervention', dataType: 'long_text', group: 'arm' },
          { fieldKey: 'sr_arm_n', name: 'Participants in arm', dataType: 'integer', group: 'arm' },
        ],
      },
      {
        title: 'Outcomes',
        fields: [
          { fieldKey: 'sr_outcome_label', name: 'Outcome', dataType: 'text', group: 'outcome' },
          { fieldKey: 'sr_events_treatment', name: 'Events, treatment (ai)', dataType: 'integer', group: 'outcome' },
          { fieldKey: 'sr_n_treatment', name: 'Total, treatment (n1i)', dataType: 'integer', group: 'outcome' },
          { fieldKey: 'sr_events_control', name: 'Events, control (ci)', dataType: 'integer', group: 'outcome' },
          { fieldKey: 'sr_n_control', name: 'Total, control (n2i)', dataType: 'integer', group: 'outcome' },
          { fieldKey: 'sr_mean_treatment', name: 'Mean, treatment (m1i)', dataType: 'number', group: 'outcome' },
          { fieldKey: 'sr_sd_treatment', name: 'SD, treatment (sd1i)', dataType: 'number', group: 'outcome' },
          { fieldKey: 'sr_mean_control', name: 'Mean, control (m2i)', dataType: 'number', group: 'outcome' },
          { fieldKey: 'sr_sd_control', name: 'SD, control (sd2i)', dataType: 'number', group: 'outcome' },
        ],
      },
    ],
  },
  observational: {
    groups: [{ key: 'outcome', label: 'Outcome' }],
    sections: [
      {
        title: 'Study',
        fields: [
          { fieldKey: 'sr_design', name: 'Design', dataType: 'choice', config: { choices: ['cohort', 'case_control', 'cross_sectional', 'other'] } },
          { fieldKey: 'sr_country', name: 'Country', dataType: 'text' },
          { fieldKey: 'sr_n_total', name: 'Participants', dataType: 'integer' },
          { fieldKey: 'sr_confounders', name: 'Confounders adjusted for', dataType: 'long_text' },
        ],
      },
      {
        title: 'Outcomes',
        fields: [
          { fieldKey: 'sr_outcome_label', name: 'Outcome', dataType: 'text', group: 'outcome' },
          { fieldKey: 'sr_effect_measure', name: 'Effect measure', dataType: 'choice', group: 'outcome', config: { choices: ['OR', 'RR', 'HR', 'MD', 'SMD', 'other'] } },
          { fieldKey: 'sr_effect_estimate', name: 'Estimate (yi)', dataType: 'number', group: 'outcome' },
          { fieldKey: 'sr_ci_lower', name: '95% CI lower', dataType: 'number', group: 'outcome' },
          { fieldKey: 'sr_ci_upper', name: '95% CI upper', dataType: 'number', group: 'outcome' },
        ],
      },
    ],
  },
  diagnostic: {
    groups: [{ key: 'test', label: 'Index test' }],
    sections: [
      {
        title: 'Study',
        fields: [
          { fieldKey: 'sr_country', name: 'Country', dataType: 'text' },
          { fieldKey: 'sr_reference_standard', name: 'Reference standard', dataType: 'text' },
          { fieldKey: 'sr_n_total', name: 'Participants', dataType: 'integer' },
        ],
      },
      {
        title: 'Index tests',
        fields: [
          { fieldKey: 'sr_test_label', name: 'Index test', dataType: 'text', group: 'test' },
          { fieldKey: 'sr_tp', name: 'True positives', dataType: 'integer', group: 'test' },
          { fieldKey: 'sr_fp', name: 'False positives', dataType: 'integer', group: 'test' },
          { fieldKey: 'sr_fn', name: 'False negatives', dataType: 'integer', group: 'test' },
          { fieldKey: 'sr_tn', name: 'True negatives', dataType: 'integer', group: 'test' },
        ],
      },
    ],
  },
};

const GROUP_KEY = /^[a-z][a-z0-9_]{0,31}:[A-Za-z0-9_.-]{1,64}$/u;

export interface ExtractionRow {
  study: string;
  recordId: string;
  itemId: string;
  group: string | null;
  field: string;
  value: string | number | boolean | null;
  blank: boolean;
  formVersion: number;
}

export interface RobInput {
  tool: string;
  outcomeLabel?: string | null;
  armLabel?: string | null;
  signallingAnswers?: Record<string, { answer: string; support?: string; quote?: string; documentId?: string; pageIndex?: number }>;
  domainJudgements: Record<string, { judgement: string; rationale?: string }>;
  /** Omitted: the instrument's rule proposes one where it has a rule. */
  overallJudgement?: string | null;
  notes?: string | null;
}

export class ExtractionService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
    private readonly fields: CustomFieldService,
    private readonly reviews: ReviewService,
    private readonly userId: string,
  ) {}

  /* ---------------------------------------------------------------------------------------- */
  /* Forms                                                                                       */
  /* ---------------------------------------------------------------------------------------- */

  /** A form from a template (`rct`, `observational`, `diagnostic`); creates the fields that are missing. */
  createFromTemplate(reviewId: string, template: 'rct' | 'observational' | 'diagnostic', actor: Actor, name?: string): ExtractionFormRow {
    const spec = TEMPLATE_FIELDS[template];
    if (spec === undefined) throw new ValidationError(`Unknown template '${String(template)}'; use rct, observational or diagnostic.`);
    let position = 1000;
    for (const section of spec.sections) {
      for (const field of section.fields) {
        position += 1;
        if (this.db.select({ id: customFields.id }).from(customFields).where(eq(customFields.fieldKey, field.fieldKey)).get() !== undefined) continue;
        this.fields.define({ fieldKey: field.fieldKey, name: field.name, dataType: field.dataType, ...(field.config === undefined ? {} : { config: field.config }), scope: 'review', position }, actor);
      }
    }
    return this.createForm(
      reviewId,
      {
        name: name ?? template.toUpperCase(),
        template,
        groups: spec.groups,
        sections: spec.sections.map((section) => ({
          title: section.title,
          fields: section.fields.map((field) => ({ fieldKey: field.fieldKey, ...(field.group === undefined ? {} : { group: field.group }) })),
        })),
      },
      actor,
    );
  }

  createForm(reviewId: string, definition: FormDefinition, actor: Actor): ExtractionFormRow {
    this.reviews.get(reviewId);
    this.validateDefinition(definition);
    const latest = this.db
      .select()
      .from(extractionForms)
      .where(and(eq(extractionForms.reviewId, reviewId), eq(extractionForms.name, definition.name)))
      .orderBy(desc(extractionForms.version))
      .get();
    if (latest !== undefined) throw new ConflictError(`A form named '${definition.name}' exists; save a new version instead.`, { formId: latest.id });
    return this.insertForm(reviewId, definition, 1, actor);
  }

  /** EF2: a change to a locked form is a new version; a draft form is edited in place. */
  updateForm(formId: string, definition: Omit<FormDefinition, 'name'>, actor: Actor): ExtractionFormRow {
    const form = this.form(formId);
    const full = { ...definition, name: form.name };
    this.validateDefinition(full);
    const latest = this.db
      .select()
      .from(extractionForms)
      .where(and(eq(extractionForms.reviewId, form.reviewId), eq(extractionForms.name, form.name)))
      .orderBy(desc(extractionForms.version))
      .get()!;
    if (latest.id !== form.id) throw new ConflictError(`Version ${latest.version} is the current one; edit that.`, { formId: latest.id });
    if (form.status === 'locked') return this.insertForm(form.reviewId, full, form.version + 1, actor);
    const next = { schemaJson: JSON.stringify(full.sections), repeatableGroups: JSON.stringify(full.groups ?? []), template: full.template ?? form.template, updatedAt: nowTimestamp() };
    this.db.transaction((tx) => {
      tx.update(extractionForms).set(next).where(eq(extractionForms.id, formId)).run();
      this.audit.record({ actor, action: 'extraction_form.updated', entityType: 'extraction_form', entityId: formId }, tx);
    });
    return { ...form, ...next };
  }

  form(formId: string): ExtractionFormRow {
    const row = this.db.select().from(extractionForms).where(eq(extractionForms.id, formId)).get();
    if (row === undefined) throw new NotFoundError('extraction_form', formId);
    return row;
  }

  forms(reviewId: string): ExtractionFormRow[] {
    return this.db.select().from(extractionForms).where(eq(extractionForms.reviewId, reviewId)).orderBy(asc(extractionForms.name), asc(extractionForms.version)).all();
  }

  definition(form: ExtractionFormRow): FormDefinition {
    return { name: form.name, template: form.template, sections: JSON.parse(form.schemaJson) as FormSection[], groups: JSON.parse(form.repeatableGroups) as RepeatableGroup[] };
  }

  private insertForm(reviewId: string, definition: FormDefinition, version: number, actor: Actor): ExtractionFormRow {
    const now = nowTimestamp();
    const row: ExtractionFormRow = {
      id: newId(),
      reviewId,
      name: definition.name,
      version,
      template: definition.template ?? 'custom',
      schemaJson: JSON.stringify(definition.sections),
      repeatableGroups: JSON.stringify(definition.groups ?? []),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction((tx) => {
      tx.insert(extractionForms).values(row).run();
      this.audit.record({ actor, action: 'extraction_form.created', entityType: 'extraction_form', entityId: row.id, after: { reviewId, name: row.name, version } }, tx);
    });
    return row;
  }

  private validateDefinition(definition: FormDefinition): void {
    if (definition.name.trim() === '') throw new ValidationError('A form needs a name.');
    if (definition.sections.length === 0) throw new ValidationError('A form needs at least one section.');
    const groups = new Set((definition.groups ?? []).map((group) => group.key));
    const seen = new Set<string>();
    for (const section of definition.sections) {
      for (const field of section.fields) {
        if (seen.has(field.fieldKey)) throw new ValidationError(`Field '${field.fieldKey}' appears twice in the form.`);
        seen.add(field.fieldKey);
        // EF1: a form references fields; it does not define them.
        this.fields.getFieldByKey(field.fieldKey);
        if (field.group !== undefined && !groups.has(field.group)) throw new ValidationError(`Field '${field.fieldKey}' names group '${field.group}', which the form does not declare.`);
      }
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Values                                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  private extractable(recordId: string): ReviewRecordRow {
    const record = this.reviews.record(recordId);
    if (record.stage !== 'included') throw new ConflictError('Data are extracted from included studies only.', { recordId, stage: record.stage });
    return record;
  }

  setValue(
    recordId: string,
    formId: string,
    input: { fieldKey: string; groupKey?: string | null; content?: Parameters<CustomFieldService['setValue']>[0]['content']; isBlank?: boolean; ordinal?: number },
    actor: Actor,
  ): DecodedFieldValue {
    const record = this.extractable(recordId);
    const form = this.form(formId);
    if (form.reviewId !== record.reviewId) throw new ValidationError('The form belongs to another review.');
    const field = this.definition(form)
      .sections.flatMap((section) => section.fields)
      .find((candidate) => candidate.fieldKey === input.fieldKey);
    if (field === undefined) throw new ValidationError(`Field '${input.fieldKey}' is not on form '${form.name}' v${form.version}.`);
    const groupKey = input.groupKey ?? null;
    if (field.group !== undefined) {
      if (groupKey === null || !GROUP_KEY.test(groupKey) || !groupKey.startsWith(`${field.group}:`)) {
        throw new ValidationError(`Field '${input.fieldKey}' is repeated per ${field.group}; give a group key like '${field.group}:intervention'.`);
      }
    } else if (groupKey !== null) {
      throw new ValidationError(`Field '${input.fieldKey}' is not in a repeatable group.`);
    }
    const value = this.fields.setValue(
      {
        fieldKey: input.fieldKey,
        itemId: record.itemId,
        reviewId: record.reviewId,
        extractionFormId: formId,
        groupKey,
        ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(input.isBlank === undefined ? {} : { isBlank: input.isBlank }),
      },
      actor,
    );
    if (record.extractionStatus === 'not_started') this.reviews.setExtractionStatus(recordId, 'in_progress', actor);
    return value;
  }

  values(recordId: string): DecodedFieldValue[] {
    const record = this.reviews.record(recordId);
    return this.fields.listValues(record.itemId, { reviewId: record.reviewId });
  }

  /** Complete a record's extraction; the forms it used lock (EF2). */
  complete(recordId: string, actor: Actor): ReviewRecordRow {
    const record = this.extractable(recordId);
    const used = new Set(
      this.db
        .select({ formId: fieldValues.extractionFormId })
        .from(fieldValues)
        .where(and(eq(fieldValues.itemId, record.itemId), eq(fieldValues.reviewId, record.reviewId)))
        .all()
        .map((row) => row.formId)
        .filter((id): id is string => id !== null),
    );
    if (used.size === 0) throw new ConflictError('Nothing has been extracted for this record yet.', { recordId });
    const forms = [...used].map((id) => this.form(id));
    for (const form of forms) {
      const required = this.definition(form)
        .sections.flatMap((section) => section.fields)
        .filter((field) => field.required === true && field.group === undefined);
      for (const field of required) {
        const hit = this.db
          .select({ id: fieldValues.id })
          .from(fieldValues)
          .innerJoin(customFields, eq(customFields.id, fieldValues.fieldId))
          .where(and(eq(fieldValues.itemId, record.itemId), eq(fieldValues.extractionFormId, form.id), eq(customFields.fieldKey, field.fieldKey)))
          .get();
        if (hit === undefined) throw new ValidationError(`Required field '${field.fieldKey}' has no value; record it, or mark it blank for "not reported".`, { fieldKey: field.fieldKey });
      }
    }
    this.db.transaction((tx) => {
      for (const form of forms) if (form.status !== 'locked') tx.update(extractionForms).set({ status: 'locked', updatedAt: nowTimestamp() }).where(eq(extractionForms.id, form.id)).run();
    });
    return this.reviews.setExtractionStatus(recordId, 'complete', actor);
  }

  /**
   * The extraction data, long (one row per value) — the shape `tidyr::pivot_wider()` and the wide
   * table both start from. `study` is the first author and year with a suffix when two collide.
   */
  table(reviewId: string): ExtractionRow[] {
    this.reviews.get(reviewId);
    const rows = this.db
      .select({ value: fieldValues, field: customFields, record: reviewRecords, form: extractionForms })
      .from(fieldValues)
      .innerJoin(customFields, eq(customFields.id, fieldValues.fieldId))
      .innerJoin(reviewRecords, and(eq(reviewRecords.itemId, fieldValues.itemId), eq(reviewRecords.reviewId, reviewId)))
      .innerJoin(extractionForms, eq(extractionForms.id, fieldValues.extractionFormId))
      .where(eq(fieldValues.reviewId, reviewId))
      .orderBy(asc(reviewRecords.addedAt), asc(fieldValues.groupKey), asc(customFields.position), asc(fieldValues.ordinal))
      .all();
    const labels = this.studyLabels(reviewId);
    return rows.map(({ value, field, record, form }) => ({
      study: labels.get(record.id) ?? record.id,
      recordId: record.id,
      itemId: record.itemId,
      group: value.groupKey,
      field: field.fieldKey,
      value: scalar(value),
      blank: value.isBlank,
      formVersion: form.version,
    }));
  }

  /** `Lovelace 2020`, `Lovelace 2020b` — the study labels the exports and robvis share. */
  studyLabels(reviewId: string): Map<string, string> {
    const included = this.reviews.records(reviewId).filter((record) => record.dedupStatus !== 'duplicate');
    const labels = new Map<string, string>();
    const used = new Map<string, number>();
    for (const record of included) {
      const view = this.reviews.view(record.id);
      const author = view.authors[0]?.split(/[ ,]/u).filter((part) => part !== '').at(-1) ?? 'Anon';
      const base = record.studyGroupKey ?? `${author} ${view.year ?? 'n.d.'}`;
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      labels.set(record.id, n === 1 || record.studyGroupKey !== null ? base : `${base}${String.fromCharCode(96 + n)}`);
    }
    return labels;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Risk of bias                                                                                */
  /* ---------------------------------------------------------------------------------------- */

  instrument(tool: string): RobInstrument {
    const instrument = ROB_INSTRUMENTS[tool];
    if (instrument === undefined) throw new ValidationError(`Unknown risk-of-bias tool '${tool}'; known: ${Object.keys(ROB_INSTRUMENTS).join(', ')}.`);
    return instrument;
  }

  assess(recordId: string, input: RobInput, actor: Actor): RobAssessmentRow {
    const record = this.reviews.record(recordId);
    if (record.stage !== 'included') throw new ConflictError('Risk of bias is assessed for included studies.', { recordId, stage: record.stage });
    const instrument = this.instrument(input.tool);
    const allowed = new Set([...instrument.levels, ...instrument.otherLevels]);
    const domainKeys = new Set(instrument.domains.map((domain) => domain.key));
    for (const [key, judgement] of Object.entries(input.domainJudgements)) {
      if (!domainKeys.has(key)) throw new ValidationError(`'${key}' is not a domain of ${instrument.name}.`);
      if (!allowed.has(judgement.judgement)) throw new ValidationError(`'${judgement.judgement}' is not a judgement level of ${instrument.name}; use ${[...allowed].join(', ')}.`);
    }
    const questions = new Map(instrument.domains.flatMap((domain) => domain.questions.map((question) => [question.key, question] as const)));
    for (const [key, answer] of Object.entries(input.signallingAnswers ?? {})) {
      const question = questions.get(key);
      if (question === undefined) throw new ValidationError(`'${key}' is not a signalling question of ${instrument.name}.`);
      if (!question.answers.includes(answer.answer)) throw new ValidationError(`'${answer.answer}' is not an answer to ${key}; use ${question.answers.join(', ')}.`);
    }
    const overall = input.overallJudgement === undefined ? proposeOverall(instrument, input.domainJudgements) : input.overallJudgement;
    if (overall !== null && !allowed.has(overall)) throw new ValidationError(`'${overall}' is not a judgement level of ${instrument.name}.`);
    const assessor = actor.userId ?? this.userId;
    const outcomeKey = input.outcomeLabel ?? '';
    const now = nowTimestamp();
    const row: RobAssessmentRow = {
      id: newId(),
      reviewId: record.reviewId,
      reviewRecordId: recordId,
      tool: instrument.tool,
      toolVersion: instrument.version,
      instrument: JSON.stringify(instrument),
      signallingAnswers: JSON.stringify(input.signallingAnswers ?? {}),
      domainJudgements: JSON.stringify(input.domainJudgements),
      overallJudgement: overall,
      outcomeLabel: input.outcomeLabel ?? null,
      outcomeKey,
      armLabel: input.armLabel ?? null,
      assessorUserId: assessor,
      assessedAt: now,
      isCurrent: true,
      supersededById: null,
      notes: input.notes ?? null,
    };
    return this.db.transaction((tx) => {
      const previous = tx
        .select()
        .from(robAssessments)
        .where(and(eq(robAssessments.reviewRecordId, recordId), eq(robAssessments.tool, instrument.tool), eq(robAssessments.outcomeKey, outcomeKey), eq(robAssessments.assessorUserId, assessor), eq(robAssessments.isCurrent, true)))
        .get();
      if (previous !== undefined) tx.update(robAssessments).set({ isCurrent: false }).where(eq(robAssessments.id, previous.id)).run();
      tx.insert(robAssessments).values(row).run();
      if (previous !== undefined) tx.update(robAssessments).set({ supersededById: row.id }).where(eq(robAssessments.id, previous.id)).run();
      this.audit.record({ actor, action: 'rob.assessed', entityType: 'review_record', entityId: recordId, after: { tool: row.tool, overall, outcome: row.outcomeLabel } }, tx);
      return row;
    });
  }

  assessments(reviewId: string, options: { tool?: string; includeSuperseded?: boolean } = {}): RobAssessmentRow[] {
    return this.db
      .select()
      .from(robAssessments)
      .where(and(eq(robAssessments.reviewId, reviewId), ...(options.tool === undefined ? [] : [eq(robAssessments.tool, options.tool)]), ...(options.includeSuperseded === true ? [] : [eq(robAssessments.isCurrent, true)])))
      .orderBy(asc(robAssessments.assessedAt))
      .all();
  }
}

/** One value as a scalar for tabular export; JSON and multi-choice become JSON text. */
const scalar = (row: typeof fieldValues.$inferSelect): string | number | boolean | null => {
  if (row.isBlank) return null;
  if (row.valueNumber !== null) return row.valueNumber;
  if (row.valueInteger !== null) return row.valueInteger;
  if (row.valueBoolean !== null) return row.valueBoolean;
  if (row.valueText !== null) return row.valueText;
  if (row.valueDate !== null) return row.valueDate;
  if (row.valueItemId !== null) return row.valueItemId;
  if (row.valueJson !== null) return row.valueJson;
  return null;
};
