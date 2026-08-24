/**
 * An in-process IMAP4rev1 server, holding messages in memory.
 *
 * It exists so that the mail path can be tested without a container and without ever pointing a
 * test at a real mailbox. The two accounts on this machine — a university one and a Bundeswehr one
 * — are not test targets, and nothing in this package may reach them: the tests connect to
 * 127.0.0.1 on a port the kernel chose.
 *
 * **What it is not:** evidence of compatibility with Dovecot, Cyrus, Exchange or Proton Bridge. It
 * implements the ten commands the source issues, in the shape RFC 3501 defines, including the one
 * that actually matters — literals in `FETCH` responses, with the response continuing after the
 * literal on the same logical line. A fake written by the same hand as the client cannot prove
 * interoperability, and the README says what would.
 *
 * What it can do that a real server cannot: hand out a subject in ISO-8859-1, or one in raw
 * undeclared UTF-8; refuse `MOVE` so the `UID COPY` fallback is exercised; and let a test read the
 * flags back to see that nothing was marked read before the ingest was verified.
 */
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

export interface FakeMessage {
  uid: number;
  flags: Set<string>;
  internalDate: string;
  raw: Buffer;
}

export interface FakeImapOptions {
  username?: string;
  password?: string;
  /** Advertise MOVE (RFC 6851). Default true. */
  move?: boolean;
  /** Advertise UIDPLUS (RFC 4315). Default true. */
  uidplus?: boolean;
}

export interface FakeImapServer {
  host: string;
  port: number;
  /** Mailbox name → its messages, in UID order. */
  readonly mailboxes: Map<string, FakeMessage[]>;
  /** Append a message and return its UID. */
  append(mailbox: string, raw: Buffer | string, flags?: readonly string[]): number;
  message(mailbox: string, uid: number): FakeMessage | undefined;
  /** Every command line the server has seen. */
  readonly commands: string[];
  close(): Promise<void>;
}

const CRLF = '\r\n';

