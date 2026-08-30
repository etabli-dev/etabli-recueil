/**
 * As much IMAP4rev1 as a mailbox feed needs.
 *
 * Written by hand, for the reason `@recueil/ingest` gives for its MIME parser: the surface used is
 * small, and what arrives on it was composed by a stranger. Ten commands are issued — `CAPABILITY`,
 * `LOGIN`, `SELECT`, `UID SEARCH`, `UID FETCH`, `UID STORE`, `UID MOVE` (or `UID COPY` and
 * `UID EXPUNGE`), `CREATE`, `NOOP`, `LOGOUT` — and everything else the protocol can do is out of
 * scope.
 *
 * The part that is easy to get wrong, and the reason a line-splitting client is not enough: IMAP
 * responses carry **literals**. A message body arrives as `BODY[] {12345}` followed by a CRLF and
 * then exactly 12345 bytes that may contain anything at all, CRLF included, after which the *same*
 * logical response continues with its closing parenthesis. A reader that treats CRLF as a record
 * separator will read a MIME boundary as a protocol line and desynchronise, which on a mailbox full
 * of forwarded scans happens within minutes. So this reader is a small state machine: it reads a
 * line, and if the line ends in `{n}` it reads n bytes verbatim before continuing the same logical
 * response.
 *
 * Bytes are kept as bytes. A message is never decoded to a string on the way through — `Buffer` in,
 * `Buffer` out, hashed by the pipeline — because a subject in ISO-8859-1 and a PDF attachment are
 * both things a `toString()` would quietly destroy.
 *
 * **And the reader runs under a budget** (ADR-0022 §2, §5). Everything above describes a state
 * machine driven entirely by the far side: it decides when a line ends, how long a literal is, and
 * how many untagged responses one command produces. None of those had a ceiling. A server that
 * declared `BODY[] {536870912}` moved this process's resident set by 1,014 MB and was stopped only
 * by the command timeout — by which point the memory was long since committed — and one that simply
 * never sent a CRLF grew `buffer` for as long as it was allowed to. A declared literal size is
 * input, not fact, so it is used for a fast rejection and never as the bound; the bound is a
 * running total of every byte that arrives while one command is in flight, checked as the bytes
 * arrive, and passing it closes the connection with the limit named rather than filling the heap.
 */
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { ConnectionOptions as TlsOptions, TLSSocket } from 'node:tls';

import { SourceProtocolError, SourceUnavailableError } from '../errors.js';
import { DEFAULT_MAX_SOURCE_BYTES } from '../types.js';

export interface ImapClientOptions {
  host: string;
  port?: number;
  /** Implicit TLS on connect (port 993). Default true; the tests use false on loopback. */
  secure?: boolean;
  username: string;
  password: string;
  /** Per-command timeout. Default 60 s: a `FETCH` of a 40 MB attachment is not quick. */
  timeoutMillis?: number;
  /**
   * Most bytes one command's whole answer may be, literals included. Defaults to
   * `DEFAULT_MAX_SOURCE_BYTES` plus a margin for the response text around the message.
   *
   * It is one number rather than three because it has to bound three different things that all
   * cost the same memory: a line that never ends, a literal larger than the mailbox could hold, and
   * an unbounded flood of untagged responses. `ImapSource` passes its own `maxBytes` down so the
   * two agree. Exceeding it is a `SourceProtocolError` naming the limit, and the connection is
   * dropped, because a server that has already sent this much is not going to stop being asked to.
   */
  maxResponseBytes?: number;
  /**
   * Most bytes one un-terminated response line may grow to. Default 8 MiB.
   *
   * Separate from `maxResponseBytes` and far smaller, because a *line* has no legitimate reason to
   * be large: the biggest one IMAP produces is an untagged `SEARCH` listing every UID in the
   * mailbox, which is roughly a million of them at this size. A server that sends bytes and never a
   * CRLF is otherwise bounded only by the whole-response budget, which is sized for a message body
   * and is three hundred times too generous for this.
   */
  maxLineBytes?: number;
  tls?: TlsOptions;
}

