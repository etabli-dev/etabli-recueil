# @recueil/cli

`recueil` — the command line.

Anything the CLI can do, a script can do against the [REST API](../../spec/openapi.yaml); anything
the CLI cannot do, the API cannot do either (P6). Where the two overlap there is one implementation
behind both — `recueil export` calls the same selection and citation-key code the `.bib` endpoint
does, so the file a LaTeX build fetches and the file this command writes are the same bytes.

The data commands — `serve`, `import`, `export`, `backup`, `restore`, `ingest`, `queue`, `review` —
open the library directly rather than talking to a running server (ADR-0001). That is not a
shortcut: an importer writes fifty thousand records through the service layer in one process, and
its idempotency key and resume cursor live in the same database as the records. They take the same
flags and the same environment variables `serve` does. `rules test` opens neither a library nor a
socket: the rule evaluator is a pure function, which is what makes its dry run believable.

The intended command surface, the connection variables and the exit codes are documented in
[`docs/cli.qmd`](../../docs/cli.qmd). This README covers what the package actually does today.

## Status: Phase 2

Phase 2 delivers ingestion and the storage backends (CONCEPT.md §7). Nine commands work; the rest
exist, are listed in `recueil --help` with the phase that delivers them, and — when run — say so and
exit `1`. Two of those belong to Phase 1 and are still not built; the help text says so rather than
pretending otherwise.

| Command | Does | Status |
|---|---|---|
| `serve` | Start the server | **works** |
| `import zotero` | A whole Zotero library, with the verification report | **works** |
| `import paperless` | A whole Paperless-ngx server, with the verification report | **works** |
| `import bibtex\|biblatex\|ris\|csl-json` | A bibliography file | **works** |
| `export bibtex\|biblatex\|csl-json\|ris` | A selection, in an interchange format | **works** |
| `backup` / `restore` | Consistent snapshot and verified recovery | **works** |
| `ingest` | Push files through the ten stages of §5.3 | **works** |
| `ingest watch` | Run the configured sources in the foreground | **works** |
| `queue` | List, retry and cancel work-queue jobs | **works** |
| `review` | List, accept and reject review queue entries | **works** |
| `rules test` | Dry-run a rule set over a corpus | **works** |
| `token` | Create, list and revoke scoped API tokens | Phase 1 |
| `job` | Follow a running job and read its log | Phase 1 |
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
  This build is Phase 2, and ships: serve, import, export, backup, restore, ingest, queue,
  review, rules.
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
never reassigned (P3). Files named in a `file` field are reported, not fetched — that is
`recueil ingest`'s job.

### `recueil import paperless`

```sh
recueil import paperless --url https://paperless.example --dry-run
PAPERLESS_TOKEN=… recueil import paperless --url https://paperless.example
recueil import paperless --url https://paperless.example --resume
```

The same shape as the Zotero migration, and judged the same way: `report.json`, `report.md` and
`_REVIEW/` under `--report` (default `./paperless-import`), a parity table, the named checks, and an
exit code that carries the verdict. Every request is a `GET`; nothing in Paperless is changed.

Both sides of every count are queried — the Paperless side from what the API returned, the Recueil
side from the target library's own tables — so a report and a library that disagree fail the check
rather than agreeing with each other.

`@recueil/import-paperless` **has never spoken to a real Paperless-ngx server.** It was transcribed
from the published source of the release it names and is tested against an in-process fake of it.
The report records which release that was and whether the server that answered is that release, and
the summary prints that line rather than hiding it.

## `recueil ingest`

```sh
recueil ingest ~/Scans/2026-08-19.pdf
recueil ingest ~/Consume --source scanner --source-kind scanner --rules office.yaml
recueil ingest ~/Consume --dry-run --trace
recueil ingest ~/Scans --ocr ocrmypdf --ocr-lang deu --ocr-lang eng
```

The ten stages of CONCEPT.md §5.3, from `@recueil/ingest`. A run is idempotent by
`(hash, source, path)` and resumable by `--run-label`. The per-file table names, for each file, the
media type and text state read back off its `documents` row, the rules that fired, the score the
stage-9 gate compared against the threshold, and the outcome — and every one of those is queried
rather than remembered while deciding.

