/**
 * The office section: the Paperless facet, editable, with provenance and locks.
 *
 * This is the pane half of M2. Once the ingestion pipeline is filing scans, the questions asked of
 * a document are "who sent it, when is it dated, what does it reference and how much is it for" —
 * and the answers arrive from a heuristic (stage 6) or from a rule (stage 8), each with a
 * provenance row and a confidence. So the section shows where every value came from, exactly as the
 * bibliographic section does, and a correction locks the field against the heuristic that got it
 * wrong (P4-1).
 *
 * The write is narrow for the same reason it is narrow there: `PATCH /items/{id}` locks every field
 * the patch mentions, so a patch carries the one field that changed. The amount is the single
 * exception, and a deliberate one — `ck_item_office_amount` makes the value and its currency one
 * fact, so they are written together and locked together.
 */
import { useState } from 'react';
import type { FieldProvenanceEntry, OfficeFacetUpdate } from '@recueil/schemas';

import { ErrorState } from '../../components/states.js';
import { useUnlockFields, useUpdateItem } from '../../api/queries.js';
import { FieldRow } from '../field-row.js';
import { AMOUNT_FIELD_PATHS, decimalToMinor, minorToDecimal, officeFieldGroups } from '../office-fields.js';
import type { OfficeFieldPath } from '../office-fields.js';
import type { ItemPaneSectionProps } from '../registry.js';

/** Which fields the office facet locks. Distinct from the bibliographic set, hence the argument. */
const OFFICE_FACET = 'office' as const;

export const OfficeSection = ({ item }: ItemPaneSectionProps): JSX.Element => {
  const facet = item.office ?? null;
  const update = useUpdateItem(item.id);
  const unlock = useUnlockFields(item.id, OFFICE_FACET);
  const [pendingField, setPendingField] = useState<string | null>(null);

  if (facet === null) {
    return <p className="section__note">This item has no office facet.</p>;
  }

  const locked = new Set<string>(facet.lockedFields ?? []);
  for (const [path, entry] of Object.entries(facet.provenance ?? {})) {
    if ((entry as FieldProvenanceEntry).locked) locked.add(path);
  }

  const commit = (patch: OfficeFacetUpdate, marker: string): void => {
    setPendingField(marker);
    update.mutate(
      { patch: { office: patch }, expectedVersion: item.version },
      { onSettled: () => setPendingField(null) },
    );
  };

  return (
    <div className="office">
      {update.isError ? (
        <ErrorState label="The change was not saved" error={update.error} onRetry={() => update.reset()} />
      ) : null}
      {unlock.isError ? <ErrorState label="The field was not unlocked" error={unlock.error} /> : null}

      {officeFieldGroups().map(({ group, fields }) => (
        <fieldset key={group} className="field-group">
          <legend>{group}</legend>
          {fields.map((descriptor) => (
            <FieldRow
              key={descriptor.path}
              descriptor={descriptor}
              value={(facet as Record<string, unknown>)[descriptor.path]}
              provenance={facet.provenance?.[descriptor.path]}
              locked={locked.has(descriptor.path)}
              saving={pendingField === descriptor.path && update.isPending}
              onCommit={(value) =>
                commit({ [descriptor.path]: value } as OfficeFacetUpdate, descriptor.path)
              }
              onUnlock={() => unlock.mutate([descriptor.path as OfficeFieldPath])}
            />
          ))}
        </fieldset>
      ))}

      <AmountField
        amountMinor={facet.amountMinor ?? null}
        amountCurrency={facet.amountCurrency ?? null}
        provenance={facet.provenance?.amountMinor}
        locked={AMOUNT_FIELD_PATHS.some((path) => locked.has(path))}
        saving={pendingField === 'amount' && update.isPending}
        onCommit={(minor, currency) =>
          commit({ amountMinor: minor, amountCurrency: currency }, 'amount')
        }
        onUnlock={() => unlock.mutate([...AMOUNT_FIELD_PATHS])}
      />
    </div>
  );
};

export interface AmountFieldProps {
  amountMinor: number | null;
  amountCurrency: string | null;
  provenance?: FieldProvenanceEntry;
  locked: boolean;
  saving: boolean;
  onCommit: (minor: number | null, currency: string | null) => void;
  onUnlock: () => void;
}

/**
 * The amount, as one fact.
 *
 * Two inputs, one commit, and the commit is refused locally when it would produce a half-set pair,
 * because `ck_item_office_amount` would refuse it on arrival and a 422 is a worse way to learn that
 * a currency is missing. Clearing both is allowed and means "no amount recorded", which is not the
 * same statement as "the amount is zero" — zero is a value, and the field takes it.
 */
export const AmountField = ({
  amountMinor,
  amountCurrency,
  provenance,
  locked,
  saving,
  onCommit,
  onUnlock,
}: AmountFieldProps): JSX.Element => {
  const currency = amountCurrency ?? '';
  const [amountDraft, setAmountDraft] = useState(
    amountMinor === null ? '' : minorToDecimal(amountMinor, currency === '' ? 'EUR' : currency),
  );
  const [currencyDraft, setCurrencyDraft] = useState(currency);
  const [error, setError] = useState<string | null>(null);

  const commit = (): void => {
    const code = currencyDraft.trim().toUpperCase();
    const parsed = decimalToMinor(amountDraft, code === '' ? 'EUR' : code);

    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    if (parsed.minor === null && code === '') {
      setError(null);
      onCommit(null, null);
      return;
    }
    if (parsed.minor === null) {
      setError('needs an amount, or clear the currency too');
      return;
    }
    if (!/^[A-Z]{3}$/u.test(code)) {
      setError('needs a three-letter currency code, such as EUR');
      return;
    }
    setError(null);
    onCommit(parsed.minor, code);
  };

  return (
    <fieldset className="field-group" data-testid="field-amount" data-locked={locked ? 'true' : 'false'}>
      <legend>Amount</legend>
      <div className="field field--amount">
        <label className="field__label" htmlFor="office-amount">
          Amount
        </label>
        <div className="field__control field__control--amount">
          <input
            id="office-amount"
            className="field__input"
            type="text"
            inputMode="decimal"
            value={amountDraft}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : 'office-amount-error'}
            onChange={(event) => setAmountDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }}
          />
          <label className="field__label field__label--inline" htmlFor="office-amount-currency">
            Currency
          </label>
          <input
            id="office-amount-currency"
            className="field__input field__input--currency"
            type="text"
            maxLength={3}
            size={4}
            value={currencyDraft}
            aria-invalid={error !== null}
            onChange={(event) => setCurrencyDraft(event.target.value.toUpperCase())}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }}
          />
          {saving ? (
            <span className="field__saving" role="status">
              Saving…
            </span>
          ) : null}
        </div>

        <div className="field__meta">
          {locked ? (
            <>
              <span className="badge badge--locked" data-testid="lock-amount">
                Locked
              </span>
              <button type="button" className="button button--small" onClick={onUnlock}>
                Unlock Amount
              </button>
            </>
          ) : null}
          {provenance === undefined ? (
            <span className="field__provenance field__provenance--none">No recorded provenance</span>
          ) : (
            <span className="field__provenance">from {provenance.source}</span>
          )}
        </div>

        <p className="field__hint">
          Stored as whole minor units plus an ISO-4217 code, never as a float. Both together or
          neither.
        </p>
        {error === null ? null : (
          <p className="field__error" id="office-amount-error" role="alert">
            Amount {error}
          </p>
        )}
      </div>
    </fieldset>
  );
};
