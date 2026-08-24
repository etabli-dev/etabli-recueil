/**
 * An in-process WebDAV server, for testing the WebDAV backend without a container and without ever
 * touching a real host.
 *
 * **What this is not.** It is not evidence that the backend works against Nextcloud, ownCloud,
 * Apache `mod_dav` or anything else. It implements what RFC 4918 requires of the seven methods the
 * store uses, and it can be told to misbehave in the specific ways real servers misbehave — but a
 * fake written by the same hand as the client cannot prove compatibility with a third party. The
 * Phase 1 review made that point about a different claim and it applies here: a compatibility
 * claim needs a captured trace from the real thing. See the README.
 *
 * What it *is* good for is the thing a container is bad at: making a server fail on purpose,
 * deterministically, on the third request, with a `Retry-After`, and then succeed.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

export interface FakeWebDavAuth {
  kind: 'basic' | 'bearer';
  /** For `basic`. */
  username?: string;
  password?: string;
  /** For `bearer`. */
  token?: string;
}

export interface FakeWebDavFault {
  /**
   * Answer the first `n` matching requests with `status`, then stop. The classic 503-during-cron
   * shape, and the only honest way to test a backoff loop.
   */
  failFirst?: number;
  status?: number;
  /** Sent with the failure, so the retry loop's `Retry-After` handling can be exercised. */
  retryAfter?: string;
  /** Only fail requests using this method. */
  method?: string;
}

export interface FakeWebDavOptions {
  auth?: FakeWebDavAuth;
  /** The prefix the collection is served under, e.g. `/remote.php/dav/files/rh`. Default `/dav`. */
  mount?: string;
  /** Omit `MOVE` from `Allow` and answer it 501: an server that cannot do atomic writes. */
  disableMove?: boolean;
  /** Answer `MKCOL` with 501: a server that serves a fixed tree. */
  disableMkcol?: boolean;
  /** Do not advertise class 1 compliance. Anything that is not really a WebDAV endpoint. */
  davCompliance?: string;
  /** Omit `Allow` entirely, as many servers do. Default false. */
  omitAllow?: boolean;
  /**
   * Verify `OC-Checksum` and reject a mismatch with 400, as Nextcloud does. Off by default,
   * because the majority of WebDAV servers ignore every checksum header they are sent, and the
   * default should be the pessimistic case.
   */
  verifyOcChecksum?: boolean;
  /** Verify `Content-MD5` and reject a mismatch with 400. Off by default, and realistically so. */
  verifyContentMd5?: boolean;
  /**
   * Store only the first `n` bytes of every `PUT` body, then answer 201 as if all was well.
   *
   * This is the failure the checksum headers were meant to catch and usually do not: a proxy with a
   * body limit, a server that ran out of disk, a connection the server treated as a clean end.
   */
  truncatePutsTo?: number;
  /**
   * Flip one byte of every `PUT` body, keeping the length.
   *
   * The rot a length check cannot see. It is what separates `verifyOnWrite: 'size'` from
   * `'digest'`, and without it that distinction is only a comment.
   */
  flipPutByte?: number;
  fault?: FakeWebDavFault;
  /** Do not send `Content-Length` on `HEAD`. Some Sharepoint-flavoured servers do this. */
  omitHeadContentLength?: boolean;
}

export interface FakeWebDavServer {
  /** The URL of the served collection, ready to hand to `WebDavBackend`. */
  url: string;
  /** The directory the bytes really live in, for a test that wants to corrupt one. */
  root: string;
  /** Every request the server has seen, in order. */
  readonly requests: Array<{ method: string; path: string; headers: Record<string, string> }>;
  /** Change the fault injection between calls. */
  setFault(fault: FakeWebDavFault | undefined): void;
  /** Overwrite a stored blob out of band, to simulate rot. */
  corrupt(relativePath: string, bytes: Buffer): Promise<void>;
  close(): Promise<void>;
}

const send = (response: ServerResponse, status: number, headers: Record<string, string> = {}, body = ''): void => {
  response.writeHead(status, { 'content-length': String(Buffer.byteLength(body)), ...headers });
  response.end(body);
};

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/**
 * Resolve a request path to a location inside the served root, or refuse it.
 *
 * A fake that can be walked out of with `..` is a fake that hides the bug it exists to find, and
 * "a path from a URL is hostile until it has been checked to be inside its root" is one of the
 * carried findings from Phase 1.
 */
