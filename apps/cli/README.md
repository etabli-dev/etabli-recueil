# @recueil/cli

`recueil` — the command line.

The CLI is a client of the [REST API](../../spec/openapi.yaml) like every other client, with one
exception: `recueil serve` starts the server rather than talking to one (ADR-0001). Anything the CLI
can do, a script can do against the API; anything the CLI cannot do, the API cannot do either (P6).

The intended command surface, the connection variables and the exit codes are documented in
[`docs/cli.qmd`](../../docs/cli.qmd). This README covers what the package actually does today.

## Status: Phase 0

Phase 0's exit criterion is "`recueil serve` returns health with an empty library"
(CONCEPT.md §7), and that is the whole of what works. Every other command exists, is listed in
`recueil --help` with the phase that delivers it, and — when run — says so and exits `1`.

| Command | Does | Phase |
|---|---|---|
| `serve` | Start the server | **0 — works** |
| `import` | Zotero, Paperless-ngx, BibTeX, RIS, EndNote XML, CSL-JSON, JabRef, CSV | 1 |
| `export` | BibTeX, BibLaTeX, CSL-JSON, RIS, JSON-LD, CSV, Parquet | 1 |
| `backup` / `restore` | Consistent snapshot and recovery | 1 |
| `token` | Create, list and revoke scoped API tokens | 1 |
| `job` | List, follow, retry and cancel jobs | 1 |
| `ingest` | Push files in, manage sources, work the review queue | 2 |
| `check` | Run the verification engine over a scope or a reference list | 3 |
| `dedup` | File and record deduplication, dry run by default | 3 |
| `plugin` | Install, enable, disable, configure, list | 3 |
| `graph` | Build edges, run a deep dive, export a network | 5 |
| `sr` | Systematic review: search runs, screening, extraction, PRISMA | 7 |

A placeholder fails rather than succeeding quietly, because a script that pipes `recueil export`
into a `.bib` file must not receive an empty file and a zero exit code. There is no partial
implementation behind any of them and no flag that turns one on.

```console
$ recueil check bibliography --file refs.txt
error `recueil check` is not implemented yet.

  It arrives in Phase 3 — Enrichment, checks, dedup (CONCEPT.md §7).
  This build is Phase 0, which ships `recueil serve` and nothing else.
...
$ echo $?
1
```

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

[`src/catalogue.ts`](src/catalogue.ts) holds every command, its summary and its phase. Help output,
the placeholder messages and the tests all render from it, so they cannot disagree. A command whose
phase has arrived but that has no implementation registered makes `buildProgram` throw at start-up:
the table cannot claim something ships while the placeholder silently answers for it.

## Licence

AGPL-3.0-or-later. See [`LICENSE`](../../LICENSE).
