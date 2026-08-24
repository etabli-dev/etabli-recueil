/**
 * Where a shared file lands.
 *
 * This is the interim mobile capture path of CONCEPT.md §7 Phase 2: the operating system's share
 * sheet posts to `/share`, the service worker stashes the file and redirects here, and this page
 * uploads it to `POST /api/v1/ingestion/upload` with `sourceKind: mobile`, so a rule at stage 8 can
 * tell where it came from.
 *
 * Three things it is careful about.
 *
 * **It says which of the six outcomes happened.** The endpoint runs the whole pipeline, so its
 * answer is not "uploaded" but `ingested`, `duplicate`, `review`, `container`, `stopped` or
 * `failed` — and the page renders the one that occurred, with the item that was created or the
 * review entry that says why there is not one. A capture screen that reported success either way
 * would be training the user to send the same scan twice and to assume it was filed.
 *
 * **It empties the stash only after the upload has answered.** A share cleared optimistically and
 * then failing to upload is a document that existed on the phone, was consumed by this page, and is
 * nowhere.
 *
 * **It never retries by itself.** P1: the server is the source of truth and there is no write queue
 * in this client. A failed upload stays on screen with its problem document and a button.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearch } from '@tanstack/react-router';

import { useApiClient } from '../api/context.js';
import type { IngestUploadResult } from '../api/ingestion.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { SHARE_KEY_PARAM } from '../pwa/share-protocol.js';
import type { StashedShare } from '../pwa/share-protocol.js';
import { clearShare, readShare } from '../pwa/share-store.js';

export interface ShareSearch {
  share?: string;
  error?: string;
}

export const validateShareSearch = (raw: Record<string, unknown>): ShareSearch => {
  const search: ShareSearch = {};
  const key = raw[SHARE_KEY_PARAM];
  if (typeof key === 'string' && /^[0-9a-f]{16,64}$/u.test(key)) search.share = key;
  if (typeof raw.error === 'string' && raw.error !== '') search.error = raw.error;
  return search;
};

type Outcome =
  | { state: 'pending' }
  | { state: 'uploaded'; result: IngestUploadResult }
  | { state: 'failed'; error: unknown };

export const ShareRoute = (): JSX.Element => {
  const search = useSearch({ strict: false }) as ShareSearch;
  return <SharePanel shareKey={search.share ?? null} error={search.error ?? null} />;
};

export interface SharePanelProps {
  /** The stash key the service worker redirected with, already checked for shape. */
  shareKey: string | null;
  /** Set when the worker could not read the shared form at all. */
  error: string | null;
}

/**
 * The panel, separated from the route so it can be rendered without a router.
 *
 * The route's only job is to read two search parameters; everything that is worth asserting on —
 * the read-back, the upload, the duplicate report, the emptying of the stash — is here.
 */
