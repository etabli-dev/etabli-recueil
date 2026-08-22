# The Recueil backup format

`recueil-backup`, format version 1.

A snapshot is a **directory of ordinary files**. There is no archive, no compression and no
Recueil-specific container: everything in it can be read with `cat`, checked with `sha256sum` and
restored with `cp`. That is a P10 promise ("nothing is UI-only", and nothing is Recueil-only) as
much as an operational one — a backup you cannot read without the program that wrote it is a
backup you have not tested.

This document is the specification. A third-party tool that follows it can write a snapshot
Recueil will restore, and restore one Recueil wrote.

---

## 1. Layout

```
<snapshot>/
  manifest.json                     the index; nothing else is discovered by walking
  checksums.txt                     sha256sum -c input, covering every file including manifest.json
  database/
    library.sqlite                  a consistent snapshot, taken with SQLite's online backup API
  config/
    recueil.json                    the configuration the snapshot was taken with (optional)
  storage/
    <aa>/<bb>/<sha256>              the content-addressed store, in its own layout (ADR-0004)
```

`storage/` is absent from a manifest-only snapshot (§6). `config/` is absent when the caller
recorded no configuration.

All paths in `manifest.json` and `checksums.txt` are relative to the snapshot root and use forward
slashes on every platform.

## 2. Why a directory and not an archive

CONCEPT.md §5.15 asks for a *restic-friendly* layout. Four properties follow from that, and each
one is a deliberate choice rather than an accident of implementation:

1. **Ordinary files in a tree.** A deduplicating backup program — restic, borg, kopia — walks a
   directory. Handed a `.tar`, it sees one large file that changes in its entirety whenever
   anything inside it does, and stores a fresh copy every night.

2. **Blobs keep their content-addressed path.** A blob is `storage/<aa>/<bb>/<sha256>`, exactly as
   in the live store. An unchanged blob is therefore the identical bytes at the identical path in
   every snapshot, and is stored once no matter how many snapshots reference it.

3. **The database is copied page-wise, not rewritten.** The snapshot is taken with
   `sqlite3_backup_step` rather than `VACUUM INTO`. `VACUUM INTO` would produce a smaller,
   defragmented file — and a *differently laid out* one each time, defeating the content-defined
   chunking that lets a deduplicating program store only the pages that changed. The backup API
   preserves page layout, so last night's chunks are mostly reusable.

4. **The manifest is byte-stable.** Keys are emitted in a fixed order and the blob list is sorted
   by digest, so an unchanged library produces an identical `manifest.json`.

A snapshot can also be written **over an earlier one at the same path**, which is how it is meant
to be used on a schedule. Blobs already present with the right digest are verified and left alone;
blobs the library no longer holds are pruned, so the directory remains a snapshot of one instant
rather than the union of every run.

## 3. Consistency

The database half is the only part that needs care, and it needs a lot of it.

A live SQLite database in WAL mode is three files — `library.sqlite`, `library.sqlite-wal` and
`library.sqlite-shm` — that agree with one another only at instants an outside observer cannot
see. Copying the main file alone loses every committed transaction still in the log. Copying the
main file and the log separately can capture them at different instants and produce a database
that will not open. Copying while a checkpoint is running can produce one that opens and is
missing rows.

So the snapshot is taken through SQLite itself:

```
sqlite3_backup_init / sqlite3_backup_step / sqlite3_backup_finish
```

which copies pages under the engine's own reader/writer discipline. Writers continue during the
copy; pages that change while it runs are re-copied; what lands is the database as of one instant.
The result is then opened read-only and `PRAGMA integrity_check` is run against it. A snapshot that
does not pass is not written — the backup fails instead.

The store half needs no such machinery, and that is a property of ADR-0004. Blobs are immutable
and named by the digest of their own bytes, so a concurrent ingest can only add files, and a blob
is either complete or not there at all. Each blob is hashed as it is copied and the digest is
compared with the name it was found under; a blob whose bytes have rotted (invariant D2) fails the
backup rather than being laundered into it.

## 4. `manifest.json`

