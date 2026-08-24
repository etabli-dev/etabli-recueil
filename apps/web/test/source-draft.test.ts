/**
 * The source form's model.
 *
 * Two behaviours are worth pinning down here rather than through a rendered form: what the request
 * body looks like for each kind, and — the one with security consequences — that a blank password
 * field means "leave the stored credential alone" rather than "clear it". The server documents
 * `secret` as replacing the stored credentials wholesale, so an omitted key and an empty object are
 * two different instructions.
 */
import { describe, expect, it } from 'vitest';

import { draftFromSource, draftToCreate, emptyDraft, validateDraft } from '../src/sources/draft.js';
import { folderSource } from './ingestion-fixtures.js';

describe('emptyDraft', () => {
  it('starts every kind on the only consume policy that destroys nothing', () => {
    for (const kind of ['folder', 'webdav', 'imap'] as const) {
      expect(emptyDraft(kind).consumeMode).toBe('leave');
    }
  });
});

describe('validateDraft', () => {
  it('accepts a complete folder source', () => {
    expect(validateDraft({ ...emptyDraft('folder'), name: 'Scans', root: '/srv/consume' })).toEqual([]);
  });

  it('refuses a folder source with no directory', () => {
    expect(validateDraft({ ...emptyDraft('folder'), name: 'Scans' }).map((issue) => issue.field)).toContain('root');
  });

  it('refuses a move policy with nowhere to move to', () => {
    const issues = validateDraft({
      ...emptyDraft('folder'),
      name: 'Scans',
      root: '/srv/consume',
      consumeMode: 'move',
      consumeTo: '   ',
    });
    expect(issues.map((issue) => issue.field)).toContain('consumeTo');
  });

  it('refuses a WebDAV URL that is not one', () => {
    const issues = validateDraft({ ...emptyDraft('webdav'), name: 'Nextcloud', url: 'cloud.example.org/Scans' });
    expect(issues.map((issue) => issue.field)).toContain('url');
  });

  it('refuses a depth the server would reject', () => {
    const issues = validateDraft({
      ...emptyDraft('webdav'),
      name: 'Nextcloud',
      url: 'https://cloud.example.org/Scans',
      maxDepth: '64',
    });
    expect(issues.map((issue) => issue.field)).toContain('maxDepth');
  });

  it('refuses a mailbox with no user or an impossible port', () => {
    const issues = validateDraft({ ...emptyDraft('imap'), name: 'Mail', host: 'mail.example.org', port: '70000' });
    expect(issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(['imapUsername', 'port']));
  });
});

describe('draftToCreate', () => {
  it('builds a folder body with the discriminated config the API takes', () => {
    const body = draftToCreate({
      ...emptyDraft('folder'),
      name: 'Scanner drop',
      sourceKind: 'scanner',
      root: '/srv/consume',
      consumeMode: 'move',
      consumeTo: '.processed',
      minimumAgeMillis: '2000',
    });
    expect(body).toEqual({
      name: 'Scanner drop',
      enabled: true,
      sourceKind: 'scanner',
      consume: { mode: 'move', to: '.processed' },
      config: {
        kind: 'folder',
        root: '/srv/consume',
        recursive: true,
        skipHidden: true,
        watch: true,
        minimumAgeMillis: 2000,
      },
    });
  });

  it('builds an IMAP body with the mailbox and the search criteria', () => {
    const body = draftToCreate({
      ...emptyDraft('imap'),
      name: 'Scanner mail',
      host: 'mail.example.org',
      imapUsername: 'scans',
      search: 'ALL',
    });
    expect(body.config).toEqual({
      kind: 'imap',
      host: 'mail.example.org',
      port: 993,
      secure: true,
      username: 'scans',
      mailbox: 'INBOX',
      search: 'ALL',
      markSeen: true,
    });
  });

  it('omits the secret entirely when the password field is blank', () => {
    const body = draftToCreate({ ...emptyDraft('imap'), name: 'Mail', host: 'mail.example.org', imapUsername: 'rh' });
    expect(body).not.toHaveProperty('secret');
  });

  it('sends a typed password as the write-only secret', () => {
    const body = draftToCreate({
      ...emptyDraft('imap'),
      name: 'Mail',
      host: 'mail.example.org',
      imapUsername: 'rh',
      password: 'hunter2',
    });
    expect(body.secret).toEqual({ password: 'hunter2' });
  });
});

describe('draftFromSource', () => {
  it('round-trips a stored source back into the form', () => {
    const draft = draftFromSource(folderSource());
    expect(draft.name).toBe('Scanner drop');
    expect(draft.root).toBe('/srv/consume');
    expect(draft.consumeMode).toBe('move');
    expect(draft.consumeTo).toBe('.processed');
    expect(draft.sourceKind).toBe('scanner');
  });

  it('starts the password field empty, because the server never sends one back', () => {
    expect(draftFromSource(folderSource({ secretNames: ['password'] })).password).toBe('');
  });
});
