/**
 * Where the server is allowed to send a request of its own, and how that is enforced.
 *
 * An ingestion source is an address a *caller* chose. `POST /ingestion/sources` takes a URL out of
 * a request body and the server then connects to it — with `ingestion:write`, and, on the default
 * `RECUEIL_REQUIRE_AUTH=false`, with nothing at all. That is server-side request forgery in the
 * plainest form the pattern has: the Phase 2 review pointed a WebDAV source at
 * `http://127.0.0.1:<port>/latest/meta-data/`, got a 201, and then got the internal service's
 * response body back in the `detail` of a `test-connection` check, because `WebDavClient` folds up
 * to 200 characters of the far side's answer into its protocol error. The library's own loopback
 * services, a cloud metadata endpoint and every RFC 1918 address on the operator's network were all
 * one configuration form away.
 *
 * **The address is resolved by the socket, so the socket is where the rule has to run.** Checking
 * the hostname when the configuration is saved stops nothing: DNS is the attacker's to answer, and
 * a name that resolves to a public address while the form is being validated can resolve to
 * `127.0.0.1` a second later — classic DNS rebinding. So `EgressGuard.fetch` does not merely look
 * the name up before it calls out; it hands the connection a `lookup` of its own, refuses inside
 * that callback, and returns the *checked* address to the connector. There is no second resolution
 * for a rebind to win, because the address the guard approved is the address the socket dials.
 * `checkAtConfigTime` still runs at the form, because refusing `http://127.0.0.1/` while somebody
 * is typing it is better than refusing it an hour later inside a job — but it is the friendly half,
 * never the enforcing one.
 *
 * **Deliberately internal targets are an opt-in, off by default.** A NAS on 192.168.1.x is a
 * perfectly ordinary thing to point a WebDAV source at, and a rule that cannot express it would be
 * turned off wholesale. `RECUEIL_INGEST_ALLOW_PRIVATE_TARGETS=true` is the operator saying so once,
 * for the whole server, in a place an operator controls and a request body does not.
 *
 * **The response is read under a budget** (ADR-0022). The far side is untrusted by construction, so
 * the body is counted as it arrives and the request is destroyed at the ceiling rather than after
 * the buffer has been materialised; a `Content-Encoding` the server sent anyway is inflated with an
 * explicit `maxOutputLength`. Neither limit is computed from anything the far side declared.
 */
