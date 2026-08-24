/**
 * An in-process WebDAV server that serves a directory as a *feed*.
 *
 * **What this is not.** It is not evidence that `WebDavSource` works against Nextcloud, ownCloud or
 * `mod_dav`. It answers the six methods the feed uses in the shape RFC 4918 defines, and it can be
 * told to misbehave; a fake written by the same hand as the client cannot prove compatibility with
 * a third party, and one of the carried findings from the Phase 1 review is that a compatibility
 * claim needs a captured fixture from the real thing. `README.md` says so as well, and says what
 * would have to be captured to make the claim.
 *
 * What it is good for is everything a container is bad at: an ETag that changes between the poll
 * and the `GET`, a listing that names a path outside its own collection, a server that answers
 * `MOVE` with 501. Those are the cases the source has to get right and they are unreachable
 * against a real server.
 *
 * `@recueil/storage-backends` has a fake WebDAV server too. That one serves a content-addressed
 * *store* — it needs no ETags and no `Last-Modified`, and its `PROPFIND` does not report them. This
 * one is a share somebody drops files into. They are different fixtures for different contracts and
 * sharing them would mean neither being right.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface FakeWebDavOptions {
  /** Path the collection is served under. Default `/dav`. */
  mount?: string;
  auth?: { username: string; password: string };
  /** Answer MOVE with 501, like a server that only does PUT and DELETE. */
  disableMove?: boolean;
  /** Leave `getetag` out of every PROPFIND answer, so the source falls back to size and mtime. */
  omitEtags?: boolean;
  /** Insert this literal `<d:response>` into every listing. For the hostile-href test. */
  injectResponse?: string;
}

export interface FakeWebDavServer {
  url: string;
  root: string;
  readonly requests: Array<{ method: string; path: string }>;
  /** Write a file into the served tree, as a person or a sync client would. */
  put(relativePath: string, bytes: Buffer | string): Promise<void>;
  /** What is in the tree now, relative paths, sorted. */
  list(): Promise<string[]>;
  read(relativePath: string): Promise<Buffer>;
  exists(relativePath: string): Promise<boolean>;
  close(): Promise<void>;
}

const send = (
  response: ServerResponse,
  status: number,
  headers: Record<string, string> = {},
  body: string | Buffer = '',
): void => {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  response.writeHead(status, { 'content-length': String(payload.byteLength), ...headers });
  response.end(payload);
};

const inside = (root: string, requestPath: string): string | null => {
  const decoded = decodeURIComponent(requestPath).replace(/\/+$/u, '');
  const target = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel.split(sep).includes('..')) return null;
  return target;
};

const etagOf = (bytes: Buffer, mtimeMs: number): string =>
  `"${createHash('sha1').update(bytes).update(String(Math.trunc(mtimeMs))).digest('hex').slice(0, 20)}"`;

