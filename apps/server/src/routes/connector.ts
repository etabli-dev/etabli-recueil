/**
 * `/connector/*` — the endpoints the unmodified Zotero Connector talks to (ADR-0006).
 *
 * ## What this is and what it costs
 *
 * ADR-0006: "Web capture is the single hardest part of a reference manager to rebuild, and Zotero's
 * translator collection represents years of per-site maintenance. Rebuilding it is not a viable use
 * of a solo budget." So Recueil answers the connector's protocol instead, and the extension needs
 * no modification.
 *
 * The consequence the ADR also states: **the protocol is undocumented and may change.** Everything
 * below is written against the shapes the extension sends and expects, read out of verbatim
 * excerpts of the upstream sources captured at pinned commits — `zotero/zotero-connectors` at
 * `c279ccc` and `zotero/zotero` at `f2a42be`, in `fixtures/zotero-connector/`.
 * `test/connector-upstream.test.ts` runs that captured code over these handlers' real responses,
 * so the compatibility claims here are checked against the client rather than against our reading
 * of it. What that still does not establish — that a capture completes end to end in a browser —
 * is stated in `apps/server/README.md`, "Connector compatibility". Where a shape could not be
 * confirmed even from the source, the reading is stated in the comment above the handler rather
 * than presented as fact.
 *
 * ## Where it listens
 *
 * The connector looks for a client on `http://127.0.0.1:23119`. These routes are therefore mounted
 * at `/connector/*` with **no `/api/v1` prefix and no version**, exactly as the client serves them,
 * so a deployment that wants browser capture binds the server (or a reverse proxy for these paths
 * alone) on that port. Changing the path would require modifying the extension, which is the one
 * thing the ADR is buying its way out of.
 *
 * ## Authentication
 *
 * The handshake and the save endpoints are `public`, because the extension has no way to hold a
 * bearer token and the client it is imitating has no authentication at all. That is safe only
 * because the same reasoning as Zotero's applies: this is a loopback service. A deployment that
 * exposes port 23119 beyond loopback has published a write endpoint, and
 * `apps/server/README.md` says so in as many words.
 *
 * A write through the connector is still attributed: the actor is `token` when a credential was
 * somehow supplied and `user` otherwise, and every audit row carries the request id and the route
 * (P4, AL2).
 */
import { newId, renderSortName } from '@recueil/core';
import type { Actor, CreateItemInput, Recueil } from '@recueil/core';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { publishItemCreated } from '../publish.js';
import { jsonBody, jsonResponse, operation, problems } from '../openapi-kit.js';
import {
  ConnectorCollectionResponseSchema,
  ConnectorPingResponseSchema,
  ConnectorSaveItemsResponseSchema,
} from '../schemas.js';
import { parseOrThrow } from '../validate.js';

/**
 * The connector version this implementation was written against.
 *
 * Recorded here and in the README because ADR-0006 pins versions deliberately: when the protocol
 * moves, the thing that tells a maintainer what to diff against is this string.
 */
export const MATCHED_CONNECTOR_VERSION =
  'zotero-connectors@c279ccc / zotero@f2a42be (see fixtures/zotero-connector/)';

/** What the connector advertises itself as. Echoed so the extension believes it found a client. */
export const ANNOUNCED_ZOTERO_VERSION = '7.0.0';

/**
 * The one library the connector can see.
 *
 * Recueil is single-library (CONCEPT §1.4), so there is one save target and its numeric id is 1 —
 * the same number Zotero gives the personal library. `treeViewID` is the string form the extension
 * uses to identify a target: `L<libraryID>` for a library, `C<collectionID>` for a collection.
 */
const CONNECTOR_LIBRARY_ID = 1;
const CONNECTOR_LIBRARY_NAME = 'Recueil';
const CONNECTOR_LIBRARY_TREE_VIEW_ID = `L${CONNECTOR_LIBRARY_ID}`;

