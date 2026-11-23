# Plugin registry, v1

| | |
|---|---|
| Status | Proposed for 1.0 (Phase 9) |
| Covers | CONCEPT.md §5.13 (developer experience), §7 Phase 9 |
| Companions | [`hooks.md`](hooks.md) · [`plugin-manifest.schema.json`](plugin-manifest.schema.json) · [`registry/index.json`](../registry/index.json) |

The registry is a JSON index in a Git repository — no server, no accounts. It lists where a plugin
can be fetched and what it will ask for, so that `recueil plugin search` can show a person the
permissions **before** anything is downloaded. Installing remains the person's decision: plugins
run in process with the server's rights (ADR-0012, ADR-0018), and the registry is a catalogue,
not a review.

## Format

`index.json` is an object with `schema: "recueil.plugin-registry/1"`, `updated` (an ISO date) and
`plugins`, an array of entries:

| Field | | Meaning |
|---|---|---|
| `name` | required | The npm package name, equal to the manifest's `name` |
| `displayName`, `description` | required | As in the manifest |
| `repository` | required | Source repository URL |
| `licence` | required | SPDX expression |
| `recueilApi` | required | The plugin API range, as in the manifest |
| `hooks` | required | The hook types it implements (`resolver`, `check`, `dedupRule`, …) |
| `permissions` | required | Exactly the manifest's `permissions`, so they can be shown before install |
| `source` | required | `{ "type": "npm", "package": "…", "version": "…" }`, `{ "type": "url", "url": "https://…/plugin.tgz" }`, or `{ "type": "builtin" }` for a plugin that ships with the server |
| `integrity` | required for `url` | `sha512-…` of the tarball (the npm `integrity` format); an install that does not match is refused |
| `firstParty` | optional | `true` for plugins in the Recueil repository |
| `maintainers` | optional | Names, not contact details |

## Rules

1. An entry is added by pull request to the registry repository. The pull request shows the
   manifest; reviewers check that `permissions` matches it and that `permissionNotes` explain
   each one. Nothing else is promised.
2. The index never carries executable content, only references and hashes.
3. A version that turns out to be malicious is removed and listed in `revoked` (`name`, `version`,
   reason); `recueil plugin list` warns about an installed revoked version.
4. A plugin's API range is checked against the running host (`isCompatible`) before install.

## Status in the tree

`registry/index.json` lists the three first-party plugins, which ship inside the server and are
enabled with `recueil plugin enable --builtin`. A separate registry repository and the install
command (`recueil plugin install <name>`) come with 1.0; they are publication steps the owner takes.
