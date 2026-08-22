/**
 * The reader route: one attachment, at its own URL.
 *
 * The attachment is fetched here rather than passed through navigation state, so that the URL is
 * enough — a bookmark, a deep link from Overleaf, or a reload all arrive at the same page.
 */
import { useNavigate, useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { useApiClient } from '../api/context.js';
import { useAttachment } from '../api/queries.js';
import { ErrorState, LoadingState } from '../components/states.js';

/**
 * PDF.js is loaded on demand.
 *
 * It is by far the largest dependency in the application, and the library view — which is where
 * every session starts — does not need a line of it.
 */
const PdfReader = lazy(async () => {
  const module_ = await import('../reader/pdf-reader.js');
  return { default: module_.PdfReader };
});

export const ReaderRoute = (): JSX.Element => {
  const { attachmentId } = useParams({ strict: false }) as { attachmentId?: string };
  const client = useApiClient();
  const navigate = useNavigate();
  const attachment = useAttachment(attachmentId ?? null);

  const back = (): void => {
    void navigate({ to: '/', search: { scope: 'library', order: 'desc' } });
  };

  if (attachmentId === undefined) {
    return <ErrorState label="No attachment named" error={new Error('The reader URL carries no attachment id.')} />;
  }
  if (attachment.isPending) return <LoadingState label="Loading the attachment…" />;
  if (attachment.isError) {
    return (
      <ErrorState
        label="Could not load the attachment"
        error={attachment.error}
        onRetry={() => void attachment.refetch()}
      />
    );
  }

  // The bytes belong to the document, not to the attachment (AT1): a `linked_url` attachment names
  // no document and there is nothing for the reader to fetch.
  const documentId = attachment.data.documentId ?? null;
  if (documentId === null) {
    return (
      <ErrorState
        label={`Nothing to read in ${attachment.data.title ?? 'this attachment'}`}
        error={
          new Error(
            'This attachment is a link rather than stored bytes, so there is no document to open.',
          )
        }
      />
    );
  }

  return (
    <Suspense fallback={<LoadingState label="Loading the reader…" />}>
      <PdfReader
        attachment={attachment.data}
        url={client.documentContentUrl(documentId)}
        onClose={back}
      />
    </Suspense>
  );
};
