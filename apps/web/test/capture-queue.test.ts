import { describe, expect, it } from 'vitest';

import { ApiError } from '../src/api/problem.js';
import { CaptureQueue, isRetryable, memoryCaptureStore, normaliseIsbn } from '../src/capture/queue.js';
import type { CaptureUploader } from '../src/capture/queue.js';

const problem = (status: number, detail: string) => new ApiError({ type: 'about:blank', title: 'x', status, detail }, { method: 'POST', url: '/x' });

const uploader = (script: (call: number) => 'ok' | ApiError | Error): CaptureUploader & { calls: string[] } => {
  const calls: string[] = [];
  const answer = async <T>(label: string, value: T): Promise<T> => {
    calls.push(label);
    const next = script(calls.length);
    if (next !== 'ok') throw next;
    return value;
  };
  return {
    calls,
    uploadForIngestion: (_blob, fields) => answer(`file:${fields.filename}`, { outcome: 'ingested', jobId: 'j', document: null, item: null, reviewEntry: null, reasonCode: null, detail: '' }),
    createItemFromIsbn: (isbn) => answer(`isbn:${isbn}`, { id: 'item' }),
  };
};

describe('the capture queue', () => {
  it('keeps captures until they are uploaded, oldest first', async () => {
    const queue = new CaptureQueue(memoryCaptureStore());
    await queue.addFile(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), 'scan-1.pdf', 'scan');
    await queue.addIsbn('978-3-16-148410-0', 'barcode');
    expect((await queue.list()).map((c) => c.kind)).toEqual(['file', 'isbn']);
    const up = uploader(() => 'ok');
    const report = await queue.flush(up);
    expect(up.calls).toEqual(['file:scan-1.pdf', 'isbn:9783161484100']);
    expect(report.uploaded.map((u) => u.outcome)).toEqual(['ingested', 'created']);
    expect(await queue.list()).toEqual([]);
  });

  it('defers everything when the server cannot be reached, and uploads it on the next flush', async () => {
    const queue = new CaptureQueue(memoryCaptureStore());
    await queue.addFile(new Blob(['a']), 'a.jpg', 'camera');
    await queue.addFile(new Blob(['b']), 'b.jpg', 'camera');
    const offline = uploader(() => problem(0, 'Failed to fetch'));
    const first = await queue.flush(offline);
    expect(offline.calls).toHaveLength(1);
    expect(first.deferred).toHaveLength(2);
    const [a] = await queue.list();
    expect(a).toMatchObject({ status: 'queued', attempts: 1, lastError: 'Failed to fetch' });
    const second = await queue.flush(uploader(() => 'ok'));
    expect(second.uploaded).toHaveLength(2);
  });

  it('keeps a refused capture with the server’s reason and does not retry it on its own', async () => {
    const queue = new CaptureQueue(memoryCaptureStore());
    const refused = await queue.addFile(new Blob(['x']), 'huge.tiff', 'share');
    await queue.addFile(new Blob(['y']), 'fine.pdf', 'share');
    const report = await queue.flush(uploader((call) => (call === 1 ? problem(413, 'The file is larger than the server accepts.') : 'ok')));
    expect(report.refused.map((c) => c.filename)).toEqual(['huge.tiff']);
    expect(report.uploaded.map((u) => u.capture.filename)).toEqual(['fine.pdf']);
    expect(await queue.list()).toEqual([expect.objectContaining({ id: refused.id, status: 'refused', lastError: 'The file is larger than the server accepts.' })]);
    const again = uploader(() => 'ok');
    await queue.flush(again);
    expect(again.calls).toEqual([]);
    await queue.retry(refused.id);
    await queue.flush(again);
    expect(again.calls).toEqual(['file:huge.tiff']);
  });

  it('shares one pass between concurrent flushes', async () => {
    const queue = new CaptureQueue(memoryCaptureStore());
    await queue.addIsbn('0-306-40615-2', 'typed');
    const up = uploader(() => 'ok');
    await Promise.all([queue.flush(up), queue.flush(up)]);
    expect(up.calls).toEqual(['isbn:0306406152']);
  });

  it('tells retryable failures from refusals', () => {
    expect(isRetryable(problem(0, ''))).toBe(true);
    expect(isRetryable(problem(503, ''))).toBe(true);
    expect(isRetryable(problem(429, ''))).toBe(true);
    expect(isRetryable(problem(422, ''))).toBe(false);
    expect(isRetryable(new TypeError('network'))).toBe(true);
  });

  it('accepts only ISBNs whose check digit holds', () => {
    expect(normaliseIsbn('978-3-16-148410-0')).toBe('9783161484100');
    expect(normaliseIsbn('0-306-40615-2')).toBe('0306406152');
    expect(normaliseIsbn('080442957X')).toBe('080442957X');
    expect(normaliseIsbn('978-3-16-148410-1')).toBeNull();
    expect(normaliseIsbn('hello')).toBeNull();
  });

  it('refuses a malformed ISBN before queueing it', async () => {
    await expect(new CaptureQueue(memoryCaptureStore()).addIsbn('123', 'typed')).rejects.toThrow(/not a valid ISBN/u);
  });
});