```jsonc
{
  "format": "recueil-backup",
  "formatVersion": 1,
  "createdAt": "2026-08-22T09:41:07.512Z",
  "generator": { "name": "@recueil/core", "version": "0.1.0" },

  "database": {
    "path": "database/library.sqlite",
    "sha256": "…",                    // of the file in this snapshot
    "size": 1130496,
    "sqliteVersion": "3.53.2",
    "pageSize": 4096,
    "pageCount": 276,
    "integrityCheck": "ok",           // run against the snapshot, not the original
    "schema": {                       // __drizzle_migrations, as of the snapshot
      "applied": 4,
      "latestHash": "…",
      "latestCreatedAt": 1755000000000
    },
    "tableCounts": { "items": 64, "documents": 12, … }
  },

  "config": { "path": "config/recueil.json", "sha256": "…", "size": 412 },

  "storage": {
    "backend": "local",
    "root": "/var/lib/recueil/storage",   // where it was read from; informational
    "blobsIncluded": true,
    "blobCount": 12,
    "totalBytes": 4718592,
    "blobs": [
      { "path": "storage/0a/1b/0a1b…", "key": "0a/1b/0a1b…", "sha256": "0a1b…", "size": 393216 }
    ]
  }
}
```

Notes on the fields that are not self-evident:

- **`database.tableCounts`** exists because a restored database is never *byte*-identical to the
  original: the backup API folds in the write-ahead log and rewrites the free list. Equality is
  therefore asserted on content, and these counts are what a restore checks itself against.
- **`database.schema`** records which migrations had run. A restore into a newer build will migrate
  forward on first boot, as always; the field is there so an operator can see what they are holding
  before they open it.
- **`storage.blobs[].key`** duplicates the digest in `documents.storage_key` form, so the manifest
  can be reconciled against the `documents` table without re-deriving the fan-out.
- **`config`** is `null` when no configuration was recorded. Whatever is recorded has been redacted
  by the caller: **a snapshot never contains a credential.** It is there to answer "what was this
  library configured as", not to be replayed.

A reader **must** refuse a `formatVersion` greater than the one it implements, and **must not**
treat a directory without `manifest.json` as a snapshot.

## 5. `checksums.txt`

Standard `sha256sum` output — `<digest><two spaces><path>` — sorted by path, covering every file in
the snapshot **including `manifest.json`**. From inside the snapshot directory:

```sh
sha256sum -c checksums.txt
```

This is the escape hatch. It lets a snapshot be verified on a machine that has no Node, no Recueil
and no network, and it means the manifest itself is covered by something other than the manifest.

## 6. Manifest-only snapshots

With blobs excluded, `storage.blobsIncluded` is `false`, `storage/` is absent, and the blob list is
still complete: every digest, key and size the store held at that instant.

This is for a deployment that already backs the content-addressed store up on its own — which is a
reasonable thing to do, because an immutable content-addressed directory is the easiest thing in
the world for restic to handle, and copying it into a second place every night is waste. The
manifest is then what makes that separate copy *verifiable*: it says exactly which blobs the
database expects to find.

Such a snapshot cannot restore the store on its own, and `restoreBackup` refuses rather than
producing a library with no files in it. The sequence is: restore the store, then restore the
snapshot into the same directory with `force`.

## 7. Restoring

A restore is deliberately dull:

| From the snapshot | To the target |
|---|---|
| `database/library.sqlite` | `<target>/library.sqlite` |
| `config/recueil.json` | `<target>/config/recueil.json` |
| `storage/<aa>/<bb>/<sha>` | `<target>/storage/<aa>/<bb>/<sha>` |

Blobs keep their path, so the restored store is byte-identical to the one that was backed up,
file for file. The target is then an ordinary deployment: point `RECUEIL_DATABASE_URL` at
`<target>/library.sqlite` and `RECUEIL_STORAGE_PATH` at `<target>/storage`.

The rules a conforming restore must follow:

1. **Refuse a non-empty target** unless the operator has explicitly forced it. Restoring over a
   live library by mistyping a path is not a recoverable error.
2. **Verify every file against the manifest**, hashing as it copies. One mismatch fails the whole
   restore, and the partially written files are removed — a directory that looks like a library and
   is not one is worse than no directory at all.
3. **Clear a stale write-ahead log** (`library.sqlite-wal`, `library.sqlite-shm`) before writing the
   database. A restored database file beside another database's WAL is corruption.
4. **Check the result**: `PRAGMA integrity_check` on the restored file, and its table counts against
   `database.tableCounts`.

## 8. What a snapshot does not contain

- **Credentials.** Not in `config/`, not anywhere. Tokens are hashed in the database and stay that
  way; environment secrets are redacted before they are recorded.
- **The write-ahead log.** It has been folded into the snapshot by the backup API; carrying it
  would be carrying the same transactions twice.
- **The store's `.tmp/` directory,** which holds the partial writes of in-flight ingests. Anything
  under the store root that is not a well-formed `<aa>/<bb>/<sha256>` blob is ignored and reported,
  never copied and never given a digest.
- **`__drizzle_migrations` interpretation.** The table is copied like any other; nothing here
  attempts to migrate anything. A restored library migrates forward when it is next opened.