export const SharePanel = ({ shareKey, error }: SharePanelProps): JSX.Element => {
  const client = useApiClient();
  const [shares, setShares] = useState<StashedShare[] | null>(null);
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});
  const [readError, setReadError] = useState<unknown>(null);

  const key = shareKey;

  useEffect(() => {
    if (key === null) {
      setShares([]);
      return;
    }
    if (typeof caches === 'undefined') {
      setReadError(new Error('This browser has no Cache API, so the share could not be picked up.'));
      setShares([]);
      return;
    }
    void readShare(caches, key).then(setShares).catch(setReadError);
  }, [key]);

  const upload = useCallback(
    async (index: number, share: StashedShare) => {
      setOutcomes((current) => ({ ...current, [index]: { state: 'pending' } }));
      try {
        const result = await client.uploadForIngestion(share.blob, {
          filename: share.filename,
          sourceKind: 'mobile',
          ...(share.note === null ? {} : { subject: share.note }),
        });
        setOutcomes((current) => ({ ...current, [index]: { state: 'uploaded', result } }));
      } catch (error) {
        setOutcomes((current) => ({ ...current, [index]: { state: 'failed', error } }));
      }
    },
    [client],
  );

  // Emptying the stash is what stops a reload re-uploading. It runs only once every file has an
  // answer, and only when none of those answers is a failure: a failed share must stay collectable.
  useEffect(() => {
    if (key === null || shares === null || shares.length === 0) return;
    const answered = shares.every((_, index) => outcomes[index]?.state === 'uploaded');
    if (!answered || typeof caches === 'undefined') return;
    void clearShare(caches, key);
  }, [key, shares, outcomes]);

  if (error !== null) {
    return (
      <section className="share">
        <h2>The share could not be picked up</h2>
        <p>
          The service worker could not read the shared file. Nothing was uploaded and nothing was
          kept. Try sharing it again, or open the library and upload it there.
        </p>
      </section>
    );
  }

  if (readError !== null) {
    return (
      <section className="share">
        <ErrorState label="The shared file could not be read back" error={readError} />
      </section>
    );
  }

  if (shares === null) return <LoadingState label="Picking up the shared file…" />;

  if (shares.length === 0) {
    return (
      <section className="share" data-testid="share-empty">
        <h2>Nothing shared</h2>
        <p>
          This page is where the operating system’s share sheet sends a file. Opening it directly has
          nothing to pick up. Install Recueil to the home screen, then share a scan or a PDF to it.
        </p>
      </section>
    );
  }

  return (
    <section className="share" data-testid="share-page">
      <h2>
        {shares.length} shared file{shares.length === 1 ? '' : 's'}
      </h2>
      <ul className="share__list">
        {shares.map((share, index) => (
          <li key={`${share.filename}-${String(index)}`} className="share__item" data-testid="share-item">
            <p className="share__name">{share.filename}</p>
            <p className="share__meta">
              <code>{share.mediaType}</code> · {share.blob.size} bytes · shared {share.stashedAt}
            </p>
            {share.note === null ? null : <p className="share__note">{share.note}</p>}
            <ShareOutcome
              outcome={outcomes[index]}
              onUpload={() => void upload(index, share)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
};

const ShareOutcome = ({ outcome, onUpload }: { outcome: Outcome | undefined; onUpload: () => void }): JSX.Element => {
  if (outcome === undefined) {
    return (
      <button type="button" className="button button--primary" onClick={onUpload}>
        Add to the library
      </button>
    );
  }
  if (outcome.state === 'pending') return <LoadingState label="Uploading…" />;
  if (outcome.state === 'failed') {
    return (
      <>
        <ErrorState label="The upload failed" error={outcome.error} />
        <button type="button" className="button" onClick={onUpload}>
          Try again
        </button>
      </>
    );
  }
  return <UploadOutcome result={outcome.result} />;
};

/**
 * What the pipeline did with it.
 *
 * One branch per outcome, and none of them says "done" without saying what happened. `review` is
 * the one that matters on a phone: the file is in the library and nobody has filed it, and a
 * capture screen that called that success would be the reason a scan went missing.
 */
const UploadOutcome = ({ result }: { result: IngestUploadResult }): JSX.Element => {
  const digest = result.document?.sha256 ?? null;
  return (
    <div className="share__result" role="status" data-testid="share-result" data-outcome={result.outcome}>
      <p>
        <span className={`badge badge--${outcomeTone(result.outcome)}`}>{result.outcome}</span>{' '}
        {result.detail}
      </p>
      {result.item === null ? null : (
        <p>
          Filed as <strong>{result.item.title ?? result.item.publicId}</strong> (
          <code>{result.item.itemType}</code>).
        </p>
      )}
      {result.reviewEntry === null ? null : (
        <p data-testid="share-review">
          It is waiting in the review queue: {result.reviewEntry.explanation} Open Recueil on a
          desktop to decide it.
        </p>
      )}
      {result.reasonCode === null ? null : (
        <p>
          Reason: <code>{result.reasonCode}</code>
        </p>
      )}
      {digest === null ? null : <p className="share__meta">{digest}</p>}
    </div>
  );
};

const outcomeTone = (outcome: IngestUploadResult['outcome']): string => {
  switch (outcome) {
    case 'ingested':
      return 'ok';
    case 'duplicate':
    case 'container':
      return 'quiet';
    case 'review':
    case 'stopped':
      return 'warn';
    default:
      return 'error';
  }
};
