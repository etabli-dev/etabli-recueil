/**
 * The rules editor: the same rules, as a form and as text.
 *
 * §5.3 stage 8 is what these drive and §5.6 asks for them "editable as YAML/JSON in the UI" with a
 * dry run before execution. The server stores one row per rule, so the two views are two shapes of
 * one table: the form edits a row, and the YAML view edits the whole set as a
 * `@recueil/rules` document which is diffed back into creates, updates and deletes
 * (`rule-set-text.ts`). Saving from the text view says what it will do before it does it, because
 * "remove the four rules you deleted" is not something to discover afterwards.
 *
 * Validation is the engine's. `validateRuleText` calls `parseRuleSet` from `@recueil/rules` — the
 * same function the server's `RuleCreate` schema is built from — so the editor's verdict is the
 * executor's verdict, down to the regular expressions, which are compiled by the linear-time engine
 * here as they will be there.
 *
 * The form is deliberately not complete. It edits the shape a real ingestion rule is written in — a
 * flat conjunction of leaf conditions and a list of actions — and shows anything more structured
 * read-only with a note pointing at the text view. `form-model.ts` says why: a form that opened a
 * nested condition, rendered the half it understood and saved that over the whole rule would be
 * worse than no form.
 */
import { useEffect, useMemo, useState } from 'react';
import type { IngestionRule, IngestionRuleSet } from '@recueil/rules';

import {
  useCreateRule,
  useDeleteRule,
  useDryRunRules,
  useRules,
  useUpdateRule,
} from '../api/queries.js';
import type { Rule } from '../api/ingestion.js';
import { Pane } from '../components/panel.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { DryRunPanel } from './dry-run-panel.js';
import { RuleForm } from './rule-form.js';
import { describeAction, describeCondition, fromSimpleRule, toSimpleRule } from './form-model.js';
import { describeDiff, diffRuleSet, isEmptyDiff, rulesToText, toCreate } from './rule-set-text.js';
import { RULE_SET_SCHEMA_ID, STARTER_RULE_SET, validateRuleText } from './validate.js';

export interface RulesEditorProps {
  /** Which rule is open in the form. Null for the list. */
  selectedRuleId: string | null;
  onSelect: (id: string | null) => void;
}

type View = 'form' | 'yaml';

export const RulesEditor = ({ selectedRuleId, onSelect }: RulesEditorProps): JSX.Element => {
  const rules = useRules('ingestion');
  const create = useCreateRule();
  const update = useUpdateRule();
  const remove = useDeleteRule();
  const dryRun = useDryRunRules();

  const [view, setView] = useState<View>('form');
  const [text, setText] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const stored = useMemo(() => rules.data?.data ?? [], [rules.data]);
  const storedText = useMemo(() => (stored.length === 0 ? STARTER_RULE_SET : rulesToText(stored)), [stored]);

  // The stored set seeds the text view when it is first opened, and again after a save. It is not
  // re-seeded on every refetch, which would overwrite whatever the author had typed since.
  useEffect(() => {
    if (view === 'yaml' && text === null) setText(storedText);
  }, [view, text, storedText]);

  const validation = useMemo(() => (text === null ? null : validateRuleText(text)), [text]);
  // `RuleSet` is a discriminated union and the ingestion branch is the only one this editor holds;
  // the narrowing is spelled out so a dedup document opened here is refused rather than mangled.
  const ingestionDraft = useMemo<IngestionRuleSet | null>(
    () => (validation !== null && validation.ok && validation.ruleSet.kind === 'ingestion' ? validation.ruleSet : null),
    [validation],
  );
  const diff = useMemo(
    () => (ingestionDraft === null ? null : diffRuleSet(stored, ingestionDraft)),
    [ingestionDraft, stored],
  );

  const saveText = async (): Promise<void> => {
    if (diff === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      for (const body of diff.create) await create.mutateAsync(body);
      for (const entry of diff.update) await update.mutateAsync({ id: entry.id, body: entry.body });
      for (const entry of diff.remove) await remove.mutateAsync(entry.id);
      setText(null);
      await rules.refetch();
    } catch (error) {
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rules">
      <Pane
        id="rules-list"
        title="Ingestion rules"
        toolbar={
          <>
            <div className="rules__views" role="tablist" aria-label="Editor view">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'form'}
                className="button button--small"
                onClick={() => setView('form')}
              >
                Form
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'yaml'}
                className="button button--small"
                onClick={() => setView('yaml')}
              >
                YAML
              </button>
            </div>
            <span className="item-list__count">{stored.length} rules</span>
          </>
        }
      >
        {rules.isPending ? (
          <LoadingState label="Loading the rules…" />
        ) : rules.isError ? (
          <ErrorState label="Could not load the rules" error={rules.error} onRetry={() => void rules.refetch()} />
        ) : view === 'yaml' ? (
          <YamlView
            text={text ?? storedText}
            validation={validation}
            diff={diff}
            saving={saving}
            saveError={saveError}
            onChange={setText}
            onRevert={() => setText(null)}
            onSave={() => void saveText()}
          />
        ) : (
          <FormView
            rules={stored}
            selectedRuleId={selectedRuleId}
            onSelect={onSelect}
            onCreate={(rule) => create.mutate(toCreate(rule))}
            onUpdate={(id, rule) => {
              const body = toCreate(rule);
              update.mutate({
                id,
                body: {
                  description: body.description ?? null,
                  enabled: body.enabled ?? true,
                  priority: body.priority ?? 0,
                  when: body.when,
                  then: body.then,
                },
              });
            }}
            onRemove={(id) => remove.mutate(id)}
            error={create.isError ? create.error : update.isError ? update.error : remove.isError ? remove.error : null}
            busy={create.isPending || update.isPending || remove.isPending}
          />
        )}
      </Pane>

      <DryRunPanel draft={view === 'yaml' ? ingestionDraft : null} dryRun={dryRun} />
    </div>
  );
};

