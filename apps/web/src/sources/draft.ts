/**
 * A source being configured, before it is an `IngestionSource`.
 *
 * The form edits strings, because that is what inputs hold; the API takes a discriminated
 * `IngestionSourceConfig`, a consume policy and a write-only secret. This module is the whole of
 * the translation between the two, kept apart from the component so that "a WebDAV source with no
 * URL is refused before the request is made" is an assertion about a function rather than about a
 * rendered DOM.
 *
 * It is not schema validation. The server validates against the real schema and its refusal is
 * authoritative; what happens here is the smaller, local job of not sending an obviously wrong
 * request, and of saying which field is wrong while the operator is still in it.
 */
import type {
  ConsumePolicy,
  IngestionSource,
  IngestionSourceConfig,
  IngestionSourceCreate,
  IngestionSourceKind,
} from '../api/ingestion.js';

export interface SourceDraft {
  name: string;
  kind: IngestionSourceKind;
  enabled: boolean;
  /** `documents.source_kind`: a drop directory for the ADS-4700W is a folder recorded as `scanner`. */
  sourceKind: string;
  consumeMode: ConsumePolicy['mode'];
  consumeTo: string;

  /* folder */
  root: string;
  recursive: boolean;
  skipHidden: boolean;
  watch: boolean;
  /** Milliseconds a file must be unchanged before it is offered. Guards against half-written scans. */
  minimumAgeMillis: string;

  /* webdav */
  url: string;
  webdavUsername: string;
  maxDepth: string;

  /* imap */
  host: string;
  port: string;
  secure: boolean;
  imapUsername: string;
  mailbox: string;
  search: string;
  markSeen: boolean;

  /** Write-only for both WebDAV and IMAP. Empty means "leave whatever is stored alone". */
  password: string;
}

/**
 * The defaults a new source starts from.
 *
 * `consume: leave` for every kind, because it is the only policy that is safe without proof — the
 * other two move or destroy the only copy on the far side, and `@recueil/ingest-sources` refuses
 * either until the bytes have been re-read out of the content store and re-hashed.
 */
export const emptyDraft = (kind: IngestionSourceKind): SourceDraft => ({
  name: '',
  kind,
  enabled: true,
  sourceKind: kind,
  consumeMode: 'leave',
  consumeTo: kind === 'folder' ? '.processed' : kind === 'webdav' ? 'processed' : 'Archive',

  root: '',
  recursive: true,
  skipHidden: true,
  watch: true,
  minimumAgeMillis: '2000',

  url: '',
  webdavUsername: '',
  maxDepth: '8',

  host: '',
  port: '993',
  secure: true,
  imapUsername: '',
  mailbox: 'INBOX',
  search: 'UNSEEN',
  markSeen: true,

  password: '',
});

/** A stored source, back in the form. The secret is never returned, so the field starts empty. */
export const draftFromSource = (source: IngestionSource): SourceDraft => {
  const draft = emptyDraft(source.kind);
  const base: SourceDraft = {
    ...draft,
    name: source.name,
    kind: source.kind,
    enabled: source.enabled,
    sourceKind: source.sourceKind,
    consumeMode: source.consume.mode,
    consumeTo: source.consume.to ?? draft.consumeTo,
    password: '',
  };

  const config = source.config;
  switch (config.kind) {
    case 'folder':
      return {
        ...base,
        root: config.root,
        recursive: config.recursive ?? true,
        skipHidden: config.skipHidden ?? true,
        watch: config.watch ?? true,
        minimumAgeMillis: config.minimumAgeMillis === undefined ? '' : String(config.minimumAgeMillis),
      };
    case 'webdav':
      return {
        ...base,
        url: config.url,
        webdavUsername: config.username ?? '',
        recursive: config.recursive ?? true,
        maxDepth: config.maxDepth === undefined ? '8' : String(config.maxDepth),
      };
    default:
      return {
        ...base,
        host: config.host,
        port: config.port === undefined ? '993' : String(config.port),
        secure: config.secure ?? true,
        imapUsername: config.username,
        mailbox: config.mailbox ?? 'INBOX',
        search: config.search ?? 'UNSEEN',
        markSeen: config.markSeen ?? true,
      };
  }
};

export interface DraftIssue {
  field: keyof SourceDraft;
  message: string;
}