import { gunzipSync, inflateSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import { ValidationError } from '@recueil/core';

/** One address a name resolved to. Mirrors the shape `dns.lookup(…, { all: true })` returns. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** Resolve a hostname to every address it has. Injected by the tests that stage a rebind. */
export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface EgressGuardOptions {
  /**
   * `RECUEIL_INGEST_ALLOW_PRIVATE_TARGETS`. Off by default: the operator has to say that reaching
   * their own network is what they meant.
   */
  readonly allowPrivateTargets?: boolean;
  /** Swapped by the tests, so a rebinding can be staged without owning a domain. */
  readonly resolve?: HostResolver;
  /** Swapped by the tests that speak to an in-process fake rather than a socket. */
  readonly fetch?: typeof fetch;
  /** ADR-0022: the ceiling on one response body. Default 128 MiB. */
  readonly maxResponseBytes?: number;
}

/** The default response ceiling: large enough for a scanned volume, small enough to notice. */
export const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

/**
 * Refused because of where it points, rather than because of what happened when we got there.
 *
 * Its own class so a caller can tell "this address is not allowed" from "that server is down"; the
 * message names the range, because a refusal an operator cannot act on is an outage they will
 * resolve by turning the check off.
 */
export class EgressBlockedError extends Error {
  readonly hostname: string;

  readonly address: string;

  readonly range: string;

  constructor(hostname: string, address: string, range: string) {
    super(
      `'${hostname}' resolves to ${address}, which is in the ${range} range. Recueil will not ` +
        'send a request there: a source URL comes from a request body, so an address inside this ' +
        'machine or this network is a way to make the server read something the caller cannot. ' +
        'Set RECUEIL_INGEST_ALLOW_PRIVATE_TARGETS=true if reaching it is deliberate.',
    );
    this.name = 'EgressBlockedError';
    this.hostname = hostname;
    this.address = address;
    this.range = range;
  }
}

export class EgressGuard {
  readonly allowPrivateTargets: boolean;

  readonly #resolve: HostResolver;

  readonly #inner: typeof fetch | undefined;

  readonly #maxResponseBytes: number;

  constructor(options: EgressGuardOptions = {}) {
    this.allowPrivateTargets = options.allowPrivateTargets ?? false;
    this.#resolve = options.resolve ?? systemResolver;
    this.#inner = options.fetch;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  /**
   * The friendly half: refuse an address that is already, on the evidence available now, internal.
   *
   * A name that does not resolve is *not* refused here. A home NAS whose DNS is momentarily down is
   * an ordinary thing to be configuring, and a configuration form that refuses it teaches an
   * operator to distrust the check. Nothing is admitted by this method — the connection is where
   * admission is decided.
   */
  async checkAtConfigTime(raw: string, path: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ValidationError(`'${raw}' is not a URL.`, { path });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ValidationError(
        `The target must be http or https; '${url.protocol}' is neither.`,
        { path },
      );
    }
    if (this.allowPrivateTargets) return url;

    const hostname = bareHostname(url);
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.addressesOf(hostname);
    } catch {
      // Unresolvable today, possibly resolvable tonight. The connection will decide.
      return url;
    }
    const blocked = firstBlocked(addresses);
    if (blocked !== null) {
      throw new ValidationError(
        new EgressBlockedError(hostname, blocked.address, blocked.range).message,
        { path },
      );
    }
    return url;
  }

  /**
   * The strict form, for a caller that is about to hand this address to a transport of its own.
   *
   * `checkAtConfigTime` forgives a name that will not resolve, because a configuration form is not
   * the place to refuse a NAS whose DNS is down. This one does not: it is called immediately before
   * a connection, where an unresolvable name is a failure regardless, and where "we could not check"
   * must not read as "it is fine". It is what an S3 endpoint gets, because the AWS SDK owns its own
   * sockets and there is no `lookup` to hand it — see `StorageBackendService.buildBackend`.
   */
  async assertAllowedTarget(raw: string, path: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ValidationError(`'${raw}' is not a URL.`, { path });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ValidationError(`The target must be http or https; '${url.protocol}' is neither.`, {
        path,
      });
    }
    if (this.allowPrivateTargets) return url;

    const hostname = bareHostname(url);
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.addressesOf(hostname);
    } catch (error) {
      throw new ValidationError(
        `'${hostname}' could not be resolved, so Recueil cannot tell whether it is an address it ` +
          `is allowed to reach: ${error instanceof Error ? error.message : String(error)}`,
        { path },
      );
    }
    const blocked = firstBlocked(addresses);
    if (blocked !== null) {
      throw new ValidationError(
        new EgressBlockedError(hostname, blocked.address, blocked.range).message,
        { path },
      );
    }
    return url;
  }

  /**
   * The enforcing half, as a `fetch`.
   *
   * Two things happen that a plain `fetch` does not do. The name is checked before the request, so
   * the refusal has a decent message; and, on the real socket path, the connection is given a
   * `lookup` that checks and then *returns the checked address*, so the address the socket dials is
   * the address that was approved. A test-injected `fetch` cannot be pinned that way — there is no
   * socket — so for that path the pre-request check is the whole of it, which is exactly the
   * property the rebinding test drives.
   */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new EgressBlockedError(bareHostname(url), url.protocol, 'unsupported scheme');
    }
    if (!this.allowPrivateTargets) {
      const hostname = bareHostname(url);
      const blocked = firstBlocked(await this.addressesOf(hostname));
      if (blocked !== null) throw new EgressBlockedError(hostname, blocked.address, blocked.range);
    }
    if (this.#inner !== undefined) return this.#inner(input, init);
    return nodeFetch(url, init, this.#lookup(), this.#maxResponseBytes);
  };

  /** Every address `hostname` has, with an IP literal standing for itself. */
  private async addressesOf(hostname: string): Promise<readonly ResolvedAddress[]> {
    const literal = isIP(hostname);
    if (literal !== 0) return [{ address: hostname, family: literal }];
    const addresses = await this.#resolve(hostname);
    if (addresses.length === 0) {
      throw new Error(`'${hostname}' resolved to no addresses.`);
    }
    return addresses;
  }

  /**
   * The `lookup` the socket is given: the same rule, run where the connection is actually made.
   *
   * `node:net` calls this instead of `dns.lookup`, connects to whatever comes back, and never asks
   * again. That is what closes the rebinding window rather than narrowing it.
   */
  #lookup(): LookupFunction {
    const allowPrivate = this.allowPrivateTargets;
    const addressesOf = async (hostname: string): Promise<readonly ResolvedAddress[]> =>
      await this.addressesOf(hostname);
    return (hostname, options, callback) => {
      // The same resolver the check used, deliberately: one seam, so a test that stages an answer
      // stages the answer the *socket* gets, and the production default is `dns.lookup` either way.
      addressesOf(hostname).then(
        (found) => {
          if (!allowPrivate) {
            const blocked = firstBlocked(found);
            if (blocked !== null) {
              callback(new EgressBlockedError(hostname, blocked.address, blocked.range), '', 0);
              return;
            }
          }
          // The block test looks at every answer; what is handed back is narrowed to the family
          // the connector asked for, so a v6-only socket is not given a v4 address to dial.
          const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
          const usable = wanted === 0 ? found : found.filter((one) => one.family === wanted);
          if (options.all === true) {
            (callback as unknown as (e: null, a: readonly ResolvedAddress[]) => void)(null, usable);
            return;
          }
          const first = usable[0];
          if (first === undefined) {
            callback(new Error(`'${hostname}' resolved to no usable addresses.`), '', 0);
            return;
          }
          callback(null, first.address, first.family);
        },
        (error: unknown) => {
          callback(error instanceof Error ? error : new Error(String(error)), '', 0);
        },
      );
    };
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Address ranges                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * The range `address` belongs to, or `null` when it is an ordinary globally routable address.
 *
 * Exported because it is the whole rule and a rule nobody can read is a rule nobody can audit. The
 * families are listed by what they mean rather than by CIDR alone, so a refusal says something an
 * operator recognises.
 */
export const addressRange = (address: string): string | null => {
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIpv4(address);
    return octets === null ? 'unparseable' : ipv4Range(octets);
  }
  if (family === 6) {
    const groups = expandIpv6(address);
    return groups === null ? 'unparseable' : ipv6Range(groups);
  }
  return 'unparseable';
};