/* -------------------------------------------------------------------------------------------- */
/* Request shapes                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * A Zotero item as the connector's translators produce it.
 *
 * Loose on purpose. A translator may emit any of Zotero's several hundred field names, and refusing
 * a save because one of them is unrecognised would break capture on exactly the sites whose
 * translators are most detailed. Unknown fields are carried into `extra` rather than dropped (P10).
 */
const ZoteroCreatorSchema = z.looseObject({
  creatorType: z.string().max(64).optional(),
  firstName: z.string().max(255).optional(),
  lastName: z.string().max(255).optional(),
  name: z.string().max(512).optional(),
  fieldMode: z.union([z.number(), z.string()]).optional(),
});

const ZoteroItemSchema = z.looseObject({
  itemType: z.string().max(64),
  title: z.string().optional(),
  creators: z.array(ZoteroCreatorSchema).optional(),
  tags: z.array(z.union([z.string(), z.looseObject({ tag: z.string(), type: z.union([z.number(), z.string()]).optional() })])).optional(),
  notes: z.array(z.union([z.string(), z.looseObject({ note: z.string() })])).optional(),
  attachments: z.array(z.looseObject({})).optional(),
  url: z.string().optional(),
  DOI: z.string().optional(),
  ISBN: z.string().optional(),
  ISSN: z.string().optional(),
  date: z.string().optional(),
  accessDate: z.string().optional(),
  abstractNote: z.string().optional(),
  publicationTitle: z.string().optional(),
  bookTitle: z.string().optional(),
  proceedingsTitle: z.string().optional(),
  journalAbbreviation: z.string().optional(),
  seriesTitle: z.string().optional(),
  series: z.string().optional(),
  volume: z.string().optional(),
  issue: z.string().optional(),
  pages: z.string().optional(),
  numPages: z.string().optional(),
  edition: z.string().optional(),
  publisher: z.string().optional(),
  place: z.string().optional(),
  language: z.string().optional(),
  shortTitle: z.string().optional(),
  extra: z.string().optional(),
  libraryCatalog: z.string().optional(),
  rights: z.string().optional(),
});

const SaveItemsSchema = z.looseObject({
  items: z.array(ZoteroItemSchema).min(1),
  sessionID: z.string().max(128).optional(),
  uri: z.string().max(4096).optional(),
});

const SaveSnapshotSchema = z.looseObject({
  url: z.string().max(4096),
  sessionID: z.string().max(128).optional(),
  title: z.string().max(2048).optional(),
  html: z.string().optional(),
  pdf: z.boolean().optional(),
  singleFile: z.boolean().optional(),
});

/* -------------------------------------------------------------------------------------------- */
/* Zotero's vocabulary, mapped                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * Zotero item type → Recueil item type.
 *
 * Only the types Recueil ships (`CORE_ITEM_TYPES`) are targets; anything else falls back to
 * `webpage`, which is what an unrecognised capture from a browser almost always is, and the
 * original Zotero type is preserved in `extra` so nothing is lost (P10).
 */
const ITEM_TYPES: Readonly<Record<string, string>> = {
  journalArticle: 'article',
  magazineArticle: 'article',
  newspaperArticle: 'article',
  book: 'book',
  bookSection: 'chapter',
  encyclopediaArticle: 'chapter',
  dictionaryEntry: 'chapter',
  report: 'report',
  thesis: 'thesis',
  dataset: 'dataset',
  preprint: 'preprint',
  webpage: 'webpage',
  blogPost: 'webpage',
  forumPost: 'webpage',
  conferencePaper: 'conference_paper',
  presentation: 'conference_paper',
  computerProgram: 'software',
  standard: 'standard',
  patent: 'patent',
  letter: 'letter',
  email: 'letter',
  manuscript: 'report',
  document: 'report',
  note: 'note',
  attachment: 'attachment_only',
};

