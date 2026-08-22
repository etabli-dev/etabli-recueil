/**
 * The library the browser is shown, created through the API.
 *
 * Nothing here touches SQLite. P6 says there is no privileged back channel, and a fixture that
 * wrote rows directly would quietly excuse the server from the half of the contract that accepts
 * writes — and would let the suite pass over a database shape the API cannot actually produce.
 * Everything below is a request a CLI or an importer could make.
 *
 * The seed is small and every value in it is load-bearing: the collection membership is what the
 * filter test narrows by, the note carries a word that appears nowhere else so that a search hit
 * cannot be a coincidence, and the uploaded PDF is what the reader opens.
 */
import { buildTwoPagePdf } from './pdf.js';

/* -------------------------------------------------------------------------------------------- */
/* What the tests refer to                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** A word invented for this fixture. It appears in one note and nowhere else in the library. */
export const NOTE_SEARCH_TERM = 'zaltrepine';

export const TITLES = {
  trial: 'A randomised trial of nothing in particular',
  guidelines: 'Reporting guidelines for observational studies',
  registered: 'Registered reports in the health sciences',
} as const;

export const COLLECTION_NAME = 'Trials';

export interface SeededLibrary {
  readonly collectionId: string;
  readonly collectionName: string;
  /** In the `Trials` collection, with creators, a tag and the attached PDF. */
  readonly trialItemId: string;
  /** Outside the collection. Carries the note the search test looks for. */
  readonly guidelinesItemId: string;
  /** In the `Trials` collection, so the filter narrows to two rather than to one. */
  readonly registeredItemId: string;
  readonly documentId: string;
  readonly attachmentId: string;
}

/* -------------------------------------------------------------------------------------------- */
/* The API, as a caller sees it                                                                    */
/* -------------------------------------------------------------------------------------------- */

class SeedClient {
  constructor(private readonly origin: string) {}

  async post<TResult>(path: string, body: unknown): Promise<TResult> {
    return this.send<TResult>('POST', path, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async get<TResult>(path: string): Promise<TResult> {
    return this.send<TResult>('GET', path, {});
  }

  async upload<TResult>(path: string, form: FormData): Promise<TResult> {
    return this.send<TResult>('POST', path, { body: form });
  }

  private async send<TResult>(method: string, path: string, init: RequestInit): Promise<TResult> {
    const response = await fetch(`${this.origin}${path}`, { ...init, method });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Seeding failed: ${method} ${path} answered ${response.status}. ${text}`);
    }
    return (text === '' ? undefined : JSON.parse(text)) as TResult;
  }
}

interface Identified {
  readonly id: string;
}

/** `DocumentUploadResult`: the document, whether it was new, and the attachment the form asked for. */
interface UploadResult {
  readonly document: Identified;
  readonly created: boolean;
  readonly attachmentId: string | null;
}

/* -------------------------------------------------------------------------------------------- */
/* The seed                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export const seedLibrary = async (apiOrigin: string): Promise<SeededLibrary> => {
  const api = new SeedClient(`${apiOrigin}/api/v1`);

  const collection = await api.post<Identified>('/collections', { name: COLLECTION_NAME });

  // Creators are their own records, resolved before the item that cites them: the API refuses an
  // inline creator, because deciding that two spellings are one person is identity resolution and
  // not something a create call does silently (CR2, P3).
  const ravaud = await api.post<Identified>('/creators', {
    kind: 'person',
    familyName: 'Ravaud',
    givenName: 'Philippe',
  });
  const boutron = await api.post<Identified>('/creators', {
    kind: 'person',
    familyName: 'Boutron',
    givenName: 'Isabelle',
  });

  const trial = await api.post<Identified>('/items', {
    itemType: 'journal_article',
    title: TITLES.trial,
    bibliographic: {
      title: TITLES.trial,
      containerTitle: 'Journal of Negative Results',
      issuedYear: 2019,
      issuedDate: '2019-04',
      volume: '12',
      doi: '10.1000/e2e.trial',
    },
    creators: [
      { creatorId: ravaud.id, role: 'author' },
      { creatorId: boutron.id, role: 'author' },
    ],
    tagNames: ['to-read'],
    collectionIds: [collection.id],
  });

  const guidelines = await api.post<Identified>('/items', {
    itemType: 'journal_article',
    title: TITLES.guidelines,
    bibliographic: {
      title: TITLES.guidelines,
      containerTitle: 'Annals of Method',
      issuedYear: 2021,
      doi: '10.1000/e2e.guidelines',
    },
    creators: [{ creatorId: boutron.id, role: 'author' }],
    tagNames: ['methods'],
  });

  const registered = await api.post<Identified>('/items', {
    itemType: 'journal_article',
    title: TITLES.registered,
    bibliographic: {
      title: TITLES.registered,
      containerTitle: 'Journal of Negative Results',
      issuedYear: 2023,
      doi: '10.1000/e2e.registered',
    },
    collectionIds: [collection.id],
  });

  await api.post('/notes', {
    itemId: guidelines.id,
    title: 'Reading note',
    contentMarkdown: `The ${NOTE_SEARCH_TERM} dosing schedule is buried in the appendix rather than the methods.`,
  });

  // The upload attaches in one call: `itemId` on the multipart form is what turns a stored document
  // into an attachment on an item.
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buildTwoPagePdf())], { type: 'application/pdf' }), 'trial.pdf');
  form.append('itemId', trial.id);
  form.append('title', 'The trial, as published');
  form.append('role', 'primary');
  const upload = await api.upload<UploadResult>('/documents', form);
  if (upload.attachmentId === null) {
    throw new Error('The upload named an item but the server attached nothing to it.');
  }

  return {
    collectionId: collection.id,
    collectionName: COLLECTION_NAME,
    trialItemId: trial.id,
    guidelinesItemId: guidelines.id,
    registeredItemId: registered.id,
    documentId: upload.document.id,
    attachmentId: upload.attachmentId,
  };
};