/* -------------------------------------------------------------------------------------------- */

interface YamlViewProps {
  text: string;
  validation: ReturnType<typeof validateRuleText> | null;
  diff: ReturnType<typeof diffRuleSet> | null;
  saving: boolean;
  saveError: unknown;
  onChange: (value: string) => void;
  onRevert: () => void;
  onSave: () => void;
}

const YamlView = ({
  text,
  validation,
  diff,
  saving,
  saveError,
  onChange,
  onRevert,
  onSave,
}: YamlViewProps): JSX.Element => (
  <>
    {validation === null ? null : validation.ok ? (
      <p className="rules__valid" role="status" data-testid="rules-valid">
        <span className="badge badge--ok">valid</span> Checked against <code>{RULE_SET_SCHEMA_ID}</code>{' '}
        by the same parser the pipeline runs.
      </p>
    ) : (
      <div className="rules__invalid" role="alert" data-testid="rules-invalid">
        <p>
          <span className="badge badge--error">not valid</span> {validation.issues.length} problem
          {validation.issues.length === 1 ? '' : 's'}. Saving and the dry run are refused until they
          are fixed.
        </p>
        <ul className="state__field-errors">
          {validation.issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              <code>{issue.path === '' ? '(document)' : issue.path}</code> {issue.message}
            </li>
          ))}
        </ul>
      </div>
    )}

    {saveError === null ? null : <ErrorState label="The rules were not saved" error={saveError} />}

    <label className="visually-hidden" htmlFor="rules-yaml">
      The rule set as YAML
    </label>
    <textarea
      id="rules-yaml"
      className="field__input rules__yaml"
      data-testid="rules-yaml"
      spellCheck={false}
      rows={28}
      value={text}
      onChange={(event) => onChange(event.target.value)}
    />

    <div className="rules__save">
      <button
        type="button"
        className="button button--primary"
        disabled={diff === null || isEmptyDiff(diff) || saving}
        onClick={onSave}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className="button" onClick={onRevert} disabled={saving}>
        Revert to the stored rules
      </button>
      <span className="rules__diff" data-testid="rules-diff">
        {diff === null ? 'Fix the problems above first.' : describeDiff(diff)}
      </span>
    </div>
    <p className="field__hint">
      Saving applies the difference row by row: a rule you did not touch is not rewritten, and a rule
      you deleted from the document is deleted from the table. Rules are matched by their id, so
      renaming one is a delete and a create — which is what it is, because a tag added by the old id
      points at a rule that no longer exists.
    </p>
  </>
);

interface FormViewProps {
  rules: readonly Rule[];
  selectedRuleId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (rule: IngestionRule) => void;
  onUpdate: (id: string, rule: IngestionRule) => void;
  onRemove: (id: string) => void;
  error: unknown;
  busy: boolean;
}

