/**
 * The custom-fields section.
 *
 * One mechanism carries Paperless-ngx custom fields, user-defined library fields and — from Phase
 * 7 — systematic-review extraction variables (`spec/data-model.md` §4.6). Only `library`-scoped
 * fields appear here: a `review` field belongs on an extraction form, and showing them together
 * would make the item pane a different thing for every review the item is in.
 *
 * The value is a discriminated union on the field's data type, so rendering switches on the
 * definition's `dataType` rather than sniffing the value.
 */
import type { CustomField, FieldValue, FieldValueContent } from '@recueil/schemas';

import { useCustomFields, useFieldValues } from '../../api/queries.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import type { ItemPaneSectionProps } from '../registry.js';

export const CustomFieldsSection = ({ item }: ItemPaneSectionProps): JSX.Element => {
  const definitions = useCustomFields();
  const values = useFieldValues(item.id);

  if (definitions.isPending || values.isPending) return <LoadingState label="Loading custom fields…" />;
  if (definitions.isError) {
    return (
      <ErrorState
        label="Could not load the field definitions"
        error={definitions.error}
        onRetry={() => void definitions.refetch()}
      />
    );
  }
  if (values.isError) {
    return (
      <ErrorState label="Could not load the field values" error={values.error} onRetry={() => void values.refetch()} />
    );
  }

  const libraryFields = definitions.data.data.filter((field) => field.scope === 'library');
  if (libraryFields.length === 0) {
    return (
      <EmptyState
        title="No custom fields"
        description="This library defines none. Custom fields carry the office metadata Paperless-ngx kept, and the extraction variables a systematic review needs."
      />
    );
  }

  // Library values only: a value tied to a review is extraction data, not a property of the item.
  const byField = new Map<string, FieldValue[]>();
  for (const value of values.data.data) {
    if (value.reviewId !== null && value.reviewId !== undefined) continue;
    const bucket = byField.get(value.fieldId) ?? [];
    bucket.push(value);
    byField.set(value.fieldId, bucket);
  }

  return (
    <dl className="custom-fields">
      {libraryFields.map((field) => (
        <div key={field.id} className="custom-fields__row" data-testid={`custom-field-${field.fieldKey}`}>
          <dt>
            {field.name}
            <span className="badge badge--quiet">{field.dataType}</span>
          </dt>
          <dd>{renderValues(field, byField.get(field.id) ?? [])}</dd>
        </div>
      ))}
    </dl>
  );
};

const renderValues = (field: CustomField, values: FieldValue[]): JSX.Element => {
  if (values.length === 0) return <span className="custom-fields__empty">Not recorded</span>;
  return (
    <ul className="custom-fields__values">
      {[...values]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((value) => (
          <li key={value.id}>
            {value.isBlank ? (
              <span className="custom-fields__blank" title="Recorded as not reported, which is not the same as not yet extracted">
                Not reported
              </span>
            ) : (
              formatContent(value.content ?? null)
            )}
            {field.isRepeatable && value.groupKey !== null && value.groupKey !== undefined ? (
              <span className="badge badge--quiet">{value.groupKey}</span>
            ) : null}
          </li>
        ))}
    </ul>
  );
};

/** One typed value as text. The discriminant is the field's data type, so there is no guessing. */
export const formatContent = (content: FieldValueContent | null): string => {
  if (content === null) return '—';
  switch (content.type) {
    case 'multi_choice':
      return content.value.join(', ');
    case 'boolean':
      return content.value ? 'Yes' : 'No';
    case 'json':
      return JSON.stringify(content.value);
    case 'monetary':
      return content.currency === undefined
        ? String(content.value)
        : `${content.value} ${content.currency}`;
    default:
      return String(content.value);
  }
};