| Exit | Means |
|---|---|
| `0` | Everything offered was filed or already held |
| `4` | Filed, but documents went to the review queue or were refused by a rule |
| `5` | A file failed, or the run's own verification did not pass |

**Paths are hostile until resolved.** Every entry under a directory is resolved with `realpath` and
refused if it leaves the root; an archive member that climbs out of its scratch directory is refused
by name and the archive is refused whole rather than partly extracted. Both are reported: a file
that was not offered is listed with the reason.

**OCR is behind an interface, and `--ocr` says which implementation.**

| `--ocr` | What it is |
|---|---|
| `none` (default) | Nothing recognises anything. A scan is filed without text and the gate queues it. |
| `ocrmypdf` | Shells out to a real `ocrmypdf`. **No test in this repository exercises it**, and there is no container here to run one against. |
| `fake` | The in-process engine, driven by `--ocr-corpus` (a JSON map of sha256 → text). It proves the route — no text layer, engine called, text indexed, document findable — and recognises nothing it has not been given. |

`--dry-run` is a real run against a consistent copy of the library and a store that hashes and
discards, exactly as `import zotero --dry-run` is.

### `recueil ingest watch`

```sh
recueil ingest watch --folder ~/Consume --once
recueil ingest watch --folder ~/Scans --source-kind scanner --consume move
```

Runs the sources configured in the library, plus any `--folder` given, in the foreground, with a
line per pass. Ctrl-C finishes the pass in flight and stops.

A configured WebDAV or IMAP source keeps its password encrypted with `RECUEIL_SECRET_KEY`, which
only `apps/server` can open, so this command **names those rows and does not run them** rather than
skipping them in silence. They belong to `recueil serve`.

Nothing on the far side is moved or deleted until `@recueil/ingest-sources` has read the bytes back
out of the content store and matched them to their `documents` row.

## `recueil review` and `recueil queue`

```sh
recueil review list
recueil review accept 01M0T5… --note "checked by hand"
recueil review reject 01M0T5… --note "a blank separator page"
recueil queue list --state failed
recueil queue retry 01M0T5…
recueil queue cancel 01M0T5…
```

`review` works the queue P3 fills: the gate's reason code, its score, and the proposal accepting
will execute. This build can execute three of the seven proposed actions of
`spec/data-model.md` §6.1 — `create_item`, `discard` and `none` — and refuses the other four **by
name** rather than marking an entry accepted and doing nothing.

`queue` is the `jobs` table of ADR-0010. Retrying re-queues, keeping the cursor so the second
attempt resumes; a `running` job is refused, because two workers on one job is what the lease
prevents. Cancelling stops a job being picked up again and does not undo what it already committed —
the message says so.

An id may be given as a unique prefix.

## `recueil rules`

```sh
recueil rules validate office.yaml
recueil rules test office.yaml --against ~/Consume
recueil rules test office.yaml --against corpus.json --trace --markdown report.md
```

`--against` takes a directory of real documents — each file sniffed, and, for a PDF or a text file,
carrying the text a `text` condition will actually see — or a JSON/YAML file of subjects for the
cases a directory cannot express (a sender, a resolver outcome, a tag an earlier stage set).

Nothing is written, and not because of a flag: `@recueil/rules` evaluates a rule set as a pure
function of the set and a plain subject, with no database, no storage and no HTTP client to write
through. It is the same engine `recueil ingest --rules` puts at stage 8, which is what makes the dry
run a prediction rather than a report about a program nobody runs.

| Exit | Means |
|---|---|
| `0` | Every subject matched at least one rule |
| `1` | The rule set is not valid, or the corpus could not be read |
| `4` | Some subjects matched no rule and would still be filed by hand |
| `5` | A rule could not be evaluated over some subject |

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
have to claim either that Phase 1 had not started or that the two commands worked.

`buildProgram` checks the table against the registered implementations in both directions and throws
at start-up on either mismatch: a command marked as shipping with nothing behind it, and an
implementation the help text still calls unimplemented, are both a CLI that lies about itself.

## Licence

AGPL-3.0-or-later. See [`LICENSE`](../../LICENSE).
