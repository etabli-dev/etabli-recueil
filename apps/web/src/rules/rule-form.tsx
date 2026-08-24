/**
 * One rule, as a form.
 *
 * The condition rows are a flat list joined by `all` or `any`, which is what `form-model.ts` will
 * round-trip without loss; a rule that needs more than that never reaches this component. The
 * action rows are typed: choosing `add-to-collection` gets a path field and choosing
 * `route-to-review` gets a reason code and the sentence a reviewer will read, because a single
 * "value" box for eight different actions would be a JSON editor with extra steps.
 *
 * Saving hands back an `IngestionRule`, and the caller writes it into the YAML document. It is not
 * validated here: the editor revalidates the whole document with the engine's parser the moment the
 * text changes, and a second, weaker check in this component could only disagree with it.
 */
import { useState } from 'react';
import type { IngestionAction, IngestionRule } from '@recueil/rules';

import { CONDITION_FIELDS, MATCHER_OPERATORS, fromSimpleRule } from './form-model.js';
import type { ConditionField, MatcherOperator, SimpleCondition, SimpleRule } from './form-model.js';

export interface RuleFormProps {
  rule: SimpleRule;
  busy?: boolean;
  onCancel: () => void;
  onSave: (rule: IngestionRule) => void;
}

const ACTION_TYPES = [
  'set-item-type',
  'add-to-collection',
  'add-tags',
  'set-custom-field',
  'set-correspondent',
  'set-confidence',
  'route-to-review',
  'stop',
] as const;

type ActionType = (typeof ACTION_TYPES)[number];

/** A fresh action of each type, with the fields its schema requires already present. */
const blankAction = (type: ActionType): IngestionAction => {
  switch (type) {
    case 'set-item-type':
      return { type, itemType: 'invoice' };
    case 'add-to-collection':
      return { type, collection: 'Office' };
    case 'add-tags':
      return { type, tags: ['office'] };
    case 'set-custom-field':
      return { type, field: 'reference', value: '' };
    case 'set-correspondent':
      return { type, correspondent: '' };
    case 'set-confidence':
      return { type, confidence: 0.9 };
    case 'route-to-review':
      return { type, reasonCode: 'needs_review', explanation: 'Say here what a reviewer should check.' };
    default:
      return { type: 'stop' };
  }
};

