/**
 * An in-process IMAP server that answers exactly the four commands `test-connection` issues.
 *
 * `POST /api/v1/ingestion/sources/{id}/test-connection` on a mailbox source opens a socket, logs
 * in and selects a mailbox, and reports one row per step. Testing that against a stub of
 * `ImapClient` would prove that the route calls a stub, and testing it against a real mailbox is
 * forbidden here — the two accounts on this machine are the operator's, not test targets. So the
 * test connects to 127.0.0.1 on a port the kernel chose, and this is what answers.
 *
 * **What it is not.** It is not evidence that Recueil interoperates with Dovecot, Cyrus, Exchange
 * or Proton Bridge: it was written by the same hand as the client it is answering, so agreement
 * between them is agreement with itself. `packages/ingest-sources` owns the fuller fake — literals
 * in `FETCH`, `MOVE` and its `COPY` fallback, flag bookkeeping — and its README says what a real
 * compatibility claim would need. This one deliberately implements no `FETCH` at all: the four
 * commands are `CAPABILITY`, `LOGIN`, `SELECT` and `LOGOUT`, and anything else is answered `BAD`,
 * so a test that starts depending on more than the connection check fails here rather than
 * quietly passing against a server that cannot do it.
 */
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

export interface FakeImapOptions {
  /** The one account the server knows. Default `rh`. */
  username?: string;
  /** Default `mailbox-secret`. */
  password?: string;
  /** Mailbox name → how many messages `SELECT` should report. Default one empty `INBOX`. */
  mailboxes?: Readonly<Record<string, number>>;
}

export interface FakeImapServer {
  host: string;
  port: number;
  /** Every command line the server received, tag included. What a test asserts the client did. */
  readonly commands: string[];
  close(): Promise<void>;
}

const CRLF = '\r\n';

/** The IMAP quoted string a client sends: `"value"`, with `\"` and `\\` escaped inside. */
const unquote = (token: string): string =>
  token.startsWith('"') && token.endsWith('"')
    ? token.slice(1, -1).replace(/\\(["\\])/gu, '$1')
    : token;

/** Split a command's arguments on whitespace, keeping quoted strings whole. */
const splitArguments = (rest: string): string[] =>
  (rest.match(/"(?:[^"\\]|\\.)*"|\S+/gu) ?? []).map(unquote);

export const startFakeImap = async (options: FakeImapOptions = {}): Promise<FakeImapServer> => {
  const username = options.username ?? 'rh';
  const password = options.password ?? 'mailbox-secret';
  const mailboxes = new Map<string, number>(Object.entries(options.mailboxes ?? { INBOX: 0 }));
  const commands: string[] = [];
  const sockets = new Set<Socket>();

  const handle = (socket: Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    let authenticated = false;
    let buffer = '';

    const write = (line: string): void => {
      socket.write(`${line}${CRLF}`);
    };

    write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] fake IMAP ready');

    const dispatch = (line: string): void => {
      commands.push(line);
      const match = /^(\S+)\s+(\S+)\s*(.*)$/su.exec(line);
      if (match === null) {
        write('* BAD nothing to do');
        return;
      }
      const [, tag, verb, rest] = match as unknown as [string, string, string, string];
      const command = verb.toUpperCase();

      if (command === 'CAPABILITY') {
        write('* CAPABILITY IMAP4rev1 UIDPLUS');
        write(`${tag} OK CAPABILITY completed`);
        return;
      }

      if (command === 'LOGIN') {
        const [user, secret] = splitArguments(rest);
        if (user === username && secret === password) {
          authenticated = true;
          write(`${tag} OK [CAPABILITY IMAP4rev1 UIDPLUS] LOGIN completed`);
        } else {
          write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        }
        return;
      }

      if (command === 'SELECT') {
        if (!authenticated) {
          write(`${tag} NO Not authenticated`);
          return;
        }
        const [name] = splitArguments(rest);
        const exists = mailboxes.get(name ?? '');
        if (exists === undefined) {
          write(`${tag} NO [NONEXISTENT] Mailbox does not exist`);
          return;
        }
        write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
        write(`* ${String(exists)} EXISTS`);
        write('* 0 RECENT');
        write('* OK [UIDVALIDITY 1000] UIDs valid');
        write(`* OK [UIDNEXT ${String(exists + 1)}] Predicted next UID`);
        write(`${tag} OK [READ-WRITE] SELECT completed`);
        return;
      }

      if (command === 'LOGOUT') {
        write('* BYE fake IMAP signing off');
        write(`${tag} OK LOGOUT completed`);
        socket.end();
        return;
      }

      write(`${tag} BAD this fake answers CAPABILITY, LOGIN, SELECT and LOGOUT only`);
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf(CRLF);
        if (end === -1) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + CRLF.length);
        dispatch(line);
      }
    });
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake IMAP server did not take a port');
  }

  return {
    host: '127.0.0.1',
    port: address.port,
    commands,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
};
