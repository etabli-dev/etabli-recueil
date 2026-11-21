/**
 * `@recueil/plugin-host` — the plugin host and the Phase 3 engines.
 */
export { PluginHost, snapshotItem, withDeadline } from './host.js';
export type { CallOptions, FetchLike, PluginHostOptions, PluginSource, PluginState, PluginStatus, RegisteredHook } from './host.js';
export { AdaptiveLimiter, parseRetryAfter } from './limiter.js';
export type { LimiterOptions } from './limiter.js';
export { isCompatible, readManifest, validateManifest } from './manifest.js';
export type { ManifestProblem } from './manifest.js';
export { defaultsOf, missingRequired, resolveSecrets, secretPaths, secretStatus, validateSettings } from './settings.js';
export { EnrichmentEngine, identityProblem, itemIdentifiers } from './enrich.js';
export type { EnrichMode, EnrichOptions, EnrichResult, EnrichStatus } from './enrich.js';
export { ChecksEngine, checksReportCsv, checksReportMarkdown } from './checks.js';
export type { ChecksRun, RunChecksOptions } from './checks.js';
export { DedupEngine } from './dedup.js';
export type { DedupGroup, DedupOptions, DedupPair, DedupRun, WinnerRule } from './dedup.js';
export { canonicalDoi, extraValues, nameKey, normaliseTitle, titleSimilarity, titleTokens } from '@recueil/plugin-sdk';
export { detectAuditFormat, parseTextReference, readAuditInput } from './audit-input.js';
export type { AuditFormat, AuditReference } from './audit-input.js';
