/**
 * Edit-and-accept: correcting the proposal before it runs.
 *
 * `spec/data-model.md` §6.1 says `proposed_payload` is "exactly the request body that accept will
 * execute", and RQ1 says accepting runs it through the normal path. The server takes corrections as
 * `ReviewEdits` — a patch, where `fields` and `customFields` are merged over the proposal's own
 * maps and a `null` removes a key, and everything else replaces wholesale. This form is that patch,
 * and it is shaped by the asymmetry rather than hiding it: the field rows start from the proposal's
 * values and only the ones the reviewer touched are sent, while tags and the item type are sent
 * whole because that is what the server does with them.
 *
 * A field is edited as text and sent as text. The proposal's field values are scalars whose types
 * the server knows from the field path; a form that guessed a number back out of "1042" would be
 * guessing, and `office.asn` is the one place where guessing wrong is a constraint violation rather
 * than a typo. Numbers are recognised only where the proposal already held one.
 */
import { useMemo, useState } from 'react';

import type { ProposedItemPayload, ReviewEdits } from '../api/ingestion.js';

export interface EditsEditorProps {
  /** The entry's `proposedPayload`, if it is a `create_item` proposal. */
  proposal: ProposedItemPayload;
  busy?: boolean;
  onCancel: () => void;
  /** Called with the patch and the note. The patch carries only what changed. */
  onAccept: (edits: ReviewEdits | undefined, note: string | undefined) => void;
}

type Scalar = string | number | boolean | null;

export const EditsEditor = ({ proposal, busy = false, onCancel, onAccept }: EditsEditorProps): JSX.Element => {
  const original = useMemo(() => proposal.fields ?? {}, [proposal]);
  const [itemType, setItemType] = useState(proposal.itemType ?? '');
  const [tags, setTags] = useState((proposal.tags ?? []).join(', '));
  const [fields, setFields] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(original).map(([path, value]) => [path, toText(value)])),
  );
  const [note, setNote] = useState('');

  const submit = (): void => {
    const edits = buildEdits({ original, fields, itemType, tags, proposal });
    onAccept(edits, note.trim() === '' ? undefined : note.trim());
  };

  const paths = Object.keys(fields).sort();

  return (
    <form
      className="edits-editor"
      data-testid="edits-editor"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="section__note">
        Only what you change is sent. Emptying a field removes it from the proposal; leaving it as it
        is sends nothing for it.
      </p>

      <div className="field">
        <label className="field__label" htmlFor="edits-item-type">
          Item type
        </label>
        <div className="field__control">
          <input
            id="edits-item-type"
            className="field__input"
            type="text"
            value={itemType}
            onChange={(event) => setItemType(event.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="edits-tags">
          Tags
        </label>
        <div className="field__control">
          <input
            id="edits-tags"
            className="field__input"
            type="text"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
          />
        </div>
        <p className="field__hint">Comma separated. Replaces the proposal’s list wholesale.</p>
      </div>

      {paths.length === 0 ? (
        <p className="section__note">The proposal names no fields.</p>
      ) : (
        <fieldset className="field-group">
          <legend>Fields</legend>
          {paths.map((path) => (
            <div className="field" key={path} data-field={path}>
              <label className="field__label" htmlFor={`edits-${path}`}>
                <code>{path}</code>
              </label>
              <div className="field__control">
                <input
                  id={`edits-${path}`}
                  className="field__input"
                  type="text"
                  value={fields[path] ?? ''}
                  onChange={(event) =>
                    setFields((current) => ({ ...current, [path]: event.target.value }))
                  }
                />
              </div>
            </div>
          ))}
        </fieldset>
      )}

      <div className="field">
        <label className="field__label" htmlFor="edits-note">
          Why (stored on the resolution)
        </label>
        <div className="field__control">
          <input
            id="edits-note"
            className="field__input"
            type="text"
            value={note}
            placeholder="the correspondent was misread"
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </div>

      <div className="edits-editor__actions">
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Accepting…' : 'Accept with these edits'}
        </button>
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
};

/** A proposal value as an input shows it. `null` and absent are both empty. */
export const toText = (value: Scalar | undefined): string => {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
};

export interface BuildEditsInput {
  original: Readonly<Record<string, Scalar>>;
  fields: Readonly<Record<string, string>>;
  itemType: string;
  tags: string;
  proposal: ProposedItemPayload;
}

/**
 * The patch, carrying only what changed.
 *
 * Returns `undefined` when nothing did, so an "edit and accept" that edited nothing is sent as a
 * plain accept — and the server records the provenance as `review:accepted` rather than
 * `review:accepted-with-edits`, which is the truthful one.
 */
export const buildEdits = ({ original, fields, itemType, tags, proposal }: BuildEditsInput): ReviewEdits | undefined => {
  const edits: ReviewEdits = {};

  const changedFields: Record<string, Scalar> = {};
  for (const [path, text] of Object.entries(fields)) {
    const before = original[path];
    if (text === toText(before)) continue;
    changedFields[path] = text.trim() === '' ? null : coerceLike(before, text);
  }
  if (Object.keys(changedFields).length > 0) edits.fields = changedFields;

  const trimmedType = itemType.trim();
  if (trimmedType !== '' && trimmedType !== (proposal.itemType ?? '')) edits.itemType = trimmedType;

  const nextTags = tags
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
  const beforeTags = proposal.tags ?? [];
  if (nextTags.length !== beforeTags.length || nextTags.some((tag, index) => tag !== beforeTags[index])) {
    edits.tags = nextTags;
  }

  return Object.keys(edits).length === 0 ? undefined : edits;
};

/**
 * Keep the type the proposal had.
 *
 * A field the extractor produced as a number stays a number when it is corrected — `office.asn` is
 * an integer with a uniqueness constraint on it — and a field that was text stays text, so a
 * reference number that happens to be all digits is not silently turned into one.
 */
const coerceLike = (before: Scalar | undefined, text: string): Scalar => {
  if (typeof before === 'number') {
    const parsed = Number(text.trim());
    return Number.isFinite(parsed) ? parsed : text.trim();
  }
  if (typeof before === 'boolean') {
    const lowered = text.trim().toLowerCase();
    if (lowered === 'true' || lowered === 'false') return lowered === 'true';
  }
  return text.trim();
};
