# @recueil/cli

`recueil` — the command line.

Anything the CLI can do, a script can do against the [REST API](../../spec/openapi.yaml); anything
the CLI cannot do, the API cannot do either (P6). Where the two overlap there is one implementation
behind both — `recueil export` calls the same selection and citation-key code the `.bib` endpoint
does, so the file a LaTeX build fetches and the file this command writes are the same bytes.

The data commands — `serve`, `import`, `export`, `backup`, `restore` — open the library directly
rather than talking to a running server (ADR-0001). That is not a shortcut: an importer writes fifty
thousand records through the service layer in one process, and its idempotency key and resume cursor
live in the same database as the records. They take the same flags and the same environment
variables `serve` does.

The intended command surface, the connection variables and the exit codes are documented in
[`docs/cli.qmd`](../../docs/cli.qmd). This README covers what the package actually does today.

## Status: Phase 1

Phase 1 delivers the core library and the Zotero migration (CONCEPT.md §7). Five commands work;
the rest exist, are listed in `recueil --help` with the phase that delivers them, and — when run —
say so and exit `1`. Two of those belong to Phase 1 as well and are not built yet; the help text
says so rather than pretending otherwise.

| Command | Does | Status |
|---|---|---|
| `serve` | Start the server | **works** |
| `import zotero` | A whole Zotero library, with the verification report | **works** |
| `import bibtex\|biblatex\|ris\|csl-json` | A bibliography file | **works** |
| `export bibtex\|biblatex\|csl-json\|ris` | A selection, in an interchange format | **works** |
| `backup` / `restore` | Consistent snapshot and verified recovery | **works** |
| `token` | Create, list and revoke scoped API tokens | Phase 1 |
| `job` | List, follow, retry and cancel jobs | Phase 1 |
| `ingest` | Push files in, manage sources, work the review queue | Phase 2 |
| `check` | Run the verification engine over a scope or a reference list | Phase 3 |
| `dedup` | File and record deduplication, dry run by default | Phase 3 |
| `plugin` | Install, enable, disable, configure, list | Phase 3 |
| `graph` | Build edges, run a deep dive, export a network | Phase 5 |
| `sr` | Systematic review: search runs, screening, extraction, PRISMA | Phase 7 |

A placeholder fails rather than succeeding quietly, because a script that pipes `recueil dedup`
into something must not receive an empty result and a zero exit code. There is no partial
implementation behind any of them and no flag that turns one on.

```console
$ recueil check bibliography --file refs.txt
error `recueil check` is not implemented yet.

  It arrives in Phase 3 — Enrichment, checks, dedup (CONCEPT.md §7).
  This build is Phase 1, and ships: serve, import, export, backup, restore.
...
$ echo $?
1
```

## `recueil import`

```sh
recueil import zotero ~/Zotero/zotero.sqlite --linked-base ~/Documents/Papers
recueil import zotero ~/Zotero/zotero.sqlite --dry-run
recueil import zotero ~/Zotero/zotero.sqlite --resume
recueil import bibtex refs.bib
recueil import ris endnote-export.ris
recueil import csl-json library.json
```

`import zotero` runs the migrator in [`@recueil/import-zotero`](../../packages/import-zotero),
writes `report.json`, `report.md` and `_REVIEW/` to `--report` (default `./zotero-import`), and
prints the parity table and the named checks. The source library is never written to.

| Exit | Means |
|---|---|
| `0` | Imported, and every check passed |
| `4` | Imported, but entries were routed to `_REVIEW/` and need a decision |
| `5` | The parity check failed — do not delete anything |

`--dry-run` is a real run against a *consistent copy* of the library, taken with the SQLite backup
API, and a store that hashes its bytes and discards them. It therefore accounts for what has already
been imported, which a scratch database could not, and it costs one pass over the files rather than
a second copy of the library.

`--resume` is required to continue an import that stopped part way. Without it, an interrupted run
is reported rather than silently continued; resuming is safe because every write the importer makes
is keyed by something Zotero owns (P9).

The bibliography importers keep the entry key as the item's citation key **and** as its source id,
so `\cite{}` keeps resolving (ADR-0016) and re-importing the same file updates the same items
rather than doubling them (P9). A key or a DOI a live item already holds is dropped and reported,
never reassigned (P3). Files named in a `file` field are reported, not fetched — that is the
ingestion pipeline's job and it arrives in Phase 2.

## `recueil export`

```sh
recueil export bibtex --collection 01J8ZK… --out chapter3.bib
recueil export csl-json --search "climate danube"
recueil export ris --ids 01J8ZK…,01J8ZM…
recueil export biblatex --all --out library.bib
```

Exactly one of `--collection`, `--search`, `--ids` and `--all`. The document goes to stdout unless
`--out` is given; the losses and the counts go to stderr, so redirecting stdout produces a file the
format can read.

`--all` exists here and not on the export endpoint, and the asymmetry is deliberate: an accidental
`GET /export/bibtex` must not serialise fifty thousand entries, while a person who typed `--all`
meant it, and P10 requires the library to be exportable in full.

## `recueil backup` and `recueil restore`