export const RuleForm = ({ rule, busy = false, onCancel, onSave }: RuleFormProps): JSX.Element => {
  const [draft, setDraft] = useState<SimpleRule>(rule);

  const set = <Key extends keyof SimpleRule>(key: Key, value: SimpleRule[Key]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  const setCondition = (index: number, patch: Partial<SimpleCondition>): void =>
    setDraft((current) => ({
      ...current,
      conditions: current.conditions.map((condition, position) =>
        position === index ? { ...condition, ...patch } : condition,
      ),
    }));

  const setAction = (index: number, action: IngestionAction): void =>
    setDraft((current) => ({
      ...current,
      actions: current.actions.map((existing, position) => (position === index ? action : existing)),
    }));

  return (
    <form
      className="rule-form"
      data-testid="rule-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(fromSimpleRule(draft));
      }}
    >
      <div className="field">
        <label className="field__label" htmlFor="rule-id">
          Id
        </label>
        <div className="field__control">
          <input
            id="rule-id"
            className="field__input"
            type="text"
            value={draft.id}
            onChange={(event) => set('id', event.target.value)}
          />
        </div>
        <p className="field__hint">
          Stable: a tag this rule added points back at it by id, so renaming orphans that provenance.
        </p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="rule-description">
          Description
        </label>
        <div className="field__control">
          <input
            id="rule-description"
            className="field__input"
            type="text"
            value={draft.description}
            onChange={(event) => set('description', event.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="rule-priority">
          Priority
        </label>
        <div className="field__control">
          <input
            id="rule-priority"
            className="field__input"
            type="number"
            value={draft.priority}
            onChange={(event) => set('priority', Number(event.target.value))}
          />
        </div>
        <p className="field__hint">Higher runs first. Equal priorities run in written order.</p>
      </div>

      <div className="field field--check">
        <label className="field__label" htmlFor="rule-enabled">
          <input
            id="rule-enabled"
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => set('enabled', event.target.checked)}
          />{' '}
          Enabled
        </label>
        <p className="field__hint">A disabled rule is traced as skipped, not omitted.</p>
      </div>

      <fieldset className="field-group">
        <legend>When</legend>
        <div className="field field--check">
          <label className="field__label" htmlFor="rule-always">
            <input
              id="rule-always"
              type="checkbox"
              checked={draft.always}
              onChange={(event) => set('always', event.target.checked)}
            />{' '}
            Match everything
          </label>
          <p className="field__hint">The honest way to write a catch-all or a default.</p>
        </div>

        {draft.always ? null : (
          <>
            <div className="field">
              <label className="field__label" htmlFor="rule-combinator">
                Combine with
              </label>
              <div className="field__control">
                <select
                  id="rule-combinator"
                  className="select"
                  value={draft.combinator}
                  onChange={(event) => set('combinator', event.target.value as 'all' | 'any')}
                >
                  <option value="all">all — every condition must hold</option>
                  <option value="any">any — at least one must hold</option>
                </select>
              </div>
            </div>

            {draft.conditions.map((condition, index) => (
              <div className="rule-form__condition" key={`condition-${String(index)}`}>
                <label className="visually-hidden" htmlFor={`condition-field-${String(index)}`}>
                  Field
                </label>
                <select
                  id={`condition-field-${String(index)}`}
                  className="select"
                  value={condition.field}
                  onChange={(event) => setCondition(index, { field: event.target.value as ConditionField })}
                >
                  {CONDITION_FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {field}
                    </option>
                  ))}
                </select>

                <label className="visually-hidden" htmlFor={`condition-operator-${String(index)}`}>
                  Operator
                </label>
                <select
                  id={`condition-operator-${String(index)}`}
                  className="select"
                  value={condition.operator}
                  onChange={(event) => setCondition(index, { operator: event.target.value as MatcherOperator })}
                >
                  {MATCHER_OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {operator}
                    </option>
                  ))}
                </select>

                <label className="visually-hidden" htmlFor={`condition-value-${String(index)}`}>
                  Value
                </label>
                {condition.operator === 'equalsAny' ? (
                  <textarea
                    id={`condition-value-${String(index)}`}
                    className="field__input"
                    rows={3}
                    value={condition.value}
                    onChange={(event) => setCondition(index, { value: event.target.value })}
                  />
                ) : (
                  <input
                    id={`condition-value-${String(index)}`}
                    className="field__input"
                    type="text"
                    value={condition.value}
                    onChange={(event) => setCondition(index, { value: event.target.value })}
                  />
                )}

                <label className="field__label field__label--inline">
                  <input
                    type="checkbox"
                    checked={condition.caseSensitive}
                    onChange={(event) => setCondition(index, { caseSensitive: event.target.checked })}
                  />{' '}
                  case sensitive
                </label>

                <button
                  type="button"
                  className="button button--small"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      conditions: current.conditions.filter((_, position) => position !== index),
                    }))
                  }
                >
                  Remove
                </button>
              </div>
            ))}

            <button
              type="button"
              className="button button--small"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  conditions: [
                    ...current.conditions,
                    { field: 'filename', operator: 'contains', value: '', caseSensitive: false },
                  ],
                }))
              }
            >
              Add a condition
            </button>
            {draft.conditions.some((condition) => condition.operator === 'matches') ? (
              <p className="field__hint">
                A <code>matches</code> pattern runs on a linear-time engine: no backreferences, no
                lookahead, no backtracking. An unsupported construct shows up as a validation error
                above, with its position.
              </p>
            ) : null}
          </>
        )}
      </fieldset>

      <fieldset className="field-group">
        <legend>Then</legend>
        {draft.actions.map((action, index) => (
          <ActionRow
            key={`action-${String(index)}`}
            action={action}
            index={index}
            onChange={(next) => setAction(index, next)}
            onRemove={() =>
              setDraft((current) => ({
                ...current,
                actions: current.actions.filter((_, position) => position !== index),
              }))
            }
          />
        ))}
        <button
          type="button"
          className="button button--small"
          onClick={() => setDraft((current) => ({ ...current, actions: [...current.actions, blankAction('add-tags')] }))}
        >
          Add an action
        </button>
      </fieldset>

      <div className="rule-form__actions">
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save the rule'}
        </button>
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
};

