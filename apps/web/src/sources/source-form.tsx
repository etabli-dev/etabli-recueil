/**
 * The source form: one screenful per kind, and no secret ever read back.
 *
 * The three kinds share an envelope — a name, whether it is enabled, what `documents.source_kind`
 * to stamp on what it brings in, the consume policy, the poll interval — and differ in a handful
 * of fields each. The shared part is written once, above the switch, because the consume policy is
 * the field with consequences and it must look and behave identically wherever it appears.
 *
 * Passwords are write-only (§5.15). A stored one is reported as "a password is stored" and never
 * sent back, and leaving the field blank leaves it alone: the alternative — prefilling the input
 * with the real secret so the form round-trips cleanly — turns every configuration screen into a
 * credential viewer.
 */
import { useId, useState } from 'react';

import type { IngestionSource, IngestionSourceKind } from '../api/ingestion.js';
import { draftFromSource, draftToCreate, emptyDraft, validateDraft } from './draft.js';
import type { DraftIssue, SourceDraft } from './draft.js';

export interface SourceFormProps {
  /** Absent for a new source. */
  source?: IngestionSource;
  kind?: IngestionSourceKind;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (body: ReturnType<typeof draftToCreate>) => void;
}

const SOURCE_KINDS: readonly { value: IngestionSourceKind; label: string; hint: string }[] = [
  { value: 'folder', label: 'Watched folder', hint: 'A directory on the server, or a scanner’s drop directory.' },
  { value: 'webdav', label: 'WebDAV feed', hint: 'A collection on a WebDAV server — a Nextcloud share, for instance.' },
  { value: 'imap', label: 'IMAP mailbox', hint: 'Attachments become documents; the body becomes a note.' },
];

/** `documents.source_kind`, restricted to the values an operator would choose for a source. */
const DOCUMENT_SOURCE_KINDS = ['folder', 'webdav', 'imap', 'scanner', 'mobile', 'api'] as const;

