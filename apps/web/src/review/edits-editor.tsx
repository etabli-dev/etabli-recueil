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
 * **The office facet is always offered, whether or not the proposal names it.** This is the point
 * of the screen rather than a convenience. An entry reaches the queue *because* the pipeline was not
 * confident, and the commonest form of that is a proposal with `fields: {}` — nothing was read off
 * the page at all. An editor that could only correct fields the extractor had already filled in
 * would, in precisely that case, offer the reviewer nothing to correct: they could accept a
 * document with no correspondent and no date, or reject it, and there would be no third option.
 * So the eight facet columns of CONCEPT.md §5.2 and `spec/data-model.md` §3.7 are rendered as
 * empty rows, and typing in one adds it to the patch.
 *
 * A field is edited as text and sent in the type the field holds. Where the proposal already has a
 * value, that value's type is kept — a number stays a number. Where it does not, the type comes
 * from the field's own descriptor, which matters for exactly one field: `office.asn` is an integer
 * with a uniqueness constraint, and sending "1042" as a string for a column the extractor never
 * filled in is a validation failure rather than a typo.
 *
 * The amount is one control, not two, for the reason it is one control in the item pane:
 * `ck_item_office_amount` requires the minor units and the currency together or neither, so two
 * free-text rows would let a reviewer compose a patch the server must refuse.
 */
import { useMemo, useState } from 'react';

import { AMOUNT_FIELD_PATHS, decimalToMinor, minorToDecimal, officeFieldGroups } from '../item-pane/office-fields.js';
import { OFFICE_FIELDS } from '../item-pane/office-fields.js';
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

/** Facet columns are addressed in a proposal's `fields` map by their dotted path. */
const OFFICE_PREFIX = 'office.';
const officePathOf = (column: string): string => `${OFFICE_PREFIX}${column}`;

const AMOUNT_MINOR_PATH = officePathOf(AMOUNT_FIELD_PATHS[0]);
const AMOUNT_CURRENCY_PATH = officePathOf(AMOUNT_FIELD_PATHS[1]);

/**
 * The type each offered office column holds, for a field the proposal left empty.
 *
 * Only consulted when there is no previous value to infer from; see `coerceLike`.
 */
const OFFICE_KINDS: ReadonlyMap<string, string> = new Map([
  ...OFFICE_FIELDS.map((descriptor): [string, string] => [officePathOf(descriptor.path), descriptor.kind]),
  // The amount is not one of the descriptors — it has its own control — but its minor units are an
  // integer column all the same, and nothing else here would say so.
  [AMOUNT_MINOR_PATH, 'number'],
]);

/** Every office path this form offers, including the two the amount control owns. */
const OFFICE_PATHS: readonly string[] = [
  ...OFFICE_FIELDS.map((descriptor) => officePathOf(descriptor.path)),
  AMOUNT_MINOR_PATH,
  AMOUNT_CURRENCY_PATH,
];

const asScalar = (value: unknown): Scalar | undefined =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined;