/** Zotero creator type → Recueil creator role. Unmapped roles become `contributor`. */
const CREATOR_ROLES: Readonly<Record<string, string>> = {
  author: 'author',
  editor: 'editor',
  translator: 'translator',
  contributor: 'contributor',
  seriesEditor: 'series_editor',
  recipient: 'recipient',
  interviewer: 'interviewer',
  director: 'director',
  reviewedAuthor: 'reviewed_author',
  bookAuthor: 'author',
  inventor: 'author',
  programmer: 'author',
  presenter: 'author',
};

/** The container title, whichever of Zotero's several spellings the translator used. */
const containerTitle = (item: Record<string, unknown>): string | undefined => {
  for (const key of ['publicationTitle', 'bookTitle', 'proceedingsTitle', 'websiteTitle', 'blogTitle', 'encyclopediaTitle', 'dictionaryTitle']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
};

/**
 * Zotero's `date` field, reduced to what the bibliographic facet can store.
 *
 * Translators emit anything from `2019` to `March 3, 2019` to `2019-03-03`. Only the forms that are
 * unambiguously EDTF are stored as `issuedDate`; a year is always extractable and goes to
 * `issuedYear`, which is the field the graph and bibliometrix actually use.
 */
export const parseZoteroDate = (raw: string | undefined): { issuedDate?: string; issuedYear?: number } => {
  if (raw === undefined) return {};
  const text = raw.trim();
  if (text === '') return {};

  const iso = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/u.exec(text);
  if (iso !== null) {
    const year = Number.parseInt(iso[1] as string, 10);
    return { issuedDate: text, issuedYear: year };
  }

  const year = /(?:^|\D)(1\d{3}|20\d{2}|21\d{2})(?:\D|$)/u.exec(text);
  if (year === null) return {};
  const value = Number.parseInt(year[1] as string, 10);
  return { issuedDate: String(value), issuedYear: value };
};

/** A DOI, however the translator spelled it. Normalisation to B1 happens on the way in. */
const normaliseDoi = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = raw
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '')
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/u.test(trimmed) ? trimmed : undefined;
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * The `extra` block.
 *
 * Zotero's own `extra` is preserved verbatim (P10) and the facts Recueil has nowhere else to put —
 * the original item type, the library catalogue — are appended as `Key: value` lines, which is the
 * convention Zotero itself uses and Better BibTeX reads.
 */
const buildExtra = (item: Record<string, unknown>, mappedType: string): string | undefined => {
  const lines: string[] = [];
  const original = asString(item.extra);
  if (original !== undefined) lines.push(original);

  const zoteroType = asString(item.itemType);
  if (zoteroType !== undefined && ITEM_TYPES[zoteroType] !== mappedType) {
    lines.push(`Zotero item type: ${zoteroType}`);
  }
  const catalogue = asString(item.libraryCatalog);
  if (catalogue !== undefined) lines.push(`Library catalog: ${catalogue}`);

  return lines.length === 0 ? undefined : lines.join('\n');
};

/* -------------------------------------------------------------------------------------------- */
/* Saving                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** Find or create the creator behind one Zotero creator entry, so a re-save does not duplicate. */
const ensureCreator = (recueil: Recueil, entry: Record<string, unknown>, actor: Actor): string | null => {
  const literal = asString(entry.name);
  const family = asString(entry.lastName);
  const given = asString(entry.firstName);

  if (literal === undefined && family === undefined) return null;

  const parts =
    literal === undefined
      ? { familyName: family ?? null, givenName: given ?? null }
      : { literalName: literal };
  const sortName = renderSortName(parts);

  const existing = recueil.creators.findBySortName(sortName);
  if (existing.length > 0) return (existing[0] as { id: string }).id;

  return recueil.creators.create(
    {
      kind: literal === undefined ? 'person' : 'organisation',
      ...(literal === undefined
        ? { familyName: family ?? null, givenName: given ?? null }
        : { literalName: literal }),
    },
    actor,
  ).id;
};

