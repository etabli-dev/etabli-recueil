/**
 * Saving a page to Recueil: the item from the page's metadata, then — when the page names a PDF
 * and the browser may fetch it — the PDF as a document attached to that item.
 *
 * It speaks the ordinary REST API with a scoped token (`items:write`, `documents:write`), not
 * the Zotero connector protocol: this extension is Recueil's own and
 * needs no translator layer (CONCEPT §7 Phase 8).
 */
import type { PageAuthor, PageMetadata } from './extract.js';

export interface ConnectorSettings {
  baseUrl: string;
  token: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SaveOutcome {
  itemId: string;
  /** `attached`, `none` (no PDF on the page), or why the PDF could not be kept. */
  pdf: 'attached' | 'none' | { failed: string };
}

export class SaveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const creatorOf = (author: PageAuthor) =>
  author.literal !== undefined
    ? { role: 'author', creator: { kind: 'organisation', literalName: author.literal } }
    : { role: 'author', creator: { kind: 'person', familyName: author.family ?? author.given ?? '', ...(author.given === undefined || author.given === '' || author.family === undefined ? {} : { givenName: author.given }) } };

/** The `ItemCreate` body for a page. Only what the page said; enrichment can fill in the rest. */
export const itemBody = (meta: PageMetadata): Record<string, unknown> => {
  const bibliographic: Record<string, unknown> = { url: meta.url };
  const set = (key: string, value: unknown): void => {
    if (value !== null && value !== undefined && value !== '') bibliographic[key] = value;
  };
  set('title', meta.title);
  set('containerTitle', meta.containerTitle);
  set('volume', meta.volume);
  set('issue', meta.issue);
  if (meta.firstPage !== null) {
    set('pages', meta.lastPage === null ? meta.firstPage : `${meta.firstPage}-${meta.lastPage}`);
    if (/^\d+$/u.test(meta.firstPage)) set('pageFirst', Number(meta.firstPage));
    if (meta.lastPage !== null && /^\d+$/u.test(meta.lastPage) && /^\d+$/u.test(meta.firstPage)) {
      // `1234–45` means 1245: expand an abbreviated last page, and keep the order the server checks.
      const first = meta.firstPage;
      const last = meta.lastPage.length < first.length ? first.slice(0, first.length - meta.lastPage.length) + meta.lastPage : meta.lastPage;
      if (Number(last) >= Number(first)) set('pageLast', Number(last));
    }
  }
  set('doi', meta.doi);
  set('pmid', meta.pmid);
  set('publisher', meta.publisher);
  set('abstract', meta.abstract);
  if (meta.year !== null) set('issuedYear', meta.year);
  if (meta.date !== null && /^\d{4}(-\d{2}(-\d{2})?)?$/u.test(meta.date.replace(/\//gu, '-'))) set('issuedDate', meta.date.replace(/\//gu, '-'));
  else if (meta.year !== null) set('issuedDate', String(meta.year));
  if (meta.language !== null && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u.test(meta.language)) set('languageCode', meta.language);
  const creators = meta.authors.filter((author) => (author.family ?? author.literal ?? author.given ?? '') !== '').map(creatorOf);
  return {
    itemType: meta.itemType,
    title: meta.title,
    bibliographic,
    ...(creators.length === 0 ? {} : { creators }),
  };
};

const problem = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { detail?: string; title?: string };
    return body.detail ?? body.title ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
};

export const saveToRecueil = async (
  settings: ConnectorSettings,
  meta: PageMetadata,
  options: { fetch?: FetchLike; fetchPdf?: (url: string) => Promise<Blob> } = {},
): Promise<SaveOutcome> => {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = settings.baseUrl.replace(/\/+$/u, '');
  const auth = { authorization: `Bearer ${settings.token}` };

  const created = await doFetch(`${base}/api/v1/items`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(itemBody(meta)),
  });
  if (!created.ok) throw new SaveError(await problem(created), created.status);
  const item = (await created.json()) as { id: string };

  if (meta.pdfUrl === null) return { itemId: item.id, pdf: 'none' };
  try {
    const blob = await (options.fetchPdf ?? (async (url: string) => {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`the publisher answered HTTP ${response.status}`);
      return response.blob();
    }))(meta.pdfUrl);
    // By the bytes, not the content type: publishers often serve PDFs as octet-stream.
    const magic = new TextDecoder().decode(await blob.slice(0, 5).arrayBuffer());
    if (magic !== '%PDF-') return { itemId: item.id, pdf: { failed: 'the PDF link did not return a PDF (often a login page)' } };
    const form = new FormData();
    // Fields before the file, or the server never sees them (`@fastify/multipart`).
    form.append('sourceKind', 'connector');
    form.append('sourceRef', meta.pdfUrl);
    // Attached in the same transaction as the upload: no document is left orphaned on a failure.
    form.append('itemId', item.id);
    form.append('role', 'primary');
    form.append('file', blob, `${(meta.title ?? 'document').slice(0, 80).replace(/[^\p{L}\p{N} ._-]+/gu, '_')}.pdf`);
    const uploaded = await doFetch(`${base}/api/v1/documents`, { method: 'POST', headers: { ...auth, accept: 'application/json' }, body: form });
    if (!uploaded.ok) return { itemId: item.id, pdf: { failed: await problem(uploaded) } };
    return { itemId: item.id, pdf: 'attached' };
  } catch (error) {
    return { itemId: item.id, pdf: { failed: error instanceof Error ? error.message : String(error) } };
  }
};
