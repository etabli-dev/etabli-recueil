/**
 * `@recueil/ingest-sources` — where documents come from.
 *
 * CONCEPT §5.3 lists eight sources and says they all feed the same pipeline. Three of them are
 * places rather than protocols, and they are this package: a watched folder, a WebDAV feed (the
 * Nextcloud share), and an IMAP mailbox. The scanner path is not a fourth: a Brother ADS-4700W is a
 * `FolderSource` with `sourceKind: 'scanner'`, or an `ImapSource`, depending on which of its four
 * destinations you point it at — `README.md` maps all four.
 *
 * Each one implements the `ingestSource` hook of `spec/hooks.md` §6.4 and feeds `@recueil/ingest`.
 * None of them hashes, stores or creates an Item (P2): they produce candidates and bytes, and the
 * pipeline owns everything downstream.
 *
 * ```ts
 * import { createRecueil } from '@recueil/core';
 * import { IngestPipeline } from '@recueil/ingest';
 * import { FolderSource, SourceRunner } from '@recueil/ingest-sources';
 *
 * const recueil = createRecueil({ databaseUrl: 'library.sqlite', storagePath: 'store' });
 * const source = new FolderSource({
 *   root: '/srv/consume',
 *   consume: { mode: 'move', to: '.processed' },
 * });
 * const pipeline = new IngestPipeline({ recueil, rules: source.rules });
 * const runner = new SourceRunner({ source, pipeline, recueil });
 *
 * await runner.start();
 * const report = await runner.runOnce();
 * if (!report.ok) console.error(report.acknowledgements.filter((a) => a.action === 'refused'));
 * ```
 *
 * The rule the three sources share, and the one worth reading the code for: **nothing on the far
 * side is moved, deleted or flagged until the bytes have been re-read out of the content store,
 * re-hashed and matched against their `documents` row.** See `verify.ts`.
 */

/* The contract ------------------------------------------------------------------------------- */
export { DEFAULT_CONSUME_ON } from './types.js';
export type {
  Acknowledgement,
  AcknowledgementAction,
  CommonSourceOptions,
  ConsumableStatus,
  ConsumePolicy,
  DocumentSourceKind,
  IngestCandidate,
  IngestOutcome,
  IngestRef,
  IngestSource,
  SkippedEntry,
  SourceContext,
  SourceLogEntry,
  SourcePage,
} from './types.js';

export {
  SourceError,
  SourceProtocolError,
  SourceUnavailableError,
  UnsafeSourcePathError,
} from './errors.js';

/* The verification that gates every consume policy ------------------------------------------- */
export { outcomeDigests, verifyOutcome, verifyStoredDocument } from './verify.js';
export type { DigestVerification, StoreVerification } from './verify.js';
export { consumeStatuses, decideConsume, evidenceForConsume } from './consume.js';
export type { ConsumeDecision, ConsumeEvidence } from './consume.js';

/* What a source remembers --------------------------------------------------------------------- */
export { SourceStateStore, ensureSourceSchema, sourceState } from './state.js';
export type { AcknowledgementState, SourceStateRow } from './state.js';

/* The runner ----------------------------------------------------------------------------------- */
export { SourceRunner } from './runner.js';
export type { AcknowledgementRecord, SourceRunReport, SourceRunnerOptions } from './runner.js';

/* Watched folders -------------------------------------------------------------------------------- */
export { FolderSource } from './folder/source.js';
export type { FolderSourceOptions } from './folder/source.js';
export { PARTIAL_SUFFIXES, looksPartial, scanFolder } from './folder/scan.js';
export type { FolderEntry, FolderScanOptions, FolderScanResult } from './folder/scan.js';
export { DEFAULT_STABILITY, selectStable } from './folder/stability.js';
export type { StabilityOptions, StabilityResult } from './folder/stability.js';
export { FolderWatcher } from './folder/watcher.js';
export type { FolderWatcherOptions } from './folder/watcher.js';

/* The WebDAV feed ---------------------------------------------------------------------------------- */
export { WebDavSource } from './webdav/source.js';
export type { WebDavSourceOptions, WebDavStabilityOptions } from './webdav/source.js';
export { WebDavClient, normaliseEtag } from './webdav/client.js';
export type { WebDavAuth, WebDavClientOptions, WebDavEntry } from './webdav/client.js';

/* The mailbox ---------------------------------------------------------------------------------------- */
export { ImapSource } from './imap/source.js';
export type { ImapSourceOptions } from './imap/source.js';
export { ImapClient } from './imap/client.js';
export type {
  ImapClientOptions,
  ImapCommandResult,
  ImapMailboxStatus,
  ImapMessageHead,
  ImapResponse,
} from './imap/client.js';
export {
  addressList,
  addressOf,
  decodeHeaderBytes,
  headerValue,
  parseHeaderBlock,
} from './imap/headers.js';
export type { HeaderMap } from './imap/headers.js';
export { mailRuleMatches, matchingMailRules, skippedBy, toIngestRules } from './imap/rules.js';
export type { MailEnvelope, MailPattern, MailRule } from './imap/rules.js';
