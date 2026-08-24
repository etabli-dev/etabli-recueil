/**
 * The pieces both remote backends are built from: the retry policy, the local spool, the verifying
 * read stream, and the path checks that stand between a hostile string and a URL.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { StorageIntegrityError, StorageRequestError } from '../src/errors.js';
import { backoffDelay, parseRetryAfter, withRetry } from '../src/retry.js';
import { spool } from '../src/spool.js';
import { startFakeWebDavServer } from '../src/testing/webdav-server.js';
import { collect, verifyingStream } from '../src/verify.js';
import { assertSegment } from '../src/webdav/client.js';

const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Speak HTTP by hand, for a request no client library will agree to send. */
const rawRequest = async (port: number, request: string): Promise<number> =>
  new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ host: '127.0.0.1', port }, () => socket.write(request));
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    socket.on('error', rejectPromise);
    socket.on('close', () => {
      const match = /^HTTP\/1\.[01] (\d{3})/u.exec(received);
      if (match === null) rejectPromise(new Error(`No status line in: ${received.slice(0, 200)}`));
      else resolvePromise(Number(match[1]));
    });
  });

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'recueil-spool-'));
  cleanup.push(async () => rm(directory, { recursive: true, force: true }));
  return directory;
};

describe('withRetry', () => {
  const policy = { attempts: 4, baseDelayMs: 100, maxDelayMs: 10_000, jitter: false };

  it('returns the first success without sleeping', async () => {
    const slept: number[] = [];
    const result = await withRetry(async () => 'done', {
      policy,
      isRetryable: () => true,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(result).toBe('done');
    expect(slept).toEqual([]);
  });

  it('doubles the delay between attempts', async () => {
    const slept: number[] = [];
    let attempts = 0;

    const result = await withRetry(
      async (attempt) => {
        attempts = attempt;
        if (attempt < 4) throw new Error('not yet');
        return attempt;
      },
      {
        policy,
        isRetryable: () => true,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    expect(result).toBe(4);
    expect(attempts).toBe(4);
    expect(slept).toEqual([100, 200, 400]);
  });

  it('rethrows a failure it was told not to retry, at once', async () => {
    const slept: number[] = [];
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('wrong password');
        },
        {
          policy,
          isRetryable: () => false,
          sleep: async (ms) => {
            slept.push(ms);
          },
        },
      ),
    ).rejects.toThrow(/wrong password/u);

    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it('stops at the attempt limit and rethrows the last failure', async () => {
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new StorageRequestError('webdav', {
            method: 'PUT',
            url: 'http://example.invalid/x',
            status: 503,
            retryable: true,
          });
        },
        { policy, isRetryable: () => true, sleep: async () => undefined },
      ),
    ).rejects.toThrow(/HTTP 503/u);

    expect(calls).toBe(4);
  });

  it('never lets an attempt reuse a consumed body: the operation is a factory', async () => {
    // The property that makes retrying a PUT safe. Each attempt gets its own attempt number and is
    // expected to build its own request; nothing is captured from the previous one.
    const bodies: string[] = [];
    await withRetry(
      async (attempt) => {
        bodies.push(`body-${attempt}`);
        if (attempt < 3) throw new Error('again');
        return attempt;
      },
      { policy, isRetryable: () => true, sleep: async () => undefined },
    );

    expect(bodies).toEqual(['body-1', 'body-2', 'body-3']);
  });

  it('caps the computed backoff at maxDelayMs', () => {
    const capped = { attempts: 20, baseDelayMs: 1000, maxDelayMs: 5000, jitter: false };
    expect(backoffDelay(1, capped)).toBe(1000);
    expect(backoffDelay(3, capped)).toBe(4000);
    expect(backoffDelay(4, capped)).toBe(5000);
    expect(backoffDelay(10, capped)).toBe(5000);
  });

  it('spreads a jittered delay over the upper half of the interval', () => {
    const jittered = { attempts: 5, baseDelayMs: 1000, maxDelayMs: 10_000, jitter: true };
    for (let index = 0; index < 200; index += 1) {
      const delay = backoffDelay(2, jittered);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads an HTTP-date, relative to now', () => {
    const now = Date.parse('2026-08-22T12:00:00Z');
    expect(parseRetryAfter('Sat, 22 Aug 2026 12:00:45 GMT', now)).toBe(45_000);
    // A date in the past means "now".
    expect(parseRetryAfter('Sat, 22 Aug 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('ignores what it cannot read', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('spool', () => {
  it('hashes the bytes it writes and hands back a re-openable file', async () => {
    const directory = await scratch();
    const bytes = Buffer.from('spooled and hashed', 'utf8');

    const spooled = await spool(Readable.from([bytes]), directory);

    expect(spooled.sha256).toBe(digestOf(bytes));
    expect(spooled.size).toBe(bytes.byteLength);
    expect(readFileSync(spooled.path)).toEqual(bytes);
    // Twice, because a retry must be able to resend the same bytes.
    expect(await collect(spooled.open())).toEqual(bytes);
    expect(await collect(spooled.open())).toEqual(bytes);

    await spooled.dispose();
    expect(existsSync(spooled.path)).toBe(false);
    await spooled.dispose();
  });

  it('opens a byte range, which is what a multipart part is', async () => {
    const directory = await scratch();
    const bytes = Buffer.from('0123456789', 'utf8');
    const spooled = await spool(bytes, directory);

    expect(await collect(spooled.open({ start: 3, end: 6 }))).toEqual(Buffer.from('3456', 'utf8'));
  });

  it('computes the extra digests it is asked for in the same pass', async () => {
    const directory = await scratch();
    const bytes = Buffer.from('also md5, for a server that might care', 'utf8');

    const spooled = await spool(bytes, directory, { additionalHashes: ['md5'] });

    expect(spooled.additional['md5']).toBe(createHash('md5').update(bytes).digest('base64'));
  });

  it('leaves nothing behind when the source fails', async () => {
    const directory = await scratch();
    const failing = new Readable({
      read() {
        this.push(Buffer.from('half a scan', 'utf8'));
        this.destroy(new Error('scanner went away'));
      },
    });

    await expect(spool(failing, directory)).rejects.toThrow(/scanner went away/u);
    expect(await readdir(directory)).toEqual([]);
  });
});

describe('verifyingStream', () => {
  it('passes the bytes through unchanged when they are right', async () => {
    const bytes = Buffer.from('honest bytes', 'utf8');
    const verified = verifyingStream(Readable.from([bytes]), digestOf(bytes), 'test');

    expect(await collect(verified)).toEqual(bytes);
  });

  it('fails at the end when the digest does not match, and says by how much', async () => {
    const bytes = Buffer.from('dishonest bytes', 'utf8');
    const verified = verifyingStream(Readable.from([bytes]), 'a'.repeat(64), 'test');

    const error = await collect(verified).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageIntegrityError);
    expect((error as StorageIntegrityError).expected).toBe('a'.repeat(64));
    expect((error as StorageIntegrityError).actual).toBe(digestOf(bytes));
    expect((error as StorageIntegrityError).size).toBe(15);
  });

  it('fails on a short body before it has finished hashing, when the length was advertised', async () => {
    const bytes = Buffer.from('truncated', 'utf8');
    const verified = verifyingStream(Readable.from([bytes]), digestOf(bytes), 'test', 100);

    const error = await collect(verified).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageIntegrityError);
    expect((error as StorageIntegrityError).actual).toMatch(/9 bytes, expected 100/u);
  });

  it('propagates an upstream failure rather than reporting a clean short read', async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.from('half', 'utf8'));
        this.destroy(new Error('connection reset by peer'));
      },
    });
    const verified = verifyingStream(failing, 'a'.repeat(64), 'test');

    await expect(collect(verified)).rejects.toThrow(/connection reset by peer/u);
  });
});

