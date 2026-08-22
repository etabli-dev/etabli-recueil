/**
 * The view of a library record that a serialiser works over.
 *
 * This package is deliberately free of `@recueil/core`: a citation key and a `.bib` entry are
 * functions of the *contract* — the item type, the bibliographic facet, the creators and the
 * attachments — and nothing about them needs a database handle. Keeping the dependency at
 * `@recueil/schemas` is what lets the exporters be tested against literal fixtures and reused by
 * the CLI, the API and an importer that has not written anything yet.
 *
 * `FormatRecord` is therefore a *flattened* projection of `Item` rather than `Item` itself. The
 * bibliographic facet is reused verbatim (`Partial<BibliographicFacetCreate>`); creators,
 * attachments and keywords are reduced to the parts a bibliographic format can carry, because the
 * ordinals, provenance rows and link modes of the full entities have no expression in any of the
 * four formats and would only be dropped again on the way out. `recordFromItem` performs that
 * projection for callers that hold a real expanded `Item`.
 */
import { CORE_ITEM_TYPES, CREATOR_ROLES } from '@recueil/schemas';
import type { Attachment, BibliographicFacetCreate, Item, ItemCreator } from '@recueil/schemas';

/** A creator role, as the closed vocabulary of `spec/data-model.md` §5.2 defines it. */
export type FormatCreatorRole = (typeof CREATOR_ROLES)[number];

/** A built-in item type. Plugin-registered types are accepted too, and map to the fallback. */
export type FormatItemType = (typeof CORE_ITEM_TYPES)[number];

/** One observed spelling of a name, as `Creator.nameVariants` carries it (ADR-0016, step 3). */
export interface FormatNameVariant {
  readonly form: string;
  readonly source?: string | undefined;
}

/**
 * A creator as a format sees it: a role, and either a two-field or a single-field name.
 *
 * `namePrefix` is kept separate from `familyName` because ADR-0016 drops a particle stored in its
 * own field from the citation key while keeping one embedded in the family string, and because
 * BibTeX's own name grammar draws the same line (`von Last, Jr, First`).
 */
export interface FormatCreator {
  readonly role: FormatCreatorRole;
  readonly kind?: 'person' | 'organisation' | undefined;
  readonly familyName?: string | null | undefined;
  readonly givenName?: string | null | undefined;
  readonly namePrefix?: string | null | undefined;
  readonly nameSuffix?: string | null | undefined;
  readonly literalName?: string | null | undefined;
  readonly nameVariants?: readonly FormatNameVariant[] | undefined;
}

/** An attached file, reduced to what a `file` field or an `L1` tag can say about it. */
export interface FormatAttachment {
  /** Path or URL as it should appear in the file field. */
  readonly path?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly mimeType?: string | null | undefined;
  readonly role?: string | null | undefined;
}

/** The bibliographic facet, partial: an importer fills in whatever the source happened to carry. */
export type FormatBibliographic = Partial<BibliographicFacetCreate>;

/**
 * One record, in or out.
 *
 * `id` and `createdAt` exist for disambiguation only: ADR-0016 orders colliding keys by creation
 * timestamp and then by id, so that the suffix an item gets does not depend on the order a query
 * happened to return it in.
 */
export interface FormatRecord {
  readonly id?: string | undefined;
  readonly itemType: string;
  /** `Item.dateAdded`. The primary sort key for disambiguation (ADR-0016). */
  readonly createdAt?: string | undefined;
  /** Display title. `bibliographic.title` wins where both are present. */
  readonly title?: string | null | undefined;
  /** Zotero's free-text `Extra`, preserved verbatim (P10). */
  readonly extra?: string | null | undefined;
  readonly creators?: readonly FormatCreator[] | undefined;
  readonly attachments?: readonly FormatAttachment[] | undefined;
  /** Tags and author keywords, flattened — the vocabulary layer has no bibliographic expression. */
  readonly keywords?: readonly string[] | undefined;
  /** Note bodies, as plain text or Markdown. */
  readonly notes?: readonly string[] | undefined;
  readonly bibliographic?: FormatBibliographic | null | undefined;
}

const CREATOR_ROLE_SET: ReadonlySet<string> = new Set<string>(CREATOR_ROLES);

const isCreatorRole = (value: string): value is FormatCreatorRole => CREATOR_ROLE_SET.has(value);

/** The title a format should print: the facet's, else the item's, else the short title. */
export const recordTitle = (record: FormatRecord): string | undefined => {
  const bib = record.bibliographic;
  return trimmed(bib?.title) ?? trimmed(record.title) ?? trimmed(bib?.shortTitle);
};

/** `undefined` for anything that is not a non-empty string, so callers can `??` freely. */
export const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
};

/**
 * The creators of one role, in list order.
 *
 * Order is the array order. `Item.creators` is dense and ordinal-sorted by the server (IC1), so a
 * projection that preserves the array preserves the author list.
 */
export const creatorsWithRole = (
  record: FormatRecord,
  role: FormatCreatorRole,
): readonly FormatCreator[] => (record.creators ?? []).filter((creator) => creator.role === role);

/**
 * The family name a key or a sort order should use: the family field for a two-field name, the
 * whole string for a single-field one. The particle field is *not* included — ADR-0016 drops it.
 */
export const creatorFamily = (creator: FormatCreator): string | undefined =>
  trimmed(creator.familyName) ?? trimmed(creator.literalName);

/** True when the creator is a corporate body, which every format brace-protects or quotes. */
export const isOrganisation = (creator: FormatCreator): boolean =>
  creator.kind === 'organisation' || (trimmed(creator.familyName) === undefined && trimmed(creator.literalName) !== undefined);

/**
 * Project an expanded `Item` onto the record a serialiser reads.
 *
 * Only the expansions the caller actually requested are used; an item fetched without its creators
 * simply exports without an author list rather than throwing, because that is the honest rendering
 * of what was asked for.
 */
export const recordFromItem = (item: Item): FormatRecord => {
  const creators = (item.creators ?? [])
    .map(formatCreatorFromItemCreator)
    .filter((creator): creator is FormatCreator => creator !== undefined);

  const attachments = (item.attachments ?? [])
    .filter((attachment) => attachment.trashedAt === undefined || attachment.trashedAt === null)
    .map(formatAttachmentFromAttachment);

  const keywords = (item.tags ?? [])
    .map((tag) => trimmed(tag.name))
    .filter((name): name is string => name !== undefined);

  return {
    id: item.id,
    itemType: item.itemType,
    createdAt: item.dateAdded,
    title: item.title,
    extra: item.extra,
    creators,
    attachments,
    keywords,
    bibliographic: item.bibliographic ?? undefined,
  };
};

const formatCreatorFromItemCreator = (appearance: ItemCreator): FormatCreator | undefined => {
  const role = isCreatorRole(appearance.role) ? appearance.role : 'contributor';
  const creator = appearance.creator;
  if (creator === undefined) {
    const raw = trimmed(appearance.rawName);
    return raw === undefined ? undefined : { role, literalName: raw };
  }
  return {
    role,
    kind: creator.kind,
    familyName: creator.familyName,
    givenName: creator.givenName,
    namePrefix: creator.namePrefix,
    nameSuffix: creator.nameSuffix,
    literalName: creator.literalName,
    nameVariants: creator.nameVariants?.map((variant) => ({ form: variant.form, source: variant.source })),
  };
};

const formatAttachmentFromAttachment = (attachment: Attachment): FormatAttachment => ({
  path: attachment.linkedPath ?? attachment.url,
  title: attachment.title,
  mimeType: attachment.contentTypeHint,
  role: attachment.role,
});