/** One Zotero item, saved. Returns the created item id and its title. */
const saveZoteroItem = (
  recueil: Recueil,
  raw: z.infer<typeof ZoteroItemSchema>,
  actor: Actor,
  sourceUri: string | undefined,
): { id: string; title: string; itemType: string } => {
  const item = raw as Record<string, unknown>;
  const itemType = ITEM_TYPES[String(item.itemType)] ?? 'webpage';
  const title = asString(item.title) ?? asString(item.shortTitle) ?? 'Untitled';
  const { issuedDate, issuedYear } = parseZoteroDate(asString(item.date));
  const seriesTitle = asString(item.seriesTitle) ?? asString(item.series);

  const input: CreateItemInput = {
    itemType,
    title,
    sourceSystem: 'connector',
    ...(sourceUri === undefined ? {} : { sourceId: `${sourceUri}#${newId()}` }),
    bibliographic: {
      title,
      ...(asString(item.shortTitle) === undefined ? {} : { shortTitle: asString(item.shortTitle) as string }),
      ...(containerTitle(item) === undefined ? {} : { containerTitle: containerTitle(item) as string }),
      ...(asString(item.journalAbbreviation) === undefined
        ? {}
        : { containerShort: asString(item.journalAbbreviation) as string }),
      ...(seriesTitle === undefined ? {} : { collectionTitle: seriesTitle }),
      ...(asString(item.publisher) === undefined ? {} : { publisher: asString(item.publisher) as string }),
      ...(asString(item.place) === undefined ? {} : { publisherPlace: asString(item.place) as string }),
      ...(asString(item.edition) === undefined ? {} : { edition: asString(item.edition) as string }),
      ...(asString(item.volume) === undefined ? {} : { volume: asString(item.volume) as string }),
      ...(asString(item.issue) === undefined ? {} : { issue: asString(item.issue) as string }),
      ...(asString(item.pages) === undefined ? {} : { pages: asString(item.pages) as string }),
      ...(issuedDate === undefined ? {} : { issuedDate }),
      ...(issuedYear === undefined ? {} : { issuedYear }),
      ...(normaliseDoi(asString(item.DOI)) === undefined ? {} : { doi: normaliseDoi(asString(item.DOI)) as string }),
      ...(asString(item.url) === undefined ? {} : { url: asString(item.url) as string }),
      ...(asString(item.abstractNote) === undefined ? {} : { abstract: asString(item.abstractNote) as string }),
      ...(asString(item.rights) === undefined ? {} : { licence: asString(item.rights) as string }),
    },
    ...(buildExtra(item, itemType) === undefined ? {} : { extra: buildExtra(item, itemType) as string }),
    // A capture is not a hand edit, so the values are stamped as coming from the connector and are
    // left unlocked — a resolver may improve them later (P4-1).
    provenance: { source: 'connector', lock: false },
  };

  const record = recueil.library.createItem(input, actor);

  const creators = (item.creators as Record<string, unknown>[] | undefined) ?? [];
  const appearances: { creatorId: string; role: string }[] = [];
  for (const entry of creators) {
    const creatorId = ensureCreator(recueil, entry, actor);
    if (creatorId === null) continue;
    const role = CREATOR_ROLES[String(entry.creatorType ?? 'author')] ?? 'contributor';
    if (appearances.some((existing) => existing.creatorId === creatorId && existing.role === role)) continue;
    appearances.push({ creatorId, role });
  }
  if (appearances.length > 0) {
    recueil.creators.setItemCreators(
      record.item.id,
      appearances as Parameters<Recueil['creators']['setItemCreators']>[1],
      actor,
    );
  }

  for (const tag of (item.tags as (string | { tag?: string })[] | undefined) ?? []) {
    const name = typeof tag === 'string' ? tag : asString(tag.tag);
    if (name === undefined) continue;
    // `import` and not `connector`: `item_tags.source` is a closed vocabulary in the schema
    // (`TAG_ASSIGNMENT_SOURCES`) and does not carry `connector`, though the wire contract's
    // `AssignmentSource` does. Widening the database enum is a migration and another package's
    // file; `import` is the closest true value and the audit row names the connector route.
    recueil.tags.assignByName(record.item.id, name, actor, { source: 'import' });
  }

  for (const note of (item.notes as (string | { note?: string })[] | undefined) ?? []) {
    const html = typeof note === 'string' ? note : asString(note.note);
    if (html === undefined) continue;
    recueil.notes.create({ itemId: record.item.id, contentHtml: html }, actor);
  }

  return { id: record.item.id, title, itemType };
};