```sh
recueil backup --out /var/backups/recueil
recueil backup --out /var/backups/recueil --force        # nightly, copying only what changed
recueil backup --out /var/backups/index --no-blobs       # store backed up separately
recueil restore /var/backups/recueil --into /srv/recueil
recueil restore /var/backups/recueil --verify-only
```

A snapshot is a **directory of ordinary files**, documented in
[`packages/core/src/backup/FORMAT.md`](../../packages/core/src/backup/FORMAT.md):

```
manifest.json        the index — every file, with the digest it must hash to
checksums.txt        sha256sum -c input, so it can be verified without Recueil
database/            the database, taken with SQLite's online backup API
config/recueil.json  the RECUEIL_* environment, credentials redacted
storage/<aa>/<bb>/…  the content-addressed store, in its own layout
```

The database is copied page by page through SQLite itself, so a running server does not have to be
stopped and what lands is the database as of one instant; it is then opened and integrity-checked
before the snapshot is completed. Writing over yesterday's snapshot with `--force` verifies and
reuses the blobs that have not changed and prunes the ones the library no longer holds — that, and
the content-addressed layout, are what make it restic-friendly (CONCEPT.md §5.15).

A restore refuses a target that is not empty unless `--force` is given, hashes every file as it
copies it and checks it against the manifest, and removes what it had written if one file does not
match. It then integrity-checks the restored database and compares its table counts with the
manifest's. `--verify-only` does the checking half and writes nothing, which is the thing to put in
a monthly cron job.

## `recueil serve`

```sh
recueil serve
recueil serve --port 8080 --host 0.0.0.0
recueil serve --database ./library.sqlite --storage ./storage
```

| Flag | Overrides | Default |
|---|---|---|
| `-p, --port` | `RECUEIL_PORT` | `3000` |
| `-H, --host` | `RECUEIL_HOST` | `127.0.0.1` |
| `-d, --database` | `RECUEIL_DATABASE_URL` | `file:./data/recueil.db` |
| `-s, --storage` | `RECUEIL_STORAGE_PATH` | `./data/storage` |
| `--log-level` | `RECUEIL_LOG_LEVEL` | `info` |

Defaults belong to [`@recueil/server`](../server), not to the CLI, and the table above records them
rather than sets them. The full variable list is in [`deploy/.env.example`](../../deploy/.env.example).

Precedence is flag, then environment, then default. A flag wins by being written into the
environment before the server's own configuration loader reads it, so a flag and an exported
variable cannot diverge in behaviour — there is one code path, and the CLI needs to know nothing
about the loader's signature to override it.

On start, the resolved configuration is printed to **stderr** with anything that looks like a
credential replaced by `****`, followed by the URL the socket actually bound to. With `--json` the
same facts go to **stdout** as one object:

```json
{
  "status": "listening",
  "url": "http://127.0.0.1:3000",
  "host": "127.0.0.1",
  "port": 3000,
  "config": { "…": "…" }
}
```

`SIGINT` and `SIGTERM` close the server and exit `0`. A second signal during shutdown exits
immediately, and a handle still open five seconds after a successful close is reported and then
abandoned, so `docker stop` never waits out its full grace period on a leak.

## Global flags

| Flag | Effect |
|---|---|
| `--json` | Machine-readable output on stdout; prose suppressed |
| `-q, --quiet` | Errors only |
| `-v, --verbose` | Explain what is being resolved and why |
| `--no-colour` | Disable ANSI (`--no-color` is accepted; `NO_COLOR` is honoured) |
| `-y, --yes` | Assume yes for every confirmation |

stdout carries the answer and stderr carries the commentary, always. `recueil export … >
chapter3.bib` has to produce a `.bib` file, not a `.bib` file with a progress line at the top.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Usage error, unknown command, or a command that does not exist yet |
| `2` | Authentication or authorisation failure |
| `3` | Server unreachable, or the listen socket could not be bound |
| `4` | Job completed with items routed to the review queue |
| `5` | Job failed |

Code `4` exists because P3 ("flag, never guess") needs a way to say so to a shell script.

## Development

```sh
pnpm --filter @recueil/cli build      # tsc, then shebang and mode on dist/index.js
pnpm --filter @recueil/cli typecheck
pnpm --filter @recueil/cli test
pnpm --filter @recueil/cli dev -- --help   # run from source through tsx
```

The tests drive the built entry point's source in a child process, because exit codes and signal
handling are most of what is being asserted and neither is observable in-process. The `serve` suite
needs `@recueil/server` to be built; if it cannot import it, the suite skips with a warning naming
the reason rather than reporting green for something it never ran.

### Where the phase table lives

[`src/catalogue.ts`](src/catalogue.ts) holds every command, its summary, its phase and whether this
build implements it. Help output, the placeholder messages and the tests all render from it, so they
cannot disagree. The phase and the implementation flag are separate facts on purpose — Phase 1
delivers `token` and `job` too, and until those exist a table that inferred one from the other would
have to claim either that the phase had not started or that the commands worked.

`buildProgram` checks the table against the registered implementations in both directions and throws
at start-up on either mismatch: a command marked as shipping with nothing behind it, and an
implementation the help text still calls unimplemented, are both a CLI that lies about itself.

## Licence

AGPL-3.0-or-later. See [`LICENSE`](../../LICENSE).