interface ActionRowProps {
  action: IngestionAction;
  index: number;
  onChange: (action: IngestionAction) => void;
  onRemove: () => void;
}

const ActionRow = ({ action, index, onChange, onRemove }: ActionRowProps): JSX.Element => (
  <div className="rule-form__action" data-action={action.type}>
    <label className="visually-hidden" htmlFor={`action-type-${String(index)}`}>
      Action
    </label>
    <select
      id={`action-type-${String(index)}`}
      className="select"
      value={action.type}
      onChange={(event) => onChange(blankAction(event.target.value as ActionType))}
    >
      {ACTION_TYPES.map((type) => (
        <option key={type} value={type}>
          {type}
        </option>
      ))}
    </select>

    {action.type === 'set-item-type' ? (
      <ActionText index={index} label="Item type" value={action.itemType} onChange={(value) => onChange({ ...action, itemType: value })} />
    ) : null}
    {action.type === 'add-to-collection' ? (
      <ActionText
        index={index}
        label="Collection"
        value={action.collection}
        hint="A path with / between levels, for instance Office/Invoices/2026. ${name} interpolates a named capture."
        onChange={(value) => onChange({ ...action, collection: value })}
      />
    ) : null}
    {action.type === 'add-tags' ? (
      <ActionText
        index={index}
        label="Tags"
        value={action.tags.join(', ')}
        hint="Comma separated. Recorded with scheme automatic and this rule as their reference."
        onChange={(value) =>
          onChange({ ...action, tags: value.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '') })
        }
      />
    ) : null}
    {action.type === 'set-custom-field' ? (
      <>
        <ActionText index={index} label="Field" value={action.field} onChange={(value) => onChange({ ...action, field: value })} />
        <ActionText
          index={index + 1000}
          label="Value"
          value={typeof action.value === 'string' ? action.value : JSON.stringify(action.value)}
          onChange={(value) => onChange({ ...action, value })}
        />
      </>
    ) : null}
    {action.type === 'set-correspondent' ? (
      <ActionText index={index} label="Correspondent" value={action.correspondent} onChange={(value) => onChange({ ...action, correspondent: value })} />
    ) : null}
    {action.type === 'set-confidence' ? (
      <ActionText
        index={index}
        label="Confidence"
        value={String(action.confidence)}
        hint="0 to 1. The score the gate at stage 9 will read."
        onChange={(value) => onChange({ ...action, confidence: Number(value) })}
      />
    ) : null}
    {action.type === 'route-to-review' ? (
      <>
        <ActionText index={index} label="Reason code" value={action.reasonCode} onChange={(value) => onChange({ ...action, reasonCode: value })} />
        <ActionText
          index={index + 2000}
          label="Explanation"
          value={action.explanation}
          hint="Stored as written, so it still reads correctly years after this rule has been edited. Name the evidence."
          onChange={(value) => onChange({ ...action, explanation: value })}
        />
      </>
    ) : null}
    {action.type === 'stop' ? <span className="section__note">Rules after this one are traced as not reached.</span> : null}

    <button type="button" className="button button--small" onClick={onRemove}>
      Remove
    </button>
  </div>
);

const ActionText = ({
  index,
  label,
  value,
  hint,
  onChange,
}: {
  index: number;
  label: string;
  value: string;
  hint?: string;
  onChange: (value: string) => void;
}): JSX.Element => {
  const id = `action-field-${String(index)}-${label.toLowerCase().replace(/\s+/gu, '-')}`;
  return (
    <span className="rule-form__action-field">
      <label className="field__label field__label--inline" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="field__input" type="text" value={value} onChange={(event) => onChange(event.target.value)} />
      {hint === undefined ? null : <span className="field__hint">{hint}</span>}
    </span>
  );
};