/** The margin over one message for the response text, the flags and the envelope around it. */
const RESPONSE_OVERHEAD_BYTES = 32 * 1024 * 1024;
/** Roughly a million UIDs on one untagged `SEARCH` line, which is the largest legitimate one. */
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** One logical response, with its literals kept apart from its text. */
export interface ImapResponse {
  /** The response with each literal replaced by a placeholder, so it can be matched on safely. */
  text: string;
  literals: Buffer[];
}

export interface ImapMailboxStatus {
  mailbox: string;
  exists: number;
  uidValidity: string | null;
  uidNext: string | null;
  flags: string[];
}

export interface ImapMessageHead {
  uid: number;
  byteSize: number | null;
  internalDate: string | null;
  /** The raw header block, undecoded. */
  headers: Buffer;
}

/**
 * The placeholder a literal leaves in the text of a response.
 *
 * NUL, because it is the one byte a server may not send in the text part of a response, so a
 * message that contains the placeholder in its own body cannot forge one.
 */
const MARK = '\u0000';
const placeholder = (index: number): string => `${MARK}L${String(index)}${MARK}`;

export class ImapClient {
  private socket: Socket | TLSSocket | null = null;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private segments: Array<{ kind: 'text'; value: string } | { kind: 'literal'; bytes: Buffer }> = [];
  private literalRemaining = 0;
  private literalChunks: Buffer[] = [];
  private pending: {
    tag: string;
    untagged: ImapResponse[];
    resolve: (value: ImapCommandResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private greeting: ((response: ImapResponse) => void) | null = null;
  private failure: Error | null = null;
  private counter = 0;
  /** Bytes taken from the socket since the command in flight was sent. See `maxResponseBytes`. */
  private commandBytes = 0;
  private readonly capabilities = new Set<string>();

  constructor(private readonly options: ImapClientOptions) {}

  get connected(): boolean {
    return this.socket !== null && this.failure === null;
  }

  has(capability: string): boolean {
    return this.capabilities.has(capability.toUpperCase());
  }

  async connect(): Promise<void> {
    if (this.socket !== null) return;
    const port = this.options.port ?? (this.options.secure === false ? 143 : 993);

    const socket = await new Promise<Socket | TLSSocket>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => {
        rejectPromise(
          new SourceUnavailableError(
            `Could not connect to ${this.options.host}:${String(port)}: ${error.message}`,
          ),
        );
      };
      if (this.options.secure === false) {
        const plain = netConnect({ host: this.options.host, port });
        plain.once('error', onError);
        plain.once('connect', () => {
          plain.off('error', onError);
          resolvePromise(plain);
        });
      } else {
        const secure = tlsConnect({ host: this.options.host, port, ...(this.options.tls ?? {}) });
        secure.once('error', onError);
        secure.once('secureConnect', () => {
          secure.off('error', onError);
          resolvePromise(secure);
        });
      }
    });

    this.socket = socket;
    this.failure = null;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('close', () => this.fail(new SourceUnavailableError('The IMAP connection closed.')));

    const hello = await new Promise<ImapResponse>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new SourceUnavailableError('The IMAP server sent no greeting.')),
        this.options.timeoutMillis ?? 60_000,
      );
      timer.unref?.();
      this.greeting = (response) => {
        clearTimeout(timer);
        resolvePromise(response);
      };
    });
    if (!/^\*\s+(OK|PREAUTH)\b/iu.test(hello.text)) {
      throw new SourceUnavailableError(`The IMAP server refused the connection: ${hello.text}`);
    }
    this.readCapabilities(hello.text);
  }

  async login(): Promise<void> {
    if (this.capabilities.size === 0) await this.capability();
    if (this.has('LOGINDISABLED')) {
      throw new SourceUnavailableError(
        'The server advertises LOGINDISABLED, which means it wants TLS before it will take a ' +
          'password. Use port 993 with `secure: true`.',
      );
    }
    const result = await this.command(
      `LOGIN ${quoted(this.options.username)} ${quoted(this.options.password)}`,
      { label: 'LOGIN' },
    );
    if (!result.ok) {
      throw new SourceUnavailableError(`LOGIN was refused: ${result.text}`, { status: result.status });
    }
    this.readCapabilities(result.text);
    if (!this.has('IMAP4REV1')) await this.capability();
  }

  async capability(): Promise<ReadonlySet<string>> {
    const result = await this.command('CAPABILITY');
    for (const line of result.untagged) this.readCapabilities(line.text);
    this.readCapabilities(result.text);
    return this.capabilities;
  }

  async select(mailbox: string): Promise<ImapMailboxStatus> {
    const result = await this.command(`SELECT ${quoted(mailbox)}`);
    if (!result.ok) {
      throw new SourceUnavailableError(`SELECT ${mailbox} failed: ${result.text}`, {
        mailbox,
        status: result.status,
      });
    }
    const status: ImapMailboxStatus = {
      mailbox,
      exists: 0,
      uidValidity: null,
      uidNext: null,
      flags: [],
    };
    for (const line of result.untagged) {
      const exists = /^\*\s+(\d+)\s+EXISTS/iu.exec(line.text);
      if (exists !== null) status.exists = Number.parseInt(exists[1] ?? '0', 10);
      const validity = /UIDVALIDITY\s+(\d+)/iu.exec(line.text);
      if (validity !== null) status.uidValidity = validity[1] ?? null;
      const next = /UIDNEXT\s+(\d+)/iu.exec(line.text);
      if (next !== null) status.uidNext = next[1] ?? null;
      const flags = /^\*\s+FLAGS\s+\(([^)]*)\)/iu.exec(line.text);
      if (flags !== null) status.flags = (flags[1] ?? '').split(/\s+/u).filter((flag) => flag !== '');
    }
    return status;
  }

  /** `UID SEARCH`. The criteria are passed through verbatim, e.g. `UNSEEN` or `UNSEEN UID 42:*`. */
  async uidSearch(criteria: string): Promise<number[]> {
    const result = await this.command(`UID SEARCH ${criteria}`);
    if (!result.ok) throw new SourceProtocolError(`UID SEARCH ${criteria} failed: ${result.text}`);

    const uids: number[] = [];
    for (const line of result.untagged) {
      const match = /^\*\s+SEARCH\b(.*)$/iu.exec(line.text);
      if (match === null) continue;
      for (const token of (match[1] ?? '').trim().split(/\s+/u)) {
        const uid = Number.parseInt(token, 10);
        if (!Number.isNaN(uid)) uids.push(uid);
      }
    }
    return [...new Set(uids)].sort((a, b) => a - b);
  }

  /**
   * The envelope of each message, without marking anything read.
   *
   * `BODY.PEEK[HEADER]` rather than `ENVELOPE`, because the header block is raw bytes and the
   * envelope is the server's decoding of them — and servers decode RFC 2047 badly, or not at all,
   * or into a charset they do not name. The rules match on sender and subject, so the bytes are
   * fetched and decoded here, where the decoding is visible and testable.
   */
  async fetchHeads(uids: readonly number[]): Promise<ImapMessageHead[]> {
    if (uids.length === 0) return [];
    const result = await this.command(
      `UID FETCH ${uids.join(',')} (UID RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER])`,
    );
    if (!result.ok) throw new SourceProtocolError(`UID FETCH (headers) failed: ${result.text}`);

    const heads: ImapMessageHead[] = [];
    for (const line of result.untagged) {
      if (!/\bFETCH\b/iu.test(line.text)) continue;
      const uid = intItem(line.text, 'UID');
      if (uid === null) continue;
      heads.push({
        uid,
        byteSize: intItem(line.text, 'RFC822\\.SIZE'),
        internalDate: quotedItem(line.text, 'INTERNALDATE'),
        headers: sectionLiteral(line, 'HEADER') ?? Buffer.alloc(0),
      });
    }
    return heads;
  }

  /** The whole message, still unread as far as the server is concerned. */
  async fetchMessage(uid: number): Promise<Buffer | null> {
    const result = await this.command(`UID FETCH ${String(uid)} (UID BODY.PEEK[])`);
    if (!result.ok) throw new SourceProtocolError(`UID FETCH ${String(uid)} failed: ${result.text}`);
    for (const line of result.untagged) {
      if (!/\bFETCH\b/iu.test(line.text)) continue;
      if (intItem(line.text, 'UID') !== uid) continue;
      const body = sectionLiteral(line, '');
      if (body !== null) return body;
    }
    return null;
  }

  async addFlags(uid: number, flags: readonly string[]): Promise<boolean> {
    const result = await this.command(`UID STORE ${String(uid)} +FLAGS.SILENT (${flags.join(' ')})`);
    return result.ok;
  }

  async createMailbox(mailbox: string): Promise<void> {
    const result = await this.command(`CREATE ${quoted(mailbox)}`);
    // `NO [ALREADYEXISTS]`, or a plain `NO` from a server that does not send the code, is the
    // success case for an idempotent create.
    if (!result.ok && !/already ?exists/iu.test(result.text)) {
      throw new SourceProtocolError(`CREATE ${mailbox} failed: ${result.text}`);
    }
  }

  /**
   * Move one message, by UID, and say whether it was still there.
   *
   * `UID MOVE` where the server has RFC 6851, otherwise `UID COPY` + `\Deleted` + `UID EXPUNGE`.
   * The fallback deliberately refuses to run without UIDPLUS: a bare `EXPUNGE` removes *every*
   * message flagged `\Deleted` in the mailbox, including ones another client flagged, and silently
   * destroying somebody else's mail to tidy up after an ingest is not a trade this package will
   * make. Against such a server, use `consume: { mode: 'leave' }` and let the `\Seen` flag do the
   * bookkeeping.
   */
  async moveMessage(uid: number, mailbox: string): Promise<'moved' | 'absent'> {
    if (this.has('MOVE')) {
      const result = await this.command(`UID MOVE ${String(uid)} ${quoted(mailbox)}`);
      if (result.ok) return 'moved';
      if (isNoSuchMessage(result.text)) return 'absent';
      throw new SourceProtocolError(`UID MOVE ${String(uid)} failed: ${result.text}`);
    }

    if (!this.has('UIDPLUS')) {
      throw new SourceProtocolError(
        'The server has neither MOVE (RFC 6851) nor UIDPLUS (RFC 4315), so a message cannot be ' +
          'moved without an EXPUNGE that would also delete other clients\u2019 flagged messages.',
      );
    }

    const copied = await this.command(`UID COPY ${String(uid)} ${quoted(mailbox)}`);
    if (!copied.ok) {
      if (isNoSuchMessage(copied.text)) return 'absent';
      throw new SourceProtocolError(`UID COPY ${String(uid)} failed: ${copied.text}`);
    }
    await this.addFlags(uid, ['\\Deleted']);
    const expunged = await this.command(`UID EXPUNGE ${String(uid)}`);
    if (!expunged.ok) {
      throw new SourceProtocolError(`UID EXPUNGE ${String(uid)} failed: ${expunged.text}`);
    }
    return 'moved';
  }

  async noop(): Promise<boolean> {
    return (await this.command('NOOP')).ok;
  }

  async logout(): Promise<void> {
    if (this.socket === null) return;
    try {
      await this.command('LOGOUT');
    } catch {
      // A server that drops the connection on LOGOUT is behaving normally enough.
    }
    this.close();
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.removeAllListeners('close');
      socket.destroy();
    }
    if (this.pending !== null) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new SourceUnavailableError('The IMAP connection was closed.'));
      this.pending = null;
    }
  }

  /** Send one command and wait for its tagged completion. */
  async command(text: string, options: { label?: string } = {}): Promise<ImapCommandResult> {
    const socket = this.socket;
    if (socket === null || this.failure !== null) {
      throw this.failure ?? new SourceUnavailableError('The IMAP client is not connected.');
    }
    if (this.pending !== null) {
      throw new SourceProtocolError('Another IMAP command is still in flight on this connection.');
    }

    this.counter += 1;
    const tag = `R${String(this.counter).padStart(4, '0')}`;

    return new Promise<ImapCommandResult>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending = null;
        rejectPromise(
          new SourceUnavailableError(
            `The IMAP server did not answer '${options.label ?? text}' in time.`,
          ),
        );
      }, this.options.timeoutMillis ?? 60_000);
      timer.unref?.();

      this.commandBytes = 0;
      this.pending = { tag, untagged: [], resolve: resolvePromise, reject: rejectPromise, timer };
      socket.write(`${tag} ${text}\r\n`);
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* The reader                                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  private consume(chunk: Buffer): void {
    // ADR-0022 §2: the budget bounds the accumulation as it happens rather than inspecting it
    // afterwards. Everything that can grow without a ceiling — an unterminated line, a literal, a
    // flood of untagged responses — arrives through here, so one counter covers all three.
    const limit = this.maxResponseBytes();
    this.commandBytes += chunk.byteLength;
    if (this.commandBytes > limit) {
      this.fail(
        new SourceProtocolError(
          `The IMAP server sent more than ${String(limit)} bytes in answer to one command, which ` +
            'is the limit this client reads under; the connection was dropped.',
          { limit, received: this.commandBytes },
        ),
      );
      this.close();
      return;
    }

    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.literalRemaining > 0) {
        if (this.buffer.length === 0) return;
        const take = Math.min(this.literalRemaining, this.buffer.length);
        this.literalChunks.push(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.literalRemaining -= take;
        if (this.literalRemaining > 0) return;
        this.segments.push({ kind: 'literal', bytes: Buffer.concat(this.literalChunks) });
        this.literalChunks = [];
        continue;
      }

      const end = this.buffer.indexOf('\r\n');
      if (end === -1) {
        const lineLimit = this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
        if (this.buffer.length > lineLimit) {
          this.fail(
            new SourceProtocolError(
              `The IMAP server sent ${String(this.buffer.length)} bytes of one response line ` +
                `without a CRLF, over the ${String(lineLimit)}-byte limit this client reads under.`,
              { limit: lineLimit },
            ),
          );
          this.close();
        }
        return;
      }
      // `latin1`, not `utf8`: the text part of a response is ASCII, and a byte-preserving decode
      // keeps a server that sends raw 8-bit in a flag or a mailbox name from producing a
      // replacement character that would then not match itself.
      const line = this.buffer.subarray(0, end).toString('latin1');
      this.buffer = this.buffer.subarray(end + 2);

      const literal = /\{(\d+)\+?\}$/u.exec(line);
      if (literal !== null) {
        const declared = Number.parseInt(literal[1] ?? '0', 10);
        // A declared size is attacker-controlled, so it may inform a fast rejection and may never
        // be the bound (ADR-0022 §1). The running total above is the bound; this only saves the
        // trouble of reading half a gigabyte to find that out.
        if (!Number.isFinite(declared) || declared < 0 || declared > limit) {
          this.fail(
            new SourceProtocolError(
              `The IMAP server declared a ${String(declared)}-byte literal, over the ` +
                `${String(limit)}-byte limit this client reads under.`,
              { limit, declared },
            ),
          );
          this.close();
          return;
        }
        this.segments.push({ kind: 'text', value: line.slice(0, literal.index) });
        this.literalRemaining = declared;
        if (this.literalRemaining === 0) this.segments.push({ kind: 'literal', bytes: Buffer.alloc(0) });
        continue;
      }

      this.segments.push({ kind: 'text', value: line });
      this.dispatch(this.finish());
    }
  }

  private finish(): ImapResponse {
    const literals: Buffer[] = [];
    let text = '';
    for (const segment of this.segments) {
      if (segment.kind === 'text') text += segment.value;
      else {
        text += placeholder(literals.length);
        literals.push(segment.bytes);
      }
    }
    this.segments = [];
    return { text, literals };
  }

  private dispatch(response: ImapResponse): void {
    if (this.greeting !== null) {
      const notify = this.greeting;
      this.greeting = null;
      notify(response);
      return;
    }

    const pending = this.pending;
    if (pending === null) return; // Unsolicited between commands; nothing here needs it.

    const tagged = new RegExp(`^${pending.tag}\\s+(OK|NO|BAD)\\b(.*)$`, 'iu').exec(response.text);
    if (tagged === null) {
      pending.untagged.push(response);
      return;
    }

    clearTimeout(pending.timer);
    this.pending = null;
    this.commandBytes = 0;
    const status = (tagged[1] ?? '').toUpperCase();
    pending.resolve({
      ok: status === 'OK',
      status,
      text: (tagged[2] ?? '').trim(),
      untagged: pending.untagged,
    });
  }

  private fail(error: Error): void {
    this.failure = error;
    if (this.pending !== null) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    if (this.greeting !== null) {
      const notify = this.greeting;
      this.greeting = null;
      notify({ text: `* BAD ${error.message}`, literals: [] });
    }
  }

  private maxResponseBytes(): number {
    return this.options.maxResponseBytes ?? DEFAULT_MAX_SOURCE_BYTES + RESPONSE_OVERHEAD_BYTES;
  }

  private readCapabilities(text: string): void {
    const match = /CAPABILITY\s+([^\]]*)/iu.exec(text);
    if (match === null) return;
    for (const token of (match[1] ?? '').split(/\s+/u)) {
      if (token.trim() !== '') this.capabilities.add(token.trim().toUpperCase());
    }
  }
}