/**
 * What is obviously wrong.
 *
 * The `move` check is the one worth reading. `FolderSource.start` refuses a processed directory
 * that resolves to the watched folder itself, because a file moved there is offered again on the
 * next poll — an ingestion loop. The server will refuse it; catching the empty destination here
 * means the operator does not have to discover the rule from a 422.
 */
export const validateDraft = (draft: SourceDraft): DraftIssue[] => {
  const issues: DraftIssue[] = [];
  if (draft.name.trim() === '') issues.push({ field: 'name', message: 'Give the source a name.' });

  if (draft.consumeMode === 'move' && draft.consumeTo.trim() === '') {
    issues.push({ field: 'consumeTo', message: 'A move policy needs somewhere to move things to.' });
  }

  switch (draft.kind) {
    case 'folder': {
      if (draft.root.trim() === '') issues.push({ field: 'root', message: 'Name the directory to watch.' });
      if (draft.minimumAgeMillis.trim() !== '') {
        const age = Number(draft.minimumAgeMillis);
        if (!Number.isInteger(age) || age < 0 || age > 3_600_000) {
          issues.push({ field: 'minimumAgeMillis', message: 'A whole number of milliseconds, up to an hour.' });
        }
      }
      break;
    }
    case 'webdav': {
      const url = draft.url.trim();
      if (url === '') {
        issues.push({ field: 'url', message: 'Name the collection to poll.' });
      } else if (!/^https?:\/\//iu.test(url)) {
        issues.push({ field: 'url', message: 'The URL must start with http:// or https://.' });
      }
      const depth = Number(draft.maxDepth);
      if (!Number.isInteger(depth) || depth < 1 || depth > 16) {
        issues.push({ field: 'maxDepth', message: 'A whole number between 1 and 16.' });
      }
      break;
    }
    default: {
      if (draft.host.trim() === '') issues.push({ field: 'host', message: 'Name the mail server.' });
      if (draft.imapUsername.trim() === '') {
        issues.push({ field: 'imapUsername', message: 'A mailbox needs a user to open it as.' });
      }
      const port = Number(draft.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        issues.push({ field: 'port', message: 'A port between 1 and 65535.' });
      }
      if (draft.search.trim() === '') {
        issues.push({ field: 'search', message: 'The default is UNSEEN; ALL is right for a dedicated mailbox.' });
      }
      break;
    }
  }
  return issues;
};

const configFromDraft = (draft: SourceDraft): IngestionSourceConfig => {
  switch (draft.kind) {
    case 'folder':
      return {
        kind: 'folder',
        root: draft.root.trim(),
        recursive: draft.recursive,
        skipHidden: draft.skipHidden,
        watch: draft.watch,
        ...(draft.minimumAgeMillis.trim() === ''
          ? {}
          : { minimumAgeMillis: Number(draft.minimumAgeMillis) }),
      };
    case 'webdav':
      return {
        kind: 'webdav',
        url: draft.url.trim(),
        recursive: draft.recursive,
        maxDepth: Number(draft.maxDepth),
        ...(draft.webdavUsername.trim() === '' ? {} : { username: draft.webdavUsername.trim() }),
      };
    default:
      return {
        kind: 'imap',
        host: draft.host.trim(),
        port: Number(draft.port),
        secure: draft.secure,
        username: draft.imapUsername.trim(),
        mailbox: draft.mailbox.trim() === '' ? 'INBOX' : draft.mailbox.trim(),
        search: draft.search.trim(),
        markSeen: draft.markSeen,
      };
  }
};

/**
 * The request body.
 *
 * `secret` is omitted when the password field is blank, which is what makes "leave the stored
 * credential alone" expressible: the server documents `secret` as replacing the stored credentials
 * wholesale, so sending `{}` would clear them, and a management screen that wiped a password
 * because a field was untouched would be a trap.
 */
export const draftToCreate = (draft: SourceDraft): IngestionSourceCreate => {
  const consume: ConsumePolicy =
    draft.consumeMode === 'move'
      ? { mode: 'move', to: draft.consumeTo.trim() }
      : { mode: draft.consumeMode };

  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    sourceKind: draft.sourceKind,
    consume,
    config: configFromDraft(draft),
    ...(draft.password === '' ? {} : { secret: { password: draft.password } }),
  };
};
