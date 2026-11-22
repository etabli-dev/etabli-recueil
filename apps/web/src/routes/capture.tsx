/**
 * Capture (CONCEPT §7 Phase 8): scan, photograph, share or type an ISBN, and it reaches the library
 * — now if the server can be reached, later if not.
 *
 * Everything goes through the capture queue (`capture/queue.ts`), so a capture made in a lift or
 * on a train is kept on the device and uploaded when the network returns; one the server refuses
 * stays here with the server's reason. In the mobile shells the native scanner, barcode reader and
 * share sheet are offered through the host's capabilities; in a browser a file input with
 * `capture` opens the camera on a phone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApiClient } from '../api/context.js';
import { CaptureQueue, indexedDbCaptureStore, memoryCaptureStore } from '../capture/queue.js';
import type { Capture, FlushReport } from '../capture/queue.js';
import { embeddingHost } from '../host.js';
import type { HostFile } from '../host.js';

let shared: CaptureQueue | null = null;
/** One queue per page, over IndexedDB where there is one. */
export const captureQueue = (): CaptureQueue => {
  shared ??= new CaptureQueue(typeof indexedDB === 'undefined' ? memoryCaptureStore() : indexedDbCaptureStore());
  return shared;
};

const describe = (capture: Capture): string => (capture.kind === 'isbn' ? `ISBN ${capture.isbn}` : `${capture.filename ?? 'file'}${capture.blob === undefined ? '' : ` · ${Math.max(1, Math.round(capture.blob.size / 1024))} KB`}`);

export const CaptureRoute = (): JSX.Element => {
  const client = useApiClient();
  const queue = useMemo(captureQueue, []);
  const host = useMemo(() => embeddingHost(), []);
  const capabilities = host?.capabilities;
  const [items, setItems] = useState<Capture[]>([]);
  const [last, setLast] = useState<FlushReport | null>(null);
  const [isbn, setIsbn] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => queue.list().then(setItems), [queue]);

  const flush = useCallback(async () => {
    const report = await queue.flush(client);
    setLast(report);
    await refresh();
    return report;
  }, [client, queue, refresh]);

  const addFiles = useCallback(
    async (files: HostFile[], origin: string) => {
      for (const file of files) await queue.addFile(file.blob, file.filename, origin, file.note);
      await refresh();
      await flush();
    },
    [flush, queue, refresh],
  );

  useEffect(() => {
    void refresh().then(() => flush());
    const cleanups: (() => void)[] = [];
    if (capabilities?.onShared !== undefined) cleanups.push(capabilities.onShared((files) => void addFiles(files, 'share')));
    const onNetwork = (isOnline: boolean): void => {
      setOnline(isOnline);
      if (isOnline) void flush();
    };
    if (capabilities?.onNetworkChange !== undefined) cleanups.push(capabilities.onNetworkChange(onNetwork));
    else if (typeof window !== 'undefined') {
      const up = (): void => onNetwork(true);
      const down = (): void => onNetwork(false);
      window.addEventListener('online', up);
      window.addEventListener('offline', down);
      cleanups.push(() => {
        window.removeEventListener('online', up);
        window.removeEventListener('offline', down);
      });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [addFiles, capabilities, flush, refresh]);

  const fromInput = (input: HTMLInputElement | null, origin: string): void => {
    const files = [...(input?.files ?? [])].map((file) => ({ blob: file as Blob, filename: file.name }));
    if (input !== null) input.value = '';
    void addFiles(files, origin);
  };

  const scan = async (): Promise<void> => {
    if (capabilities?.scanDocument === undefined) return cameraInput.current?.click();
    const pages = await capabilities.scanDocument();
    if (pages.length > 0) await addFiles(pages, 'scan');
  };

  const addIsbn = async (raw: string, origin: string): Promise<void> => {
    try {
      await queue.addIsbn(raw, origin);
      setIsbn('');
      setMessage(null);
      await refresh();
      await flush();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const barcode = async (): Promise<void> => {
    const code = await capabilities?.scanBarcode?.();
    if (code !== null && code !== undefined) await addIsbn(code, 'barcode');
  };

  const pending = items.filter((item) => item.status === 'queued');
  const refused = items.filter((item) => item.status === 'refused');

  return (
    <section className="capture">
      <h1>Capture</h1>
      <p className="capture-status" aria-live="polite">
        {online ? 'Online.' : 'Offline — captures are kept on this device and uploaded when the connection returns.'}
        {last !== null && last.uploaded.length > 0 ? ` ${last.uploaded.length} uploaded just now.` : ''}
      </p>
      <div className="capture-actions">
        <button onClick={() => void scan()}>{capabilities?.scanDocument === undefined ? 'Photograph a document' : 'Scan a document'}</button>
        <button onClick={() => fileInput.current?.click()}>Choose files</button>
        {capabilities?.scanBarcode === undefined ? null : <button onClick={() => void barcode()}>Scan an ISBN barcode</button>}
        <input ref={cameraInput} type="file" accept="image/*,application/pdf" capture="environment" hidden onChange={(event) => fromInput(event.currentTarget, 'camera')} />
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => fromInput(event.currentTarget, 'file')} />
      </div>
      <form
        className="capture-isbn"
        onSubmit={(event) => {
          event.preventDefault();
          void addIsbn(isbn, 'typed');
        }}
      >
        <label>
          ISBN <input value={isbn} inputMode="numeric" autoComplete="off" onChange={(event) => setIsbn(event.target.value)} placeholder="978-…" />
        </label>
        <button type="submit" disabled={isbn.trim() === ''}>
          Add book
        </button>
        {message === null ? null : <span role="alert">{message}</span>}
      </form>
      <h2>Waiting to upload ({pending.length})</h2>
      {pending.length === 0 ? (
        <p className="quiet">Nothing waiting.</p>
      ) : (
        <ul className="capture-list">
          {pending.map((item) => (
            <li key={item.id}>
              {describe(item)} <span className="quiet">· {item.origin} · {item.attempts === 0 ? 'not tried yet' : `tried ${item.attempts}×${item.lastError === null ? '' : `: ${item.lastError}`}`}</span>
            </li>
          ))}
        </ul>
      )}
      {pending.length > 0 ? <button onClick={() => void flush()}>Upload now</button> : null}
      {refused.length === 0 ? null : (
        <>
          <h2>Refused by the server ({refused.length})</h2>
          <ul className="capture-list refused">
            {refused.map((item) => (
              <li key={item.id}>
                {describe(item)} — <strong>{item.lastError}</strong>{' '}
                <button onClick={() => void queue.retry(item.id).then(flush)}>Try again</button> <button onClick={() => void queue.discard(item.id).then(refresh)}>Discard</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};