/* -------------------------------------------------------------------------------------------- */
/* Routes                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export const connectorRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil, events } = app.recueil;

  /**
   * `/connector/ping` — the handshake.
   *
   * The extension polls this to find a running client and reads `prefs` from the answer to decide
   * what to offer: whether to take a snapshot automatically, whether the note button works, and so
   * on. Every preference below is answered with what this server can actually do today — false for
   * the Google Docs integration, which needs the word-processor protocol Recueil does not implement
   * (CONCEPT.md §2, non-goals), and false for `supportsAttachmentUpload`, which is the newer
   * upload-by-session path rather than the `saveSnapshot` one implemented here.
   *
   * A `GET` is answered as well as a `POST`: a person who opens the URL in a browser to check that
   * the endpoint is alive should get an answer rather than a 404.
   */
  const ping = {
    prefs: {
      automaticSnapshots: true,
      downloadAssociatedFiles: true,
      reportActiveURL: true,
      googleDocsAddNoteEnabled: false,
      googleDocsCitationExplorerEnabled: false,
      canUserAddNote: false,
      supportsAttachmentUpload: false,
      supportsTagsAutocomplete: true,
    },
  };

  app.get('/connector/ping', { config: { public: true } }, async (_request, reply) =>
    reply.type('application/json; charset=utf-8').send(ConnectorPingResponseSchema.parse(ping)),
  );

  app.post('/connector/ping', { config: { public: true } }, async (_request, reply) =>
    reply.type('application/json; charset=utf-8').send(ConnectorPingResponseSchema.parse(ping)),
  );

  /**
   * `/connector/getSelectedCollection` — where a save will land.
   *
   * Zotero answers with the collection currently selected in its own window. Recueil has no window,
   * so it answers with the library root: `id: null` and the library name, which is what the client
   * itself sends when nothing but the library is selected. The extension renders "Saving to My
   * Library".
   *
   * **`targets` is not optional.** The extension's progress window does
   * `response.targets.filter(…)` with no guard —
   * `src/common/inject/progressWindow_inject.js` line 153 at `c279ccc`, captured verbatim in
   * `fixtures/zotero-connector/` — so a response without it throws a `TypeError` on every capture.
   * An earlier comment here claimed the field was optional; it was wrong, and the fixture is the
   * reason this one is not a claim.
   *
   * Exactly one target is offered, the library root, because exactly one place exists for a save to
   * land: `saveItems` files into the library and not into a collection. Offering the collection
   * tree would be offering choices this implementation ignores, which is the one thing worse than a
   * short list. `id` is Zotero's `treeViewID` form — `L<libraryID>` for a library, `C<id>` for a
   * collection — because that is what the extension compares against `recentSaveTargets`.
   *
   * `tags` is sent because `ping` advertises `supportsTagsAutocomplete`. It is keyed by the same
   * `treeViewID` and holds `{ tag }` objects, which is the shape the connector unwraps. Empty for
   * now: autocompleting against the whole tag table is a query this endpoint should not run
   * synchronously on every capture, and an empty list degrades to "no suggestions" rather than to
   * a crash.
   */
  app.post('/connector/getSelectedCollection', { config: { public: true } }, async (_request, reply) =>
    reply.type('application/json; charset=utf-8').send(
      ConnectorCollectionResponseSchema.parse({
        libraryID: CONNECTOR_LIBRARY_ID,
        libraryName: CONNECTOR_LIBRARY_NAME,
        libraryEditable: true,
        editable: true,
        filesEditable: true,
        id: null,
        name: CONNECTOR_LIBRARY_NAME,
        targets: [
          {
            id: CONNECTOR_LIBRARY_TREE_VIEW_ID,
            name: CONNECTOR_LIBRARY_NAME,
            filesEditable: true,
            level: 0,
          },
        ],
        tags: { [CONNECTOR_LIBRARY_TREE_VIEW_ID]: [] },
      }),
    ),
  );

  /**
   * `/connector/saveItems` — the capture itself.
   *
   * The body carries `items` (the translator's output), `uri` (the page) and `sessionID`. The
   * client answers 201 with `{ items: [...] }`, and that is what is answered here. `sessionID` is
   * accepted and ignored: it exists so that a later `updateSession` can revise a save, and Recueil
   * does not answer that endpoint.
   *
   * Every item is saved with `connector` provenance and left unlocked, so a later resolver run may
   * improve a field the translator guessed at (P4-1). Attachments named in the payload are *not*
   * fetched: the connector sends the snapshot separately, and a server that went and downloaded a
   * publisher URL on its own behalf would be doing something the user did not ask for.
   */
  app.post('/connector/saveItems', { config: { public: true } }, async (request, reply) => {
    const body = parseOrThrow(SaveItemsSchema, request.body, 'body');

    const saved = body.items.map((item) => saveZoteroItem(recueil, item, request.actor, body.uri));

    for (const entry of saved) {
      publishItemCreated(
        events,
        recueil,
        recueil.library.getItem(entry.id),
        request.actor,
        'connector',
      );
    }

    return reply
      .code(201)
      .type('application/json; charset=utf-8')
      .send(
        ConnectorSaveItemsResponseSchema.parse({
          items: saved.map((entry) => ({
            id: entry.id,
            key: entry.id,
            title: entry.title,
            itemType: entry.itemType,
          })),
        }),
      );
  });

  /**
   * `/connector/saveSnapshot` — a page saved with no translator behind it.
   *
   * The body carries `url`, an optional `title`, and — depending on the connector's mode — the page
   * HTML, a flag saying a PDF will follow, or a flag saying the SingleFile snapshot will be posted
   * separately to `/connector/saveSingleFile`.
   *
   * What is implemented: the *item* is created, a `webpage` with the URL and title, so the capture
   * is in the library and findable. What is **not** implemented: storing the snapshot bytes as a
   * Document. The SingleFile upload path (`/connector/saveSingleFile`) is a separate endpoint this
   * phase does not answer, so a snapshot arrives without its file and the item says so in its
   * `extra` rather than pretending the page was archived. This is a known gap, recorded in
   * `apps/server/README.md`.
   */
  app.post('/connector/saveSnapshot', { config: { public: true } }, async (request, reply) => {
    const body = parseOrThrow(SaveSnapshotSchema, request.body, 'body');
    const title = body.title ?? body.url;

    const record = recueil.library.createItem(
      {
        itemType: 'webpage',
        title,
        sourceSystem: 'connector',
        sourceId: `${body.url}#${newId()}`,
        bibliographic: { title, url: body.url, accessedAt: new Date().toISOString() },
        extra: 'Snapshot: the page bytes were not stored (Recueil does not answer /connector/saveSingleFile yet).',
        provenance: { source: 'connector', lock: false },
      },
      request.actor,
    );

    publishItemCreated(events, recueil, recueil.library.getItem(record.item.id), request.actor, 'connector');

    return reply
      .code(201)
      .type('application/json; charset=utf-8')
      .send({ id: record.item.id, key: record.item.publicId, title });
  });

};