const firstBlocked = (
  addresses: readonly ResolvedAddress[],
): { address: string; range: string } | null => {
  for (const candidate of addresses) {
    const range = addressRange(candidate.address);
    if (range !== null) return { address: candidate.address, range };
  }
  return null;
};

const parseIpv4 = (address: string): number[] | null => {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
};

const ipv4Range = (octets: number[]): string | null => {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0) return 'unspecified (0.0.0.0/8)';
  if (a === 10) return 'private (10/8)';
  if (a === 127) return 'loopback (127/8)';
  if (a === 169 && b === 254) return 'link-local (169.254/16)';
  if (a === 172 && b >= 16 && b <= 31) return 'private (172.16/12)';
  if (a === 192 && b === 168) return 'private (192.168/16)';
  if (a === 192 && b === 0 && c === 0) return 'IETF protocol assignments (192.0.0/24)';
  if (a === 192 && b === 0 && c === 2) return 'documentation (192.0.2/24)';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking (198.18/15)';
  if (a === 198 && b === 51 && c === 100) return 'documentation (198.51.100/24)';
  if (a === 203 && b === 0 && c === 113) return 'documentation (203.0.113/24)';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT (100.64/10)';
  if (a >= 224 && a <= 239) return 'multicast (224/4)';
  if (a >= 240) return 'reserved (240/4)';
  return null;
};

/** Expand an IPv6 literal — `::` included, embedded IPv4 included — to eight 16-bit groups. */
const expandIpv6 = (address: string): number[] | null => {
  let text = address;
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  // `::ffff:192.0.2.1` and friends: fold the dotted tail into two hex groups first.
  const lastColon = text.lastIndexOf(':');
  if (lastColon >= 0 && text.slice(lastColon + 1).includes('.')) {
    const octets = parseIpv4(text.slice(lastColon + 1));
    if (octets === null) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === undefined || halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? (halves[1] as string).split(':') : [];

  let parts: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    parts = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    parts = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  }

  const groups: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/iu.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
};

const ipv6Range = (groups: number[]): string | null => {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  if (groups.every((group) => group === 0)) return 'unspecified (::)';
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return 'loopback (::1)';
  }
  // IPv4-mapped, IPv4-compatible and NAT64 all carry an IPv4 address that is the real destination.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return ipv4Range(embeddedIpv4(g6, g7)) ?? null;
  }
  if (g0 === 0x64 && g1 === 0xff9b) return ipv4Range(embeddedIpv4(g6, g7)) ?? null;
  // 6to4 carries the IPv4 address it tunnels to in the two groups after the prefix.
  if (g0 === 0x2002) return ipv4Range(embeddedIpv4(g1, g2)) ?? null;
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return 'discard-only (100::/64)';
  if (g0 === 0x2001 && g1 === 0x0db8) return 'documentation (2001:db8::/32)';
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local (fe80::/10)';
  if ((g0 & 0xfe00) === 0xfc00) return 'unique-local (fc00::/7)';
  if ((g0 & 0xff00) === 0xff00) return 'multicast (ff00::/8)';
  return null;
};