export const EditsEditor = ({ proposal, busy = false, onCancel, onAccept }: EditsEditorProps): JSX.Element => {
  const original = useMemo(() => proposal.fields ?? {}, [proposal]);

  const [itemType, setItemType] = useState(proposal.itemType ?? '');
  const [tags, setTags] = useState((proposal.tags ?? []).join(', '));
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const seeded: Record<string, string> = Object.fromEntries(
      Object.entries(original).map(([path, value]) => [path, toText(value)]),
    );
    // The office rows exist whether or not the proposal filled them in. Seeded as empty strings,
    // which `buildEdits` reads as "unchanged from absent" and therefore does not send.
    for (const path of OFFICE_PATHS) seeded[path] ??= '';
    return seeded;
  });

  const originalCurrency = toText(asScalar(original[AMOUNT_CURRENCY_PATH]));
  const originalMinor = asScalar(original[AMOUNT_MINOR_PATH]);
  const [currency, setCurrency] = useState(originalCurrency);
  const [amount, setAmount] = useState(() =>
    typeof originalMinor === 'number' && originalCurrency !== ''
      ? minorToDecimal(originalMinor, originalCurrency)
      : '',
  );
  const [amountError, setAmountError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const submit = (): void => {
    const money = resolveAmount({ amount, currency, originalMinor, originalCurrency });
    if (!money.ok) {
      setAmountError(money.message);
      return;
    }
    setAmountError(null);

    const edits = buildEdits({ original, fields: { ...fields, ...money.patch }, itemType, tags, proposal });
    onAccept(edits, note.trim() === '' ? undefined : note.trim());
  };

  // The proposal's own fields, minus the office columns, which have their own section below.
  const otherPaths = Object.keys(fields)
    .filter((path) => !OFFICE_PATHS.includes(path))
    .sort();

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

      {officeFieldGroups().map(({ group, fields: descriptors }) => (
        <fieldset className="field-group" key={group} data-office-group={group}>
          <legend>{group}</legend>
          {descriptors.map((descriptor) => {
            const path = officePathOf(descriptor.path);
            return (
              <div className="field" key={path} data-field={path}>
                <label className="field__label" htmlFor={`edits-${path}`}>
                  {descriptor.label}
                </label>
                <div className="field__control">
                  <input
                    id={`edits-${path}`}
                    className="field__input"
                    type="text"
                    inputMode={descriptor.kind === 'number' ? 'numeric' : undefined}
                    value={fields[path] ?? ''}
                    onChange={(event) =>
                      setFields((current) => ({ ...current, [path]: event.target.value }))
                    }
                  />
                </div>
                {descriptor.hint === undefined ? null : <p className="field__hint">{descriptor.hint}</p>}
              </div>
            );
          })}
        </fieldset>
      ))}

      <fieldset className="field-group" data-office-group="Amount">
        <legend>Amount</legend>
        <div className="field" data-field={AMOUNT_MINOR_PATH}>
          <label className="field__label" htmlFor={`edits-${AMOUNT_MINOR_PATH}`}>
            Amount
          </label>
          <div className="field__control">
            <input
              id={`edits-${AMOUNT_MINOR_PATH}`}
              className="field__input"
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
        </div>
        <div className="field" data-field={AMOUNT_CURRENCY_PATH}>
          <label className="field__label" htmlFor={`edits-${AMOUNT_CURRENCY_PATH}`}>
            Currency
          </label>
          <div className="field__control">
            <input
              id={`edits-${AMOUNT_CURRENCY_PATH}`}
              className="field__input"
              type="text"
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            />
          </div>
        </div>
        <p className="field__hint">
          An ISO-4217 code, and the amount as printed. The two are one fact: the server stores both
          or neither.
        </p>
        {amountError === null ? null : (
          <p className="field__error" role="alert" data-testid="edits-amount-error">
            {amountError}
          </p>
        )}
      </fieldset>

      {otherPaths.length === 0 ? null : (
        <fieldset className="field-group">
          <legend>Other fields</legend>
          {otherPaths.map((path) => (
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

export interface ResolveAmountInput {
  amount: string;
  currency: string;
  originalMinor: Scalar | undefined;
  originalCurrency: string;
}

export type ResolveAmountResult =
  | { ok: true; patch: Record<string, string> }
  | { ok: false; message: string };

/**
 * The amount as two field entries, or a refusal.
 *
 * Returns the pair as *text*, to be merged into the same map every other field goes through, so
 * that the "only what changed is sent" rule applies to money exactly as it applies to everything
 * else. Both paths are written, or neither: a patch that set the minor units and left the currency
 * alone would violate `ck_item_office_amount` on a facet that had no currency to begin with.
 */
export const resolveAmount = ({
  amount,
  currency,
  originalMinor,
  originalCurrency,
}: ResolveAmountInput): ResolveAmountResult => {
  const typed = amount.trim();
  const code = currency.trim();

  if (typed === '' && code === '') {
    // Cleared, or never set. Either way both paths go back to whatever "empty" means for them,
    // and `buildEdits` decides whether that is a change worth sending.
    return { ok: true, patch: { [AMOUNT_MINOR_PATH]: '', [AMOUNT_CURRENCY_PATH]: '' } };
  }
  if (code === '') return { ok: false, message: 'needs a currency, for instance EUR' };
  if (!/^[A-Z]{3}$/u.test(code)) return { ok: false, message: 'must be a three-letter ISO-4217 code' };
  if (typed === '') return { ok: false, message: 'needs an amount, or clear the currency too' };

  const parsed = decimalToMinor(typed, code);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  if (parsed.minor === null) {
    return { ok: true, patch: { [AMOUNT_MINOR_PATH]: '', [AMOUNT_CURRENCY_PATH]: '' } };
  }

  // Unchanged is expressed as the text the proposal itself would have produced, so the comparison
  // in `buildEdits` sees no difference and sends nothing.
  const unchanged =
    typeof originalMinor === 'number' && originalMinor === parsed.minor && originalCurrency === code;
  if (unchanged) return { ok: true, patch: {} };

  return { ok: true, patch: { [AMOUNT_MINOR_PATH]: String(parsed.minor), [AMOUNT_CURRENCY_PATH]: code } };
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
    changedFields[path] = text.trim() === '' ? null : coerceLike(before, text, path);
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
 * Keep the type the field holds.
 *
 * A field the extractor produced as a number stays a number when it is corrected — `office.asn` is
 * an integer with a uniqueness constraint on it — and a field that was text stays text, so a
 * reference number that happens to be all digits is not silently turned into one.
 *
 * When the proposal held no value there is nothing to infer from, and the field's own descriptor
 * answers instead. Without that fallback the commonest case on this screen — a proposal with no
 * fields at all — would send every office column as a string, including the one column that must
 * not be one.
 */
const coerceLike = (before: Scalar | undefined, text: string, path?: string): Scalar => {
  const numeric =
    typeof before === 'number' ||
    (before === undefined && path !== undefined && OFFICE_KINDS.get(path) === 'number');

  if (numeric) {
    const parsed = Number(text.trim());
    return Number.isFinite(parsed) ? parsed : text.trim();
  }
  if (typeof before === 'boolean') {
    const lowered = text.trim().toLowerCase();
    if (lowered === 'true' || lowered === 'false') return lowered === 'true';
  }
  return text.trim();
};