const FormView = ({
  rules,
  selectedRuleId,
  onSelect,
  onCreate,
  onUpdate,
  onRemove,
  error,
  busy,
}: FormViewProps): JSX.Element => {
  const [adding, setAdding] = useState(false);

  if (rules.length === 0 && !adding) {
    return (
      <EmptyState
        title="No rules"
        description="A rule drives stage 8 of the ingestion pipeline: match on source, path, sender or text, and set the item type, the collection, the tags and the office fields."
        action={
          <button type="button" className="button button--primary" onClick={() => setAdding(true)}>
            Write the first rule
          </button>
        }
      />
    );
  }

  return (
    <div className="rules-form" data-testid="rules-form">
      {error === null ? null : <ErrorState label="The rule was not saved" error={error} />}

      <ol className="rules-form__rules">
        {rules.map((row) => {
          const parsed = asIngestionRule(row);
          const simple = parsed === null ? null : toSimpleRule(parsed);
          const open = row.id === selectedRuleId;
          return (
            <li key={row.id} className="rules-form__rule" data-rule={row.ruleId}>
              {open && simple !== null ? (
                <RuleForm
                  rule={simple}
                  busy={busy}
                  onCancel={() => onSelect(null)}
                  onSave={(edited) => {
                    onUpdate(row.id, edited);
                    onSelect(null);
                  }}
                />
              ) : (
                <>
                  <p className="rules-form__rule-head">
                    <code>{row.ruleId}</code>
                    <span className="rules-form__priority">priority {row.priority}</span>
                    {row.enabled ? null : <span className="badge badge--warn">disabled</span>}
                  </p>
                  {row.description === null ? null : (
                    <p className="rules-form__description">{row.description}</p>
                  )}
                  {parsed === null ? (
                    <p className="section__note" data-testid={`rule-unreadable-${row.ruleId}`}>
                      This row is not an ingestion rule this build can read. It is shown so it is not
                      invisible; edit it in the YAML view.
                    </p>
                  ) : (
                    <>
                      <p className="rules-form__when">
                        <strong>when</strong> {describeCondition(parsed.when)}
                      </p>
                      <ul className="rules-form__then">
                        {parsed.then.map((action, index) => (
                          <li key={`${action.type}-${String(index)}`}>{describeAction(action)}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  <div className="rules-form__rule-actions">
                    {simple === null ? (
                      <span className="section__note" data-testid={`rule-complex-${row.ruleId}`}>
                        This rule’s condition is nested, negated or uses a resolver, which the form
                        does not edit. Use the YAML view — the form will not rewrite what it cannot
                        represent.
                      </span>
                    ) : (
                      <button type="button" className="button button--small" onClick={() => onSelect(row.id)}>
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button--small button--danger"
                      onClick={() => onRemove(row.id)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ol>

      {adding ? (
        <RuleForm
          rule={{
            id: `rule-${String(rules.length + 1)}`,
            description: '',
            enabled: true,
            priority: 0,
            combinator: 'all',
            always: false,
            conditions: [{ field: 'filename', operator: 'glob', value: '*.pdf', caseSensitive: false }],
            actions: [{ type: 'set-item-type', itemType: 'invoice' }],
          }}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSave={(rule) => {
            onCreate(rule);
            setAdding(false);
          }}
        />
      ) : (
        <button type="button" className="button" onClick={() => setAdding(true)}>
          Add a rule
        </button>
      )}
    </div>
  );
};

/**
 * A stored row as the engine's rule type.
 *
 * The row's `when` and `then` are `unknown` on the wire — the server stores whichever facet's
 * vocabulary the rule was written in — so this narrows rather than casts blindly, and a row it
 * cannot read is shown as unreadable instead of rendering as an empty rule.
 */
export const asIngestionRule = (row: Rule): IngestionRule | null => {
  if (row.kind !== 'ingestion') return null;
  if (typeof row.when !== 'object' || row.when === null) return null;
  if (!Array.isArray(row.then) || row.then.length === 0) return null;
  if (!row.then.every((action) => typeof action === 'object' && action !== null && 'type' in action)) return null;
  return {
    id: row.ruleId,
    ...(row.description === null ? {} : { description: row.description }),
    enabled: row.enabled,
    priority: row.priority,
    when: row.when,
    then: row.then,
  } as IngestionRule;
};

export type { IngestionRuleSet };
export { fromSimpleRule };