export const SourceForm = ({ source, kind, busy = false, onCancel, onSubmit }: SourceFormProps): JSX.Element => {
  const [draft, setDraft] = useState<SourceDraft>(() =>
    source === undefined ? emptyDraft(kind ?? 'folder') : draftFromSource(source),
  );
  const [issues, setIssues] = useState<readonly DraftIssue[]>([]);
  const formId = useId();

  const set = <Key extends keyof SourceDraft>(key: Key, value: SourceDraft[Key]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const issueFor = (field: keyof SourceDraft): string | undefined =>
    issues.find((issue) => issue.field === field)?.message;

  const submit = (): void => {
    const found = validateDraft(draft);
    setIssues(found);
    if (found.length > 0) return;
    onSubmit(draftToCreate(draft));
  };

  return (
    <form
      className="source-form"
      data-testid="source-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Text
        id={`${formId}-name`}
        label="Name"
        value={draft.name}
        error={issueFor('name')}
        hint="What this source is called on this screen and in the job log."
        onChange={(value) => set('name', value)}
      />

      {source === undefined ? (
        <Select
          id={`${formId}-kind`}
          label="Kind"
          value={draft.kind}
          options={SOURCE_KINDS.map((entry) => ({ value: entry.value, label: entry.label }))}
          hint={SOURCE_KINDS.find((entry) => entry.value === draft.kind)?.hint}
          onChange={(value) => setDraft(emptyDraft(value as IngestionSourceKind))}
        />
      ) : (
        <p className="section__note">
          Kind: <code>{source.kind}</code>. A source cannot change kind — its identity, and the state
          table keyed by it, belong to the place it reads from.
        </p>
      )}

      <Select
        id={`${formId}-source-kind`}
        label="Recorded as"
        value={draft.sourceKind}
        options={DOCUMENT_SOURCE_KINDS.map((value) => ({ value, label: value }))}
        hint="Stamped on every document this source brings in, and matchable by a rule. A scanner drop directory is a folder recorded as `scanner`."
        onChange={(value) => set('sourceKind', value)}
      />

      {draft.kind === 'folder' ? (
        <fieldset className="field-group">
          <legend>Folder</legend>
          <Text
            id={`${formId}-root`}
            label="Directory"
            value={draft.root}
            error={issueFor('root')}
            hint="An absolute path on the server. It is resolved once, at activation."
            onChange={(value) => set('root', value)}
          />
          <Check id={`${formId}-recursive`} label="Descend into subdirectories" checked={draft.recursive} onChange={(value) => set('recursive', value)} />
          <Check id={`${formId}-hidden`} label="Skip hidden files" checked={draft.skipHidden} onChange={(value) => set('skipHidden', value)} />
          <Check
            id={`${formId}-watch`}
            label="Watch for changes"
            checked={draft.watch}
            hint="A push notification from the filesystem. The poll is the truth either way."
            onChange={(value) => set('watch', value)}
          />
          <Text
            id={`${formId}-age`}
            label="Settle for (ms)"
            value={draft.minimumAgeMillis}
            error={issueFor('minimumAgeMillis')}
            hint="How long a file must be unchanged before it is offered. A scanner writing a 40-page PDF is not finished when the file appears."
            onChange={(value) => set('minimumAgeMillis', value)}
          />
        </fieldset>
      ) : null}

      {draft.kind === 'webdav' ? (
        <fieldset className="field-group">
          <legend>WebDAV</legend>
          <Text
            id={`${formId}-url`}
            label="Collection URL"
            value={draft.url}
            error={issueFor('url')}
            hint="https://cloud.example.org/remote.php/dav/files/user/Scans/"
            onChange={(value) => set('url', value)}
          />
          <Text id={`${formId}-dav-user`} label="Username" value={draft.webdavUsername} onChange={(value) => set('webdavUsername', value)} />
          <Secret id={`${formId}-dav-pass`} stored={(source?.secretNames.length ?? 0) > 0} value={draft.password} onChange={(value) => set('password', value)} />
          <Check id={`${formId}-dav-recursive`} label="Descend into subcollections" checked={draft.recursive} onChange={(value) => set('recursive', value)} />
          <Text
            id={`${formId}-depth`}
            label="Maximum depth"
            value={draft.maxDepth}
            error={issueFor('maxDepth')}
            onChange={(value) => set('maxDepth', value)}
          />
        </fieldset>
      ) : null}

      {draft.kind === 'imap' ? (
        <fieldset className="field-group">
          <legend>Mailbox</legend>
          <Text id={`${formId}-host`} label="Host" value={draft.host} error={issueFor('host')} onChange={(value) => set('host', value)} />
          <Text id={`${formId}-port`} label="Port" value={draft.port} error={issueFor('port')} onChange={(value) => set('port', value)} />
          <Check id={`${formId}-secure`} label="Implicit TLS on connect" checked={draft.secure} hint="Port 993. Turn it off only for a server on loopback." onChange={(value) => set('secure', value)} />
          <Text id={`${formId}-user`} label="Username" value={draft.imapUsername} error={issueFor('imapUsername')} onChange={(value) => set('imapUsername', value)} />
          <Secret id={`${formId}-pass`} stored={(source?.secretNames.length ?? 0) > 0} value={draft.password} onChange={(value) => set('password', value)} />
          <Text id={`${formId}-mailbox`} label="Mailbox" value={draft.mailbox} onChange={(value) => set('mailbox', value)} />
          <Text
            id={`${formId}-search`}
            label="Search"
            value={draft.search}
            error={issueFor('search')}
            hint="IMAP UID SEARCH criteria. UNSEEN by default; ALL is right for a dedicated ingestion mailbox, where the state table rather than the flag is the record."
            onChange={(value) => set('search', value)}
          />
          <Check
            id={`${formId}-seen`}
            label="Mark messages read once the ingest is verified"
            checked={draft.markSeen}
            hint="After the verification, never before: a message marked read by a failed ingest is one nobody comes back to."
            onChange={(value) => set('markSeen', value)}
          />
        </fieldset>
      ) : null}

      <fieldset className="field-group">
        <legend>After ingesting</legend>
        <Select
          id={`${formId}-consume`}
          label="What happens to the original"
          value={draft.consumeMode}
          options={[
            { value: 'leave', label: 'Leave it where it is' },
            { value: 'move', label: 'Move it aside' },
            { value: 'delete', label: 'Delete it' },
          ]}
          hint="Move and delete act only after the bytes have been re-read out of the content store, re-hashed and matched against their documents row. Leave is the only policy that needs no such proof, because it destroys nothing."
          onChange={(value) => set('consumeMode', value as SourceDraft['consumeMode'])}
        />
        {draft.consumeMode === 'move' ? (
          <Text
            id={`${formId}-consume-to`}
            label="Destination"
            value={draft.consumeTo}
            error={issueFor('consumeTo')}
            hint="A directory for a folder, a collection for WebDAV, a mailbox for IMAP. It must not be the place being watched."
            onChange={(value) => set('consumeTo', value)}
          />
        ) : null}
        <Check id={`${formId}-enabled`} label="Enabled" checked={draft.enabled} onChange={(value) => set('enabled', value)} />
      </fieldset>

      {issues.length === 0 ? null : (
        <ul className="state__field-errors" role="alert" data-testid="source-form-issues">
          {issues.map((issue) => (
            <li key={`${issue.field}:${issue.message}`}>
              <code>{issue.field}</code> {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="source-form__actions">
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Saving…' : source === undefined ? 'Add the source' : 'Save'}
        </button>
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
};

/* Small labelled controls. Local, because they exist to keep the form above readable. --------- */

const Text = ({
  id,
  label,
  value,
  hint,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  hint?: string;
  error?: string;
  onChange: (value: string) => void;
}): JSX.Element => (
  <div className="field" data-field={id}>
    <label className="field__label" htmlFor={id}>
      {label}
    </label>
    <div className="field__control">
      <input
        id={id}
        className="field__input"
        type="text"
        value={value}
        aria-invalid={error !== undefined}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
    {hint === undefined ? null : (
      <p className="field__hint" id={`${id}-hint`}>
        {hint}
      </p>
    )}
    {error === undefined ? null : (
      <p className="field__error" role="alert">
        {error}
      </p>
    )}
  </div>
);

const Select = ({
  id,
  label,
  value,
  options,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  hint?: string;
  onChange: (value: string) => void;
}): JSX.Element => (
  <div className="field" data-field={id}>
    <label className="field__label" htmlFor={id}>
      {label}
    </label>
    <div className="field__control">
      <select id={id} className="select" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
    {hint === undefined ? null : <p className="field__hint">{hint}</p>}
  </div>
);

const Check = ({
  id,
  label,
  checked,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  hint?: string;
  onChange: (value: boolean) => void;
}): JSX.Element => (
  <div className="field field--check" data-field={id}>
    <label className="field__label" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}
    </label>
    {hint === undefined ? null : <p className="field__hint">{hint}</p>}
  </div>
);

/**
 * A write-only password.
 *
 * `stored` is `SourceConfig.hasSecret`, which is all the server will say about a credential it
 * holds. The placeholder therefore states the fact rather than pretending to show the value, and
 * the field's own hint says what leaving it blank does.
 */
const Secret = ({
  id,
  stored,
  value,
  onChange,
}: {
  id: string;
  stored: boolean;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element => (
  <div className="field" data-field={id}>
    <label className="field__label" htmlFor={id}>
      Password
    </label>
    <div className="field__control">
      <input
        id={id}
        className="field__input"
        type="password"
        autoComplete="new-password"
        value={value}
        placeholder={stored ? 'a password is stored' : 'no password stored'}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
    <p className="field__hint">
      {stored
        ? 'Never sent back to this screen. Leave it blank to keep the stored one; type to replace it.'
        : 'Stored on the server and never returned.'}
    </p>
  </div>
);
