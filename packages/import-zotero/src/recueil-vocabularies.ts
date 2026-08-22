/**
 * The Recueil closed vocabularies this importer writes into, named once.
 *
 * `@recueil/core` exports the vocabularies as `as const` arrays on its `schema` namespace and the
 * services take the string unions directly, but it does not export a name for every one of those
 * unions. Deriving them here — from the same arrays the database `CHECK` constraints are built
 * from — keeps the mapping tables in `src/map/` typed against the constraint rather than against a
 * string literal that happens to be right today.
 */
import { schema } from '@recueil/core';

export type AnnotationTypeName = (typeof schema.ANNOTATION_TYPES)[number];
export type MotivationName = (typeof schema.ANNOTATION_MOTIVATIONS)[number];
export type AttachmentRoleName = (typeof schema.ATTACHMENT_ROLES)[number];
export type AttachmentLinkModeName = (typeof schema.ATTACHMENT_LINK_MODES)[number];
export type TagSchemeName = (typeof schema.TAG_SCHEMES)[number];
