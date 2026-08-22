/**
 * One editable bibliographic field, with its provenance and its lock.
 *
 * P4 says every derived fact carries source, timestamp and confidence, and P4-1 says a manual edit
 * locks the field. Both of those are properties of the data, and both are useless if the interface
 * does not show them: the question the item pane exists to answer is "where did this value come
 * from, and will something overwrite it?".
 *
 * What the lock means matters, and the wording here is deliberate. A locked field is locked
 * *against resolvers* — `FieldProvenanceEntry.locked` is documented as "no resolver may overwrite
 * this field" — not against its owner. So a locked field stays editable by hand, is marked as
 * locked, and carries the button that releases it. An interface that greyed the input out would be
 * showing a rule that does not exist.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { FieldProvenanceEntry } from '@recueil/schemas';

import { toInputValue, toPatchValue } from './fields.js';
import type { BibliographicFieldDescriptor } from './fields.js';

export interface FieldRowProps {
  descriptor: BibliographicFieldDescriptor;
  value: unknown;
  provenance?: FieldProvenanceEntry;
  locked: boolean;
  /** Called with the value a patch should carry: a string, a number, or `null` for "cleared". */
  onCommit: (value: string | number | null) => void;
  onUnlock: () => void;
  saving?: boolean;
}

export const FieldRow = ({
  descriptor,
  value,
  provenance,
  locked,
  onCommit,
  onUnlock,
  saving = false,
}: FieldRowProps): JSX.Element => {
  const inputId = useId();
  const committed = toInputValue(value);
  const [draft, setDraft] = useState(committed);
  const [localError, setLocalError] = useState<string | null>(null);
  const lastCommitted = useRef(committed);

  // Adopt a value that changed underneath us — the server's response to our own write, or a
  // refetch — but never while the user is mid-edit, which would eat their keystrokes.
  useEffect(() => {
    if (committed === lastCommitted.current) return;
    lastCommitted.current = committed;
    setDraft(committed);
    setLocalError(null);
  }, [committed]);

  const commit = (): void => {
    if (draft === lastCommitted.current) return;
    const parsed = toPatchValue(descriptor.kind, draft);
    if (!parsed.ok) {
      setLocalError(parsed.message);
      return;
    }
    setLocalError(null);
    lastCommitted.current = toInputValue(parsed.value);
    onCommit(parsed.value);
  };

  const revert = (): void => {
    setDraft(lastCommitted.current);
    setLocalError(null);
  };

  const describedBy = [
    descriptor.hint === undefined ? null : `${inputId}-hint`,
    localError === null ? null : `${inputId}-error`,
    provenance === undefined ? null : `${inputId}-provenance`,
  ]
    .filter((id): id is string => id !== null)
    .join(' ');

  const common = {
    id: inputId,
    className: 'field__input',
    value: draft,
    'aria-invalid': localError !== null,
    'aria-describedby': describedBy === '' ? undefined : describedBy,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' && descriptor.kind !== 'longText') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        revert();
      }
    },
  };

  return (
    <div
      className="field"
      data-testid={`field-${descriptor.path}`}
      data-field={descriptor.path}
      data-locked={locked ? 'true' : 'false'}
    >
      <label className="field__label" htmlFor={inputId}>
        {descriptor.label}
      </label>

      <div className="field__control">
        {descriptor.kind === 'longText' ? (
          <textarea {...common} rows={4} />
        ) : (
          <input {...common} type="text" inputMode={descriptor.kind === 'number' ? 'numeric' : 'text'} />
        )}
        {saving ? (
          <span className="field__saving" role="status">
            Saving…
          </span>
        ) : null}
      </div>

      <div className="field__meta">
        {locked ? (
          <>
            <span className="badge badge--locked" data-testid={`lock-${descriptor.path}`}>
              Locked
            </span>
            <span className="field__lock-note">Resolvers will not overwrite this value.</span>
            <button type="button" className="button button--small" onClick={onUnlock}>
              Unlock {descriptor.label}
            </button>
          </>
        ) : null}
        {provenance === undefined ? (
          <span className="field__provenance field__provenance--none">No recorded provenance</span>
        ) : (
          <span className="field__provenance" id={`${inputId}-provenance`}>
            {describeProvenance(provenance)}
          </span>
        )}
      </div>

      {descriptor.hint === undefined ? null : (
        <p className="field__hint" id={`${inputId}-hint`}>
          {descriptor.hint}
        </p>
      )}
      {localError === null ? null : (
        <p className="field__error" id={`${inputId}-error`} role="alert">
          {descriptor.label} {localError}
        </p>
      )}
    </div>
  );
};

/** Source, when, and how sure — the three things P4 requires a derived fact to carry. */
export const describeProvenance = (entry: FieldProvenanceEntry): string => {
  const parts = [`from ${entry.source}`];
  if (typeof entry.confidence === 'number') {
    parts.push(`confidence ${entry.confidence.toFixed(2)}`);
  }
  parts.push(`applied ${formatInstant(entry.appliedAt)}`);
  return parts.join(' · ');
};

const formatInstant = (timestamp: string): string => {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return timestamp;
  return parsed.toISOString().slice(0, 10);
};