export const startFakeImap = async (options: FakeImapOptions = {}): Promise<FakeImapServer> => {
  const username = options.username ?? 'rh';
  const password = options.password ?? 'secret';
  const mailboxes = new Map<string, FakeMessage[]>([['INBOX', []]]);
  const uidValidity = new Map<string, number>([['INBOX', 1_000]]);
  const commands: string[] = [];
  let nextUid = 1;

  const capabilities = (): string =>
    ['IMAP4rev1', options.move === false ? null : 'MOVE', options.uidplus === false ? null : 'UIDPLUS']
      .filter((value): value is string => value !== null)
      .join(' ');

  const ensure = (mailbox: string): FakeMessage[] => {
    const existing = mailboxes.get(mailbox);
    if (existing !== undefined) return existing;
    const created: FakeMessage[] = [];
    mailboxes.set(mailbox, created);
    uidValidity.set(mailbox, 1_000 + mailboxes.size);
    return created;
  };

  const append = (mailbox: string, raw: Buffer | string, flags: readonly string[] = []): number => {
    const box = ensure(mailbox);
    const uid = nextUid;
    nextUid += 1;
    box.push({
      uid,
      flags: new Set(flags),
      internalDate: '19-Aug-2026 09:14:22 +0200',
      raw: typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw,
    });
    return uid;
  };

  const headerBlock = (raw: Buffer): Buffer => {
    const separator = raw.indexOf('\r\n\r\n');
    if (separator === -1) return raw;
    return raw.subarray(0, separator + 4);
  };

  const sockets = new Set<Socket>();

  const handle = (socket: Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let authenticated = false;
    let selected: string | null = null;
    let buffer = Buffer.alloc(0);

    const write = (line: string): void => {
      socket.write(`${line}${CRLF}`);
    };
    const writeLiteral = (prefix: string, payload: Buffer, suffix: string): void => {
      socket.write(`${prefix}{${String(payload.byteLength)}}${CRLF}`);
      socket.write(payload);
      socket.write(`${suffix}${CRLF}`);
    };

    write(`* OK [CAPABILITY ${capabilities()}] fake IMAP ready`);

    const dispatch = (line: string): void => {
      commands.push(line);
      const match = /^(\S+)\s+(.*)$/su.exec(line);
      if (match === null) {
        write('* BAD nothing to do');
        return;
      }
      const tag = match[1] ?? '';
      const rest = (match[2] ?? '').trim();
      const verb = (rest.split(/\s+/u)[0] ?? '').toUpperCase();
      const argument = rest.slice(verb.length).trim();

      const box = selected === null ? null : (mailboxes.get(selected) ?? null);
      const uidOf = (raw: string): number => Number.parseInt(raw, 10);
      const unquote = (value: string): string => value.replace(/^"(.*)"$/su, '$1').replace(/\\(.)/gu, '$1');

      switch (verb) {
        case 'CAPABILITY':
          write(`* CAPABILITY ${capabilities()}`);
          write(`${tag} OK CAPABILITY done`);
          return;

        case 'LOGIN': {
          const parts = /^("(?:[^"\\]|\\.)*"|\S+)\s+("(?:[^"\\]|\\.)*"|\S+)$/su.exec(argument);
          if (parts === null) {
            write(`${tag} BAD LOGIN wants two arguments`);
            return;
          }
          if (unquote(parts[1] ?? '') !== username || unquote(parts[2] ?? '') !== password) {
            write(`${tag} NO [AUTHENTICATIONFAILED] wrong credentials`);
            return;
          }
          authenticated = true;
          write(`${tag} OK [CAPABILITY ${capabilities()}] logged in`);
          return;
        }

        case 'SELECT': {
          if (!authenticated) {
            write(`${tag} NO log in first`);
            return;
          }
          const name = unquote(argument);
          const target = mailboxes.get(name);
          if (target === undefined) {
            write(`${tag} NO [NONEXISTENT] no such mailbox`);
            return;
          }
          selected = name;
          write('* FLAGS (\\Seen \\Deleted \\Answered \\Flagged)');
          write(`* ${String(target.length)} EXISTS`);
          write('* 0 RECENT');
          write(`* OK [UIDVALIDITY ${String(uidValidity.get(name) ?? 1)}] uid validity`);
          write(`* OK [UIDNEXT ${String(nextUid)}] next uid`);
          write(`${tag} OK [READ-WRITE] selected`);
          return;
        }

        case 'CREATE': {
          const name = unquote(argument);
          if (mailboxes.has(name)) {
            write(`${tag} NO [ALREADYEXISTS] mailbox already exists`);
            return;
          }
          ensure(name);
          write(`${tag} OK created`);
          return;
        }

        case 'NOOP':
          write(`${tag} OK NOOP done`);
          return;

        case 'LOGOUT':
          write('* BYE goodbye');
          write(`${tag} OK LOGOUT done`);
          socket.end();
          return;

        case 'UID': {
          if (box === null) {
            write(`${tag} NO select a mailbox first`);
            return;
          }
          const subVerb = (argument.split(/\s+/u)[0] ?? '').toUpperCase();
          const subArgument = argument.slice(subVerb.length).trim();

          if (subVerb === 'SEARCH') {
            const criteria = subArgument.toUpperCase();
            const hits = box.filter((message) => {
              if (criteria.includes('UNSEEN')) return !message.flags.has('\\Seen');
              if (criteria.includes('SEEN')) return message.flags.has('\\Seen');
              return true;
            });
            write(`* SEARCH${hits.map((message) => ` ${String(message.uid)}`).join('')}`);
            write(`${tag} OK UID SEARCH done`);
            return;
          }

          if (subVerb === 'FETCH') {
            const [set = '', ...items] = subArgument.split(/\s+/u);
            const request = items.join(' ').toUpperCase();
            const wanted = new Set(
              set
                .split(',')
                .map((token) => uidOf(token))
                .filter((uid) => !Number.isNaN(uid)),
            );
            for (const [index, message] of box.entries()) {
              if (!wanted.has(message.uid)) continue;
              const prefix =
                `* ${String(index + 1)} FETCH (UID ${String(message.uid)} ` +
                `RFC822.SIZE ${String(message.raw.byteLength)} ` +
                `INTERNALDATE "${message.internalDate}" `;
              if (request.includes('BODY.PEEK[HEADER]') || request.includes('BODY[HEADER]')) {
                writeLiteral(`${prefix}BODY[HEADER] `, headerBlock(message.raw), ')');
              } else {
                writeLiteral(`${prefix}BODY[] `, message.raw, ')');
              }
            }
            write(`${tag} OK UID FETCH done`);
            return;
          }

          if (subVerb === 'STORE') {
            const store = /^(\d+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+\(([^)]*)\)$/iu.exec(subArgument);
            if (store === null) {
              write(`${tag} BAD UID STORE syntax`);
              return;
            }
            const uid = uidOf(store[1] ?? '');
            const mode = (store[2] ?? '').toUpperCase();
            const flags = (store[3] ?? '').split(/\s+/u).filter((flag) => flag !== '');
            const message = box.find((entry) => entry.uid === uid);
            if (message === undefined) {
              // A real server answers OK for a UID that is not there: the command applied to
              // nothing. The source relies on that being harmless when an ack is replayed.
              write(`${tag} OK UID STORE done`);
              return;
            }
            for (const flag of flags) {
              if (mode.startsWith('-')) message.flags.delete(flag);
              else message.flags.add(flag);
            }
            write(`${tag} OK UID STORE done`);
            return;
          }

          if (subVerb === 'MOVE' || subVerb === 'COPY') {
            if (subVerb === 'MOVE' && options.move === false) {
              write(`${tag} BAD MOVE is not supported here`);
              return;
            }
            const parts = /^(\d+)\s+(.+)$/su.exec(subArgument);
            if (parts === null) {
              write(`${tag} BAD ${subVerb} syntax`);
              return;
            }
            const uid = uidOf(parts[1] ?? '');
            const destination = unquote((parts[2] ?? '').trim());
            const target = mailboxes.get(destination);
            if (target === undefined) {
              write(`${tag} NO [TRYCREATE] no such mailbox`);
              return;
            }
            const position = box.findIndex((entry) => entry.uid === uid);
            const message = position === -1 ? undefined : box[position];
            if (message === undefined) {
              write(`${tag} NO no such message`);
              return;
            }
            if (subVerb === 'MOVE') {
              box.splice(position, 1);
              target.push(message);
            } else {
              target.push({ ...message, flags: new Set(message.flags) });
            }
            write(`${tag} OK ${subVerb} done`);
            return;
          }

          if (subVerb === 'EXPUNGE') {
            if (options.uidplus === false) {
              write(`${tag} BAD UID EXPUNGE needs UIDPLUS`);
              return;
            }
            const uid = uidOf(subArgument);
            const position = box.findIndex(
              (entry) => entry.uid === uid && entry.flags.has('\\Deleted'),
            );
            if (position !== -1) box.splice(position, 1);
            write(`${tag} OK UID EXPUNGE done`);
            return;
          }

          write(`${tag} BAD UID ${subVerb} is not supported here`);
          return;
        }

        default:
          write(`${tag} BAD ${verb} is not supported here`);
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end === -1) return;
        const line = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 2);
        try {
          dispatch(line);
        } catch (error) {
          write(`* BAD ${String(error)}`);
        }
      }
    });
    socket.on('error', () => undefined);
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The fake IMAP did not bind.');

  return {
    host: '127.0.0.1',
    port: address.port,
    mailboxes,
    append,
    message: (mailbox, uid) => mailboxes.get(mailbox)?.find((entry) => entry.uid === uid),
    commands,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
      });
    },
  };
};