export const startFakeWebDav = async (
  options: FakeWebDavOptions = {},
): Promise<FakeWebDavServer> => {
  const mount = options.mount ?? '/dav';
  const root = mkdtempSync(join(tmpdir(), 'recueil-webdav-feed-'));
  const requests: Array<{ method: string; path: string }> = [];

  const authorised = (request: IncomingMessage): boolean => {
    if (options.auth === undefined) return true;
    const header = request.headers.authorization ?? '';
    const expected = `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`, 'utf8').toString('base64')}`;
    return header === expected;
  };

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = (request.method ?? 'GET').toUpperCase();
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({ method, path: url.pathname });

    if (!url.pathname.startsWith(mount)) {
      send(response, 404, {}, 'not this collection');
      return;
    }
    if (!authorised(request)) {
      send(response, 401, { 'www-authenticate': 'Basic realm="fake"' }, 'unauthorised');
      return;
    }

    const target = inside(root, url.pathname.slice(mount.length) || '/');
    if (target === null) {
      send(response, 403, {}, 'the path escapes the served root');
      return;
    }
    const found = await stat(target).catch(() => null);

    switch (method) {
      case 'OPTIONS': {
        const allow = ['OPTIONS', 'HEAD', 'GET', 'PUT', 'DELETE', 'PROPFIND', 'MKCOL'];
        if (options.disableMove !== true) allow.push('MOVE');
        send(response, 200, { dav: '1, 2, 3', allow: allow.join(', ') });
        return;
      }

      case 'GET': {
        if (found === null || found.isDirectory()) {
          send(response, 404, {}, 'no such file');
          return;
        }
        const bytes = await readFile(target);
        send(
          response,
          200,
          {
            'content-type': 'application/octet-stream',
            etag: etagOf(bytes, found.mtimeMs),
            'last-modified': new Date(found.mtimeMs).toUTCString(),
          },
          bytes,
        );
        return;
      }

      case 'PUT': {
        await mkdir(dirname(target), { recursive: true });
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        await writeFile(target, Buffer.concat(chunks));
        send(response, found === null ? 201 : 204);
        return;
      }

      case 'MKCOL': {
        if (found !== null) {
          send(response, 405, {}, 'already there');
          return;
        }
        await mkdir(target, { recursive: true });
        send(response, 201);
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
        const destinationUrl = new URL(destinationHeader, 'http://127.0.0.1');
        if (!destinationUrl.pathname.startsWith(mount)) {
          send(response, 502, {}, 'the destination is outside this collection');
          return;
        }
        const destination = inside(root, destinationUrl.pathname.slice(mount.length) || '/');
        if (destination === null) {
          send(response, 403, {}, 'the destination escapes the served root');
          return;
        }
        const exists = (await stat(destination).catch(() => null)) !== null;
        if (exists && (request.headers.overwrite ?? 'T').toString().toUpperCase() !== 'T') {
          send(response, 412, {}, 'the destination exists and Overwrite is F');
          return;
        }
        await mkdir(dirname(destination), { recursive: true });
        await rename(target, destination);
        send(response, exists ? 204 : 201);
        return;
      }

      case 'PROPFIND': {
        for await (const _chunk of request) void _chunk;
        if (found === null) {
          send(response, 404, {}, 'no such collection');
          return;
        }
        const depth = (request.headers.depth ?? '1').toString();
        const base = `${mount}${url.pathname.slice(mount.length).replace(/\/+$/u, '')}`;

        const self =
          `<d:response><d:href>${base}/</d:href><d:propstat><d:prop>` +
          '<d:resourcetype><d:collection/></d:resourcetype>' +
          `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

        const children: string[] = [];
        if (found.isDirectory() && depth !== '0') {
          for (const name of (await readdir(target)).sort()) {
            const child = await stat(join(target, name));
            const href = `${base}/${encodeURIComponent(name)}`;
            if (child.isDirectory()) {
              children.push(
                `<d:response><d:href>${href}/</d:href><d:propstat><d:prop>` +
                  '<d:resourcetype><d:collection/></d:resourcetype>' +
                  `<d:getlastmodified>${new Date(child.mtimeMs).toUTCString()}</d:getlastmodified>` +
                  '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
              );
              continue;
            }
            const bytes = await readFile(join(target, name));
            const etag =
              options.omitEtags === true ? '' : `<d:getetag>${etagOf(bytes, child.mtimeMs)}</d:getetag>`;
            children.push(
              `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
                '<d:resourcetype/>' +
                `<d:getcontentlength>${String(child.size)}</d:getcontentlength>` +
                `<d:getlastmodified>${new Date(child.mtimeMs).toUTCString()}</d:getlastmodified>` +
                '<d:getcontenttype>application/octet-stream</d:getcontenttype>' +
                etag +
                '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>' +
                // A second propstat, the way a real server reports a property it does not have.
                '<d:propstat><d:prop><d:quota-used-bytes/></d:prop>' +
                '<d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>',
            );
          }
        }

        send(
          response,
          207,
          { 'content-type': 'application/xml; charset=utf-8' },
          `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${self}${children.join('')}${options.injectResponse ?? ''}</d:multistatus>`,
        );
        return;
      }

      default:
        send(response, 405, {}, `${method} is not supported here`);
    }
  };

  const server: Server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      if (!response.headersSent) send(response, 500, {}, String(error));
      else response.end();
    });
  });

  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The fake server did not bind.');

  const walk = async (directory: string, prefix: string, into: string[]): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path, into);
      else into.push(path);
    }
  };

  return {
    url: `http://127.0.0.1:${String(address.port)}${mount}`,
    root,
    requests,
    put: async (relativePath, bytes) => {
      const path = join(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
    },
    list: async () => {
      const into: string[] = [];
      await walk(root, '', into);
      return into;
    },
    read: async (relativePath) => readFile(join(root, relativePath)),
    exists: async (relativePath) => (await stat(join(root, relativePath)).catch(() => null)) !== null,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
      });
      rmSync(root, { recursive: true, force: true });
    },
  };
};
