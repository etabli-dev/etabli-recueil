/**
 * Paperless document types onto Recueil (CONCEPT §5.2, `spec/data-model.md` §3.7).
 *
 * CONCEPT §6 says "document types → item type or a custom field, whichever the data supports", and
 * the answer here is **both, deliberately, and not the same thing twice**:
 *
 * - `items.item_type` gets a Recueil type when the Paperless name is recognisably one of the core
 *   office types — `invoice`, `letter`, `contract`, `receipt`, `certificate`, `photo` — and
 *   `document` otherwise. The item type is what a list view groups by and what a rule matches on,
 *   so it wants the small, shared vocabulary rather than every name in every install.
 * - `item_office.office_document_type` gets the **slug of the Paperless name, always**. §3.7 makes
 *   that column an open vocabulary precisely so that "the Paperless importer carries user-defined
 *   types across", and it is the column that keeps `Kfz-Versicherung` distinguishable from
 *   `Hausratversicherung` when both are items of type `contract`.
 * - a custom field, `paperless_document_type`, gets the **name verbatim**, because slugging is
 *   lossy and a migration should be reversible (P10).
 *
 * The recognition table is bilingual. The user this importer was written for runs Paperless in
 * German, and a table that only knew English would file every one of their invoices as `document`
 * — technically lossless, since the slug and the custom field both survive, and useless in
 * practice. Recognition is by exact slug match on the whole name, never by substring: a document
 * type called `Rechnungsprüfung` ("invoice audit") is not an invoice, and a table that matched
 * prefixes would say it was.
 */
import { isCoreItemType } from '@recueil/schemas';

import { slugify } from './slug.js';

/** The item type an office document with no recognised type gets. Open vocabulary (§3.4, O3). */
export const DEFAULT_OFFICE_ITEM_TYPE = 'document';

/**
 * Paperless document-type name, slugged → Recueil item type.
 *
 * Only names whose meaning is unambiguous appear here. Anything not listed keeps
 * `DEFAULT_OFFICE_ITEM_TYPE` and loses nothing, because the slug still reaches
 * `office_document_type`.
 */
export const ITEM_TYPE_BY_DOCUMENT_TYPE: Readonly<Record<string, string>> = {
  /* English */
  invoice: 'invoice',
  invoices: 'invoice',
  bill: 'invoice',
  letter: 'letter',
  letters: 'letter',
  correspondence: 'letter',
  contract: 'contract',
  contracts: 'contract',
  agreement: 'contract',
  receipt: 'receipt',
  receipts: 'receipt',
  certificate: 'certificate',
  certificates: 'certificate',
  photo: 'photo',
  photograph: 'photo',
  photos: 'photo',

  /* German */
  rechnung: 'invoice',
  rechnungen: 'invoice',
  brief: 'letter',
  briefe: 'letter',
  schreiben: 'letter',
  anschreiben: 'letter',
  vertrag: 'contract',
  vertraege: 'contract',
  quittung: 'receipt',
  quittungen: 'receipt',
  beleg: 'receipt',
  belege: 'receipt',
  kassenbon: 'receipt',
  bescheinigung: 'certificate',
  bescheinigungen: 'certificate',
  zeugnis: 'certificate',
  urkunde: 'certificate',
  zertifikat: 'certificate',
  foto: 'photo',
  fotos: 'photo',
};

export type DocumentTypeMappingKind =
  /** The name was recognised and became a core Recueil item type. */
  | 'core'
  /** The name was not recognised; the item is a `document` and the slug carries the meaning. */
  | 'carried'
  /** The document has no Paperless document type at all. */
  | 'absent';

export interface DocumentTypeMapping {
  /** The Paperless id, or null when the document has no type. */
  paperlessId: number | null;
  /** The name exactly as Paperless holds it, or null. */
  name: string | null;
  /** `items.item_type`. */
  itemType: string;
  /** `item_office.office_document_type`. Null only when there is no Paperless type. */
  officeDocumentType: string | null;
  kind: DocumentTypeMappingKind;
}

/** Decide the two columns for one Paperless document type. */
export const mapDocumentType = (
  type: { id: number; name: string } | null | undefined,
): DocumentTypeMapping => {
  if (type === null || type === undefined) {
    return {
      paperlessId: null,
      name: null,
      itemType: DEFAULT_OFFICE_ITEM_TYPE,
      officeDocumentType: null,
      kind: 'absent',
    };
  }

  const slug = slugify(type.name);
  const recognised = ITEM_TYPE_BY_DOCUMENT_TYPE[slug];

  // A table entry that is not a core type would be a typo in the table above, not a data
  // condition — so it is treated as unrecognised rather than trusted into `item_type`.
  const itemType =
    recognised !== undefined && isCoreItemType(recognised) ? recognised : DEFAULT_OFFICE_ITEM_TYPE;

  return {
    paperlessId: type.id,
    name: type.name,
    itemType,
    officeDocumentType: slug,
    kind: itemType === DEFAULT_OFFICE_ITEM_TYPE ? 'carried' : 'core',
  };
};