export interface ImapCommandResult {
  ok: boolean;
  status: string;
  text: string;
  untagged: ImapResponse[];
}

/* --------------------------------------------------------------------------------------------- */
/* Response reading                                                                                */
/* --------------------------------------------------------------------------------------------- */

const quoted = (value: string): string => `"${value.replace(/(["\\])/gu, '\\$1')}"`;

const intItem = (text: string, name: string): number | null => {
  const match = new RegExp(`\\b${name}\\s+(\\d+)`, 'iu').exec(text);
  if (match === null) return null;
  const value = Number.parseInt(match[1] ?? '', 10);
  return Number.isNaN(value) ? null : value;
};

const quotedItem = (text: string, name: string): string | null => {
  const match = new RegExp(`\\b${name}\\s+"([^"]*)"`, 'iu').exec(text);
  return match === null ? null : (match[1] ?? null);
};

/**
 * The literal that followed `BODY[<section>]` in a FETCH response.
 *
 * The section is matched exactly — `BODY[]` and `BODY[HEADER]` are different answers to different
 * questions, and taking the first literal in the response would confuse them the moment a server
 * answers a two-part FETCH in one line.
 */
const sectionLiteral = (response: ImapResponse, section: string): Buffer | null => {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`BODY\\[${escaped}\\](?:<\\d+>)?\\s*${MARK}L(\\d+)${MARK}`, 'iu');
  const match = pattern.exec(response.text);
  if (match === null) return null;
  const index = Number.parseInt(match[1] ?? '', 10);
  return response.literals[index] ?? null;
};

const isNoSuchMessage = (text: string): boolean =>
  /(no such message|does not exist|not found|TRYCREATE)/iu.test(text);