/* -------------------------------------------------------------------------------------------- */
/* The contract                                                                                    */
/* -------------------------------------------------------------------------------------------- */

const CONNECTOR_TAGS = ['Platform'] as const;

const connectorNote =
  '\n\nPart of the Zotero Connector protocol (ADR-0006). Unversioned and unauthenticated, because ' +
  `it imitates a loopback client the extension already knows how to talk to. Matched against ` +
  `${MATCHED_CONNECTOR_VERSION}; the protocol is undocumented and may change.`;

export const connectorPaths: ZodOpenApiPathsObject = {
  '/connector/ping': {
    get: operation({
      operationId: 'connectorPingGet',
      summary: 'Connector handshake',
      description: 'Answers the extension\'s probe for a running client.' + connectorNote,
      tags: CONNECTOR_TAGS,
      security: [],
      responses: { '200': jsonResponse('The client preferences.', ConnectorPingResponseSchema) },
    }),
    post: operation({
      operationId: 'connectorPing',
      summary: 'Connector handshake',
      description:
        'The form the extension actually uses. `prefs` tells it what this client supports; every ' +
        'flag is answered with what this server can do today rather than with what would make the ' +
        'extension offer the most buttons.' + connectorNote,
      tags: CONNECTOR_TAGS,
      security: [],
      responses: { '200': jsonResponse('The client preferences.', ConnectorPingResponseSchema) },
    }),
  },
  '/connector/getSelectedCollection': {
    post: operation({
      operationId: 'connectorGetSelectedCollection',
      summary: 'Where a save will land',
      description:
        'Recueil has no window and therefore no selected collection, so this answers with the ' +
        'library root — `id: null` — which is what the Zotero client itself sends when nothing but ' +
        'the library is selected. The optional `targets` picker list is not sent.' + connectorNote,
      tags: CONNECTOR_TAGS,
      security: [],
      responses: { '200': jsonResponse('The save target.', ConnectorCollectionResponseSchema) },
    }),
  },
  '/connector/saveItems': {
    post: operation({
      operationId: 'connectorSaveItems',
      summary: 'Save translated items',
      description:
        "The translator's output, saved. Zotero item types and creator types are mapped onto " +
        "Recueil's; anything unmapped becomes a `webpage` and the original type is preserved in " +
        '`extra` (P10). Values are stamped `connector` and left unlocked, so a later resolver may ' +
        'improve a field the translator guessed at (P4-1).' + connectorNote,
      tags: CONNECTOR_TAGS,
      security: [],
      requestBody: jsonBody(
        z.looseObject({
          items: z.array(z.looseObject({ itemType: z.string() })),
          sessionID: z.string().optional(),
          uri: z.string().optional(),
        }).meta({ id: 'ConnectorSaveItemsRequest', unusedIO: 'input' }),
      ),
      responses: {
        '201': jsonResponse('The saved items.', ConnectorSaveItemsResponseSchema),
        ...problems('422'),
      },
    }),
  },
  '/connector/saveSnapshot': {
    post: operation({
      operationId: 'connectorSaveSnapshot',
      summary: 'Save a page with no translator',
      description:
        'Creates the `webpage` item so the capture is in the library. **The page bytes are not ' +
        'stored**: the connector posts the SingleFile snapshot to `/connector/saveSingleFile`, ' +
        'which this phase does not answer, and the item records that rather than implying the page ' +
        'was archived.' + connectorNote,
      tags: CONNECTOR_TAGS,
      security: [],
      requestBody: jsonBody(
        z.looseObject({ url: z.string(), title: z.string().optional(), sessionID: z.string().optional() }).meta({
          id: 'ConnectorSaveSnapshotRequest',
          unusedIO: 'input',
        }),
      ),
      responses: {
        '201': jsonResponse('The created item.', z.looseObject({ id: z.string(), key: z.string(), title: z.string() })),
        ...problems('422'),
      },
    }),
  },
};
