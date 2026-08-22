/**
 * Zotero item types onto Recueil item types (CONCEPT §5.2, `spec/data-model.md` §3.4).
 *
 * Recueil's vocabulary is **open**, which decides the shape of this table. Where Recueil ships a
 * type that means the same thing, the Zotero type maps onto it: `journalArticle` → `article`,
 * `bookSection` → `chapter`. Where it does not, the Zotero type is carried across as a slug of its
 * own — `blog_post`, `audio_recording` — rather than being flattened into the nearest core type.
 * Flattening would be a silent, unrecoverable loss in a migration whose whole point is that nothing
 * is lost, and the open vocabulary exists precisely so that it does not have to happen.
 *
 * Both halves are reported: `MAPPING_KIND` says, per Zotero type, whether the result is a core
 * Recueil type or a carried-across slug, and the verification report prints the second list.
 *
 * The CSL type is recorded alongside, on `item_bibliographic.csl_type`, so a citation processor
 * still sees `article-journal` for a `preprint` carried across as `preprint`. It is read from the
 * library's own global schema when the database carries one; `CSL_TYPE_BY_ZOTERO_TYPE` below is the
 * fallback, taken from Zotero schema version 45.
 */
import { isCoreItemType } from '@recueil/schemas';

/** Zotero item type → Recueil item type. Every Zotero 7/8 type is listed; unknown ones are derived. */
export const ITEM_TYPE_MAP: Readonly<Record<string, string>> = {
  /* Core Recueil types. */
  journalArticle: 'article',
  magazineArticle: 'article',
  newspaperArticle: 'article',
  book: 'book',
  bookSection: 'chapter',
  encyclopediaArticle: 'chapter',
  dictionaryEntry: 'chapter',
  thesis: 'thesis',
  report: 'report',
  preprint: 'preprint',
  dataset: 'dataset',
  webpage: 'webpage',
  conferencePaper: 'conference_paper',
  computerProgram: 'software',
  standard: 'standard',
  patent: 'patent',
  letter: 'letter',
  artwork: 'photo',
  attachment: 'attachment_only',
  note: 'note',

  /* Types Recueil does not ship, carried across under their own name. */
  blogPost: 'blog_post',
  forumPost: 'forum_post',
  instantMessage: 'instant_message',
  email: 'email',
  manuscript: 'manuscript',
  interview: 'interview',
  film: 'film',
  videoRecording: 'video_recording',
  tvBroadcast: 'tv_broadcast',
  radioBroadcast: 'radio_broadcast',
  podcast: 'podcast',
  audioRecording: 'audio_recording',
  presentation: 'presentation',
  map: 'map',
  bill: 'bill',
  case: 'legal_case',
  hearing: 'hearing',
  statute: 'statute',
  document: 'document',
};

/** Zotero item type → CSL type, from Zotero schema 45. Used when the database carries no schema. */
export const CSL_TYPE_BY_ZOTERO_TYPE: Readonly<Record<string, string>> = {
  preprint: 'article',
  journalArticle: 'article-journal',
  magazineArticle: 'article-magazine',
  newspaperArticle: 'article-newspaper',
  bill: 'bill',
  book: 'book',
  podcast: 'broadcast',
  tvBroadcast: 'broadcast',
  radioBroadcast: 'broadcast',
  bookSection: 'chapter',
  dataset: 'dataset',
  document: 'document',
  attachment: 'document',
  note: 'document',
  dictionaryEntry: 'entry-dictionary',
  encyclopediaArticle: 'entry-encyclopedia',
  artwork: 'graphic',
  hearing: 'hearing',
  interview: 'interview',
  case: 'legal_case',
  statute: 'legislation',
  manuscript: 'manuscript',
  map: 'map',
  film: 'motion_picture',
  videoRecording: 'motion_picture',
  conferencePaper: 'paper-conference',
  patent: 'patent',
  letter: 'personal_communication',
  email: 'personal_communication',
  instantMessage: 'personal_communication',
  forumPost: 'post',
  blogPost: 'post-weblog',
  report: 'report',
  computerProgram: 'software',
  audioRecording: 'song',
  presentation: 'speech',
  standard: 'standard',
  thesis: 'thesis',
  webpage: 'webpage',
};

export type ItemTypeMappingKind = 'core' | 'carried' | 'derived';

export interface ItemTypeMapping {
  zoteroType: string;
  itemType: string;
  cslType: string | null;
  kind: ItemTypeMappingKind;
}

/**
 * Map one Zotero item type.
 *
 * A type not in the table — a user's custom item type, or one from a Zotero newer than this code —
 * is `derived`: slugified and carried across, because refusing it would lose the item and guessing
 * a core type for it would lose the truth.
 */
export const mapZoteroItemType = (
  zoteroType: string,
  cslTypes: Readonly<Record<string, string>> = {},
): ItemTypeMapping => {
  const mapped = ITEM_TYPE_MAP[zoteroType];
  const cslType = cslTypes[zoteroType] ?? CSL_TYPE_BY_ZOTERO_TYPE[zoteroType] ?? null;

  if (mapped === undefined) {
    return { zoteroType, itemType: slugify(zoteroType), cslType, kind: 'derived' };
  }
  return { zoteroType, itemType: mapped, cslType, kind: isCoreItemType(mapped) ? 'core' : 'carried' };
};

/**
 * `bookSection` → `book_section`, `TVBroadcast` → `tv_broadcast`.
 *
 * The result always matches `SLUG_PATTERN`: a leading digit or symbol gets an `x` in front, because
 * `LibraryService.createItem` refuses anything else and losing an item to a naming rule would be
 * absurd.
 */
export const slugify = (value: string): string => {
  const snake = value
    .replace(/([a-z])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  if (snake === '') return 'unknown';
  return /^[a-z]/u.test(snake) ? snake : `x_${snake}`;
};
