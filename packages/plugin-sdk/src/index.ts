/**
 * `@recueil/plugin-sdk` — plugin API 1.0.0 (spec/plugin-api.md).
 *
 * The SDK version tracks the plugin API version exactly (spec/plugin-api.md §2.1).
 */
export const PLUGIN_API_VERSION = '1.0.0';

export type * from './types.generated.js';
export type * from './host-apis.js';
export * from './errors.js';
export type { PluginManifest, ManifestHook, ManifestEvent, RecueilPlugin } from './plugin.js';
export { definePlugin } from './plugin.js';
export { canonicalDoi, extraValues, nameKey, normaliseTitle, titleSimilarity, titleTokens } from './text.js';