const embeddedIpv4 = (high: number, low: number): number[] => [
  (high >> 8) & 0xff,
  high & 0xff,
  (low >> 8) & 0xff,
  low & 0xff,
];

/* -------------------------------------------------------------------------------------------- */
/* The request itself                                                                              */
/* -------------------------------------------------------------------------------------------- */

type LookupFunction = (
  hostname: string,
  options: { family?: number; hints?: number; all?: boolean },
  callback: (error: Error | null, address: string, family: number) => void,
) => void;

const systemResolver: HostResolver = async (hostname) =>
  await new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error !== null) reject(error);
      else resolve(addresses as unknown as ResolvedAddress[]);
    });
  });

const requestUrl = (input: Parameters<typeof fetch>[0]): URL => {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
};

/** `URL.hostname` keeps the brackets on an IPv6 literal; nothing else wants them. */
const bareHostname = (url: URL): string =>
  url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;

/**
 * `fetch`, over `node:http`, so that the connection can be given a `lookup`.
 *
 * Node's global `fetch` is undici's, and undici's dispatcher — the only place a `lookup` could be
 * installed — is not reachable from the standard library. This is deliberately the smallest client
 * that `WebDavClient` needs: arbitrary methods, one string body, no redirect following (`node:http`
 * does not follow, which is what `redirect: 'manual'` asks for), and a bounded read.
 */
const nodeFetch = async (
  url: URL,
  init: RequestInit | undefined,
  lookup: LookupFunction,
  maxResponseBytes: number,
): Promise<Response> => {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { 'accept-encoding': 'identity' };
  new Headers(init?.headers ?? {}).forEach((value, name) => {
    headers[name] = value;
  });

  const body = init?.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new TypeError('The egress guard sends string bodies only.');
  }
  if (typeof body === 'string') {
    headers['content-length'] = String(Buffer.byteLength(body, 'utf8'));
  }

  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const signal = init?.signal ?? undefined;

  return await new Promise<Response>((resolve, reject) => {
    const request = send(
      url,
      {
        method,
        headers,
        lookup: lookup as never,
        ...(signal === undefined || signal === null ? {} : { signal }),
      },
      (message: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let total = 0;
        message.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > maxResponseBytes) {
            message.destroy(
              new Error(
                `the response body passed the ${String(maxResponseBytes)}-byte egress ceiling ` +
                  '(RECUEIL_INGEST_MAX_EGRESS_BYTES)',
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        message.on('error', reject);
        message.on('end', () => {
          try {
            resolve(toResponse(message, chunks, method, maxResponseBytes));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    request.on('error', reject);
    if (typeof body === 'string') request.write(body);
    request.end();
  });
};

const toResponse = (
  message: IncomingMessage,
  chunks: Buffer[],
  method: string,
  maxResponseBytes: number,
): Response => {
  const status = message.statusCode ?? 0;
  if (status < 200) {
    throw new Error(`the server answered ${String(status)}, which is not a final status.`);
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, single);
      } catch {
        /* a header Node accepted that `Headers` will not; dropping it is safer than throwing */
      }
    }
  }

  const empty = method === 'HEAD' || status === 204 || status === 205 || status === 304;
  if (empty) return new Response(null, { status, headers });

  const encoding = (message.headers['content-encoding'] ?? '').toString().trim().toLowerCase();
  const raw = Buffer.concat(chunks);
  const decoded = encoding === '' || encoding === 'identity' ? raw : inflateBody(raw, encoding, maxResponseBytes);
  // The length now describes what the caller will read, not what arrived on the wire.
  headers.delete('content-encoding');
  headers.set('content-length', String(decoded.byteLength));
  return new Response(decoded, { status, headers });
};

/** ADR-0022: `maxOutputLength` on the call, never a length check after the buffer exists. */
const inflateBody = (raw: Buffer, encoding: string, maxOutputLength: number): Buffer => {
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(raw, { maxOutputLength });
    if (encoding === 'deflate') return inflateSync(raw, { maxOutputLength });
    if (encoding === 'br') {
      return brotliDecompressSync(raw, {
        maxOutputLength,
        params: { [zlibConstants.BROTLI_PARAM_LARGE_WINDOW]: 0 },
      });
    }
  } catch (error) {
    throw new Error(
      `the ${encoding} response body could not be read within the ${String(maxOutputLength)}-byte ` +
        `egress ceiling: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throw new Error(`the server answered with an unsupported Content-Encoding: ${encoding}`);
};