describe('WebDAV path segments', () => {
  it('accepts what the store generates and refuses everything else', () => {
    expect(assertSegment('aa')).toBe('aa');
    expect(assertSegment('.tmp')).toBe('.tmp');
    expect(assertSegment('01JXYZ.part')).toBe('01JXYZ.part');

    for (const hostile of ['..', '.', 'a/b', '', '../etc', 'a\\b', 'a b', 'a%2Fb', 'a?b', 'a#b']) {
      expect(() => assertSegment(hostile)).toThrow(/Refusing to build a WebDAV path/u);
    }
  });
});

describe('the WebDAV fake itself', () => {
  /** A fake that can be walked out of would hide the bug it exists to find. */
  it('refuses a path that escapes the served root', async () => {
    const server = await startFakeWebDavServer();
    cleanup.push(async () => server.close());
    const outside = join(server.root, '..', 'escaped.txt');
    const { port, pathname } = new URL(server.url);

    // Two shapes, because they are stopped by two different things.
    //
    // A plain `..` never survives: the WHATWG URL parser collapses it, in `fetch` and again in the
    // server, so the request arrives asking for something above the mount point and is refused as
    // not found. An **encoded slash** does survive — `%2f` is not a path separator to the parser —
    // so `/a%2f..%2f..%2fescaped.txt` reaches the handler as one segment and only becomes a
    // traversal when it is decoded. That is the one the root check exists for.
    const collapsed = await rawRequest(
      Number(port),
      `PUT ${pathname}/../escaped.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\nConnection: close\r\n\r\nBOOM!`,
    );
    const encoded = await fetch(`${server.url}/a%2f..%2f..%2fescaped.txt`, {
      method: 'PUT',
      body: 'this must not be written',
    });

    expect(collapsed).toBe(404);
    expect(encoded.status).toBe(403);
    expect(existsSync(outside)).toBe(false);
  });

  it('really does verify OC-Checksum when it is told to', async () => {
    const server = await startFakeWebDavServer({ verifyOcChecksum: true });
    cleanup.push(async () => server.close());

    const response = await fetch(`${server.url}/lies.bin`, {
      method: 'PUT',
      headers: { 'oc-checksum': `SHA256:${'a'.repeat(64)}` },
      body: 'these bytes hash to something else',
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/OC-Checksum mismatch/u);
  });

  it('really does truncate a PUT when it is told to', async () => {
    const server = await startFakeWebDavServer({ truncatePutsTo: 4 });
    cleanup.push(async () => server.close());

    await fetch(`${server.url}/short.bin`, { method: 'PUT', body: 'much longer than four' });
    const read = await fetch(`${server.url}/short.bin`);

    expect(await read.text()).toBe('much');
  });
});
