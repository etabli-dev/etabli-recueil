/**
 * The plugin object and its manifest (spec/plugin-api.md §3.6, `spec/plugin-manifest.schema.json`).
 */
import type { PluginContext } from './types.generated.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [k: string]: JsonValue };

export interface ManifestHook {
  /** One of the eleven hook names of spec/hooks.md §6. */
  type: string;
  id: string;
  /** The named export of `main` that implements it. */
  export: string;
  /** Lower runs first; ties by plugin name, then hook id. */
  priority?: number;
  timeoutMs?: number;
  [key: string]: JsonValue | undefined;
}

export interface ManifestEvent {
  type: string;
  export: string;
  mode?: 'async' | 'blocking';
}

/** `recueil.plugin.json`. Validated against the schema by the host; this type is its shape. */
export interface PluginManifest {
  $schema?: string;
  name: string;
  displayName?: string;
  version: string;
  description: string;
  author: string | JsonObject;
  licence: string;
  homepage?: string;
  repository?: string | JsonObject;
  keywords?: string[];
  icon?: string;
  /** A semver range over the plugin API version, never the application version. */
  recueilApi: string;
  main?: string;
  ui?: string;
  permissions?: string[];
  permissionNotes?: Record<string, string>;
  hooks?: ManifestHook[];
  events?: ManifestEvent[];
  /** A JSON Schema (2020-12) for the plugin's settings. */
  settings?: JsonObject;
  contributes?: JsonObject;
}

export interface RecueilPlugin {
  activate?(ctx: PluginContext): Promise<void>;
  deactivate?(): Promise<void>;
}

/** Identity helper so a plugin's default export is typed without an annotation. */
export const definePlugin = (plugin: RecueilPlugin): RecueilPlugin => plugin;