const resolveInside = (root: string, requestPath: string): string | null => {
  const decoded = decodeURIComponent(requestPath).replace(/\/+$/u, '');
  const target = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const rel = relative(root, target);
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || resolve(target) !== target)) {
    return null;
  }
  return target;
};

export const startFakeWebDavServer = async (
  options: FakeWebDavOptions = {},
): Promise<FakeWebDavServer> => {
  const root = await mkdtemp(join(tmpdir(), 'recueil-fake-webdav-'));
  const mount = options.mount ?? '/dav';
  const requests: FakeWebDavServer['requests'] = [];
  let fault = options.fault;
  let faultsServed = 0;

  const allow = [
    'OPTIONS',
    'HEAD',
    'GET',
    'PUT',
    'DELETE',
    'PROPFIND',
    ...(options.disableMkcol === true ? [] : ['MKCOL']),
    ...(options.disableMove === true ? [] : ['MOVE']),
  ];

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = (request.method ?? 'GET').toUpperCase();
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push({
      method,
      path: url.pathname,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value.join(', ') : (value ?? ''),
        ]),
      ),
    });

    if (fault?.failFirst !== undefined && faultsServed < fault.failFirst) {
      if (fault.method === undefined || fault.method.toUpperCase() === method) {
        faultsServed += 1;
        await readBody(request).catch(() => undefined);
        send(
          response,
          fault.status ?? 503,
          fault.retryAfter === undefined ? {} : { 'retry-after': fault.retryAfter },
          'injected fault',
        );
        return;
      }
    }

    const auth = options.auth;
    if (auth !== undefined) {
      const header = request.headers.authorization ?? '';
      const ok =
        auth.kind === 'basic'
          ? header ===
            `Basic ${Buffer.from(`${auth.username ?? ''}:${auth.password ?? ''}`, 'utf8').toString('base64')}`
          : header === `Bearer ${auth.token ?? ''}`;
      if (!ok) {
        send(
          response,
          401,
          {
            'www-authenticate':
              auth.kind === 'basic' ? 'Basic realm="recueil"' : 'Bearer realm="recueil"',
          },
          'unauthorised',
        );
        return;
      }
    }

    if (!url.pathname.startsWith(mount)) {
      send(response, 404, {}, 'not below the mount point');
      return;
    }
    const target = resolveInside(root, url.pathname.slice(mount.length) || '/');
    if (target === null) {
      send(response, 403, {}, 'path escapes the served root');
      return;
    }

    const found = await stat(target).catch(() => null);

    switch (method) {
      case 'OPTIONS': {
        const headers: Record<string, string> = {
          dav: options.davCompliance ?? '1, 3',
          'ms-author-via': 'DAV',
        };
        if (options.omitAllow !== true) headers['allow'] = allow.join(', ');
        send(response, 200, headers);
        return;
      }

      case 'HEAD': {
        if (found === null || found.isDirectory()) {
          send(response, 404);
          return;
        }
        const headers: Record<string, string> = { 'accept-ranges': 'bytes' };
        if (options.omitHeadContentLength !== true) headers['content-length'] = String(found.size);
        response.writeHead(200, headers);
        response.end();
        return;
      }

      case 'GET': {
        if (found === null || found.isDirectory()) {
          send(response, 404, {}, 'no such blob');
          return;
        }
        response.writeHead(200, {
          'content-length': String(found.size),
          'content-type': 'application/octet-stream',
        });
        await pipeline(createReadStream(target), response);
        return;
      }

      case 'PUT': {
        if (found?.isDirectory() === true) {
          send(response, 409, {}, 'a collection is already here');
          return;
        }
        const parent = await stat(dirname(target)).catch(() => null);
        if (parent === null) {
          send(response, 409, {}, 'the parent collection does not exist');
          return;
        }
        const body = await readBody(request);

        if (options.verifyContentMd5 === true) {
          const advertised = request.headers['content-md5'];
          if (typeof advertised === 'string') {
            const actual = createHash('md5').update(body).digest('base64');
            if (actual !== advertised) {
              send(response, 400, {}, 'Content-MD5 mismatch');
              return;
            }
          }
        }
        if (options.verifyOcChecksum === true) {
          const advertised = request.headers['oc-checksum'];
          if (typeof advertised === 'string' && advertised.toUpperCase().startsWith('SHA256:')) {
            const actual = createHash('sha256').update(body).digest('hex');
            if (actual !== advertised.slice('SHA256:'.length).toLowerCase()) {
              send(response, 400, {}, 'OC-Checksum mismatch');
              return;
            }
          }
        }

        let stored =
          options.truncatePutsTo === undefined ? body : body.subarray(0, options.truncatePutsTo);
        if (options.flipPutByte !== undefined && options.flipPutByte < stored.byteLength) {
          const mutated = Buffer.from(stored);
          mutated.writeUInt8(mutated.readUInt8(options.flipPutByte) ^ 0xff, options.flipPutByte);
          stored = mutated;
        }
        await writeFile(target, stored);
        send(response, found === null ? 201 : 204);
        return;
      }

      case 'MKCOL': {
        if (options.disableMkcol === true) {
          send(response, 501, {}, 'MKCOL is not implemented here');
          return;
        }
        if (found !== null) {
          send(response, 405, {}, 'already exists');
          return;
        }
        const parent = await stat(dirname(target)).catch(() => null);
        if (parent === null) {
          send(response, 409, {}, 'the parent collection does not exist');
          return;
        }
        await mkdir(target);
        send(response, 201);
        return;
      }

      case 'MOVE': {
        if (options.disableMove === true) {
          send(response, 501, {}, 'MOVE is not implemented here');
          return;
        }
        if (found === null) {
          send(response, 404, {}, 'nothing to move');
          return;
        }
        const destinationHeader = request.headers.destination;
        if (typeof destinationHeader !== 'string') {
          send(response, 400, {}, 'MOVE needs a Destination');
          return;
        }
        const destinationUrl = new URL(destinationHeader, 'http://localhost');
        if (!destinationUrl.pathname.startsWith(mount)) {
          send(response, 502, {}, 'Destination is outside this collection');
          return;
        }
        const destination = resolveInside(root, destinationUrl.pathname.slice(mount.length) || '/');
        if (destination === null) {
          send(response, 403, {}, 'Destination escapes the served root');
          return;
        }
        const destinationParent = await stat(dirname(destination)).catch(() => null);
        if (destinationParent === null) {
          send(response, 409, {}, 'the destination parent does not exist');
          return;
        }
        const existed = (await stat(destination).catch(() => null)) !== null;
        if (existed && (request.headers.overwrite ?? 'T').toString().toUpperCase() !== 'T') {
          send(response, 412, {}, 'Destination exists and Overwrite is F');
          return;
        }
        await rename(target, destination);
        send(response, existed ? 204 : 201);
        return;
      }

      case 'DELETE': {
        if (found === null) {
          send(response, 404, {}, 'nothing to delete');
          return;
        }
        await rm(target, { recursive: true, force: true });
        send(response, 204);
        return;
      }

      case 'PROPFIND': {
        await readBody(request).catch(() => undefined);
        if (found === null) {
          send(response, 404, {}, 'no such collection');
          return;
        }
        const names = found.isDirectory() ? await readdir(target) : [];
        const base = `${mount}${url.pathname.slice(mount.length).replace(/\/+$/u, '')}`;
        const entries = [
          `<d:response><d:href>${base}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
          ...(await Promise.all(
            names.map(async (name) => {
              const child = await stat(join(target, name));
              const href = `${base}/${encodeURIComponent(name)}`;
              const type = child.isDirectory() ? '<d:collection/>' : '';
              return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${type}</d:resourcetype><d:getcontentlength>${child.size}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
            }),
          )),
        ];
        send(
          response,
          207,
          { 'content-type': 'application/xml; charset=utf-8' },
          `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`,
        );
        return;
      }

      default:
        send(response, 405, { allow: allow.join(', ') }, `${method} is not supported here`);
    }
  };

  const server: Server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      if (!response.headersSent) send(response, 500, {}, String(error));
      else response.end();
    });
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The fake server did not bind.');

  return {
    url: `http://127.0.0.1:${address.port}${mount}`,
    root,
    requests,
    setFault: (next) => {
      fault = next;
      faultsServed = 0;
    },
    corrupt: async (relativePath, bytes) => {
      await writeFile(join(root, relativePath), bytes);
    },
    close: async () => {
      // Keep-alive sockets from `undici` would otherwise hold `close` open for the agent's full
      // idle timeout and hang the test run.
      server.closeAllConnections();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
      });
      await rm(root, { recursive: true, force: true });
    },
  };
};
