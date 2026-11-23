# `@recueil/sync-zotero`

Two-way sync between a Recueil library and the zotero.org libraries an API key reaches, through
the Zotero Web API v3. The decision and its limits are [ADR-0025](../../spec/adr/0025-two-way-zotero-sync.md).

```ts
import { ZoteroApiClient, syncZoteroLibraries } from '@recueil/sync-zotero';

const client = new ZoteroApiClient({ apiKey: process.env.RECUEIL_ZOTERO_API_KEY! });
const reports = await syncZoteroLibraries(recueil, client, { dryRun: true });
```

From the shell: `recueil sync zotero --dry-run`, then `--direction pull`, then a full run.

## How a run works

1. **Pull, every library first.** Collections, items, notes and attachments changed since the
   stored library version, and the keys Zotero has deleted since then.
2. **Merge, per object.** Three projections are compared: the *base* (the Zotero JSON both sides
   last agreed on, stored in `zotero_sync_links.base`), Recueil now, Zotero now. Projection is what
   makes normalisation harmless: Recueil's lower-cased DOI and EDTF date are not edits.
3. **Apply** the merged result to Recueil, with the provenance stamp `sync:zotero` (never a lock).
4. **Push.** Whatever the merged result holds that Zotero does not, plus Recueil-only changes and,
   for the home library, new Recueil objects. Batches of 50; collections (parents first), then
   items, then notes and attachments; every object carries its last known version, so a stale
   write is refused by Zotero and deferred to the next run.
5. **Advance** the stored library version to the version the pull started from, never further.

| base → Recueil | base → Zotero | result |
|---|---|---|
| same | same | nothing |
| same | changed | Zotero's value |
| changed | same | Recueil's value |
| changed | changed, equal | that value |
| changed | changed, different | **conflict** |

Tags and collection memberships merge as sets. A field locked in Recueil (any hand edit locks,
P4) is never overwritten by a pull or by a policy; Zotero changing it is a conflict.

## Conflicts

Under the default policy `review`, both sides keep their value and the conflict is stored in
`zotero_sync_conflicts`. It stays held on later runs until either side changes to agree with the
other or a person decides it (`recueil sync zotero resolve <id> zotero|recueil`); the next run then
applies the decision to both sides. `--conflicts zotero|recueil` picks a side automatically, except
for locked fields.

## What is and is not carried

| | Pull | Push |
|---|---|---|
| Bibliographic fields with a Recueil column | ✓ | ✓ (when the item type has the field) |
| Other Zotero fields | kept in the base | returned unchanged |
| Creators, tags, collections, `Extra` | ✓ | ✓ |
| Trash | both ways | both ways |
| Permanent deletion | → Recueil trash | only with `--propagate-purge` |
| Child and standalone notes | ✓ | ✓ (Markdown edits become HTML) |
| Stored files | downloaded, MD5-checked | uploaded (new attachments) |
| Linked URLs / linked files | as links | URLs only |
| Item type changes | ✓ | reported, not pushed |
| Saved searches, annotations, relations | not yet | not yet |

New Recueil items go to the home library only, and by default only items with a bibliographic
facet (`--push-new bibliographic`): an invoice archive does not end up in Zotero. An item that came
from `recueil import zotero` but that no bridged library claims is never pushed, to avoid a copy.

## Safety

- The API key goes only to the API host; file downloads and uploads go to Zotero's storage without
  it. It is never stored or logged.
- `--dry-run` runs everything inside one SQLite transaction that is rolled back, sends no write and
  downloads no file. It needs the connection to itself, which the CLI always has.
- `Backoff`, `429` and `503` with `Retry-After` are obeyed.

## Tests

`test/fake-zotero.ts` is an in-process zotero.org implementing the documented v3 behaviour the
client relies on: versions, `since`, paging, `/deleted`, per-object `412`, `version: 0`, deletion
preconditions, the three-step upload, and a file host that fails the test if it ever sees the key.
The suite has not been run against the real zotero.org.
