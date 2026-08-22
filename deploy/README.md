# Deploying Recueil

Recueil is one container with one volume. SQLite is the database (ADR-0015), the file store is a
directory beside it, and the job queue runs inside the server process (ADR-0010), so a working
install needs nothing else. The sidecars in this directory are options, not parts.

> **Status: none of this has been run.**
> At Phase 0 the repository is a specification and a scaffold. The workspace produces no build
> output, so `deploy/Dockerfile` has never been built, the image referenced below does not exist in
> the registry yet, and the compose files have never started anything. What is here is the intended
> deployment, written so that Phase 1 has something to make true rather than something to invent.
> Where the files and the code disagree once the code lands, assume the files are wrong.

## What is in this directory

| File | Purpose |
|---|---|
| [`Dockerfile`](Dockerfile) | Multi-stage build of the server image. Build context is the repository root, not this directory |
| [`docker-compose.yml`](docker-compose.yml) | The base deployment: the server, a named volume, a healthcheck |
| [`docker-compose.sidecars.yml`](docker-compose.sidecars.yml) | The optional sidecars from CONCEPT.md §5.1, one Compose profile each |
| [`.env.example`](.env.example) | Every variable the server reads, documented, with safe defaults |

## Requirements

| | |
|---|---|
| Docker Engine | 24 or newer |
| Docker Compose | v2.24 or newer — `env_file:` with `required: false` needs it |
| Architecture | linux/amd64 or linux/arm64; the release image is a multi-architecture manifest, so `docker pull` picks the right one |
| Disk | The library, mostly. Image size is unmeasured because nothing has been built yet; expect a few hundred megabytes, and roughly half a gigabyte more for the OCR variant |
| Memory | 512 MB is enough for the server alone. GROBID wants 4–6 GB of its own, which is why it is a sidecar |

Podman 5 with `podman compose` should work — nothing here needs the Docker socket, a privileged
container or a user namespace trick — but it has not been tried.

## Quick start

```sh
cd deploy
cp .env.example .env
$EDITOR .env          # optional: every variable has a working default
docker compose up -d
docker compose logs -f recueil
```

Then check that it is alive, which is Phase 0's exit criterion:

```sh
curl http://127.0.0.1:3000/health
```

Create an API token for the clients (web UI, CLI, R, Python, MCP), unless you set
`RECUEIL_BOOTSTRAP_TOKEN` in `.env` and let the server create one at boot:

```sh
docker compose exec recueil recueil token create --name laptop --scope '*'
```

Any CLI subcommand works the same way — the image's entrypoint is the CLI, so `serve` is only the
default command:

```sh
docker compose exec recueil recueil check run --all
docker compose exec recueil recueil import zotero /data/import/zotero.sqlite
```

## Configuration

Everything is environment variables (CONCEPT.md §5.15); there is no configuration file to mount.
[`.env.example`](.env.example) documents each one and is the reference — the summary below is only
the shape of it.

| Group | Variables | Notes |
|---|---|---|
| Core | `RECUEIL_HOST`, `RECUEIL_PORT`, `RECUEIL_LOG_LEVEL`, `RECUEIL_BASE_URL` | Leave `RECUEIL_HOST` at `0.0.0.0`; publish the port with `RECUEIL_PUBLISH_ADDR`/`RECUEIL_PUBLISH_PORT` instead |
| Storage | `RECUEIL_DATABASE_URL`, `RECUEIL_STORAGE_PATH`, `RECUEIL_SCRATCH_PATH` | All on `/data` by default. The URL scheme selects the driver (ADR-0003) |
| Jobs | `RECUEIL_JOB_CONCURRENCY`, `RECUEIL_INGEST_CONCURRENCY` | Conservative by default: the resolvers are rate-limited upstream |
| Search | `RECUEIL_SEARCH_BACKEND`, `RECUEIL_MEILISEARCH_*` | FTS5 unless you enable the `search` profile (ADR-0011) |
| Sidecars | `RECUEIL_GROBID_URL`, `RECUEIL_TRANSLATION_SERVER_URL`, `RECUEIL_OCR_*` | Unset means the feature is off, not broken |
| Enrichment | `CROSSREF_*`, `OPENALEX_*`, `NCBI_*`, `SEMANTIC_SCHOLAR_API_KEY`, `UNPAYWALL_EMAIL`, `ORCID_*` | All optional. Every resolver works without a key, more slowly |

Two things about credentials. First, a contact address is worth more than a key: `CROSSREF_MAILTO`
and `OPENALEX_MAILTO` put requests in the polite pool, which is faster and less likely to be
throttled than anonymous access, and `UNPAYWALL_EMAIL` is required rather than optional — Unpaywall
stays off until it is set. Second, values in `.env` are readable by anything that can read the file
and show up in `docker inspect`. For a deployment where that matters, use Docker secrets and the
`${file:/run/secrets/name}` reference form (spec/plugin-api.md §4.3) instead of putting the secret in
the environment.

## Sidecars

Each sidecar is a Compose profile in [`docker-compose.sidecars.yml`](docker-compose.sidecars.yml).
Nothing starts unless its profile is named, and the overlay file has to be passed after the base
file:

```sh
docker compose -f docker-compose.yml -f docker-compose.sidecars.yml --profile grobid up -d
```

Setting these two in `.env` saves repeating the flags:

```sh
COMPOSE_FILE=docker-compose.yml:docker-compose.sidecars.yml
COMPOSE_PROFILES=grobid,search
```

| Profile | Service | Gives you | Also set in `.env` |
|---|---|---|---|
| `grobid` | GROBID | Title, authors, DOI, abstract, reference lists and in-text citation contexts from scholarly PDFs (§5.3, §5.8) | `RECUEIL_GROBID_URL=http://grobid:8070` |
| `ocr` | OCR worker | OCRmyPDF and Tesseract for scans with no text layer (§5.3) | `RECUEIL_OCR_ENABLED=true`, `RECUEIL_OCR_LANGUAGES` |
| `search` | Meilisearch | Typo-tolerant, faceted search for large libraries (ADR-0011) | `RECUEIL_SEARCH_BACKEND=meilisearch`, `RECUEIL_MEILISEARCH_URL`, `RECUEIL_MEILISEARCH_KEY`, `MEILI_MASTER_KEY` |
| `translation` | zotero/translation-server | URL, DOI, PMID, ISBN and arXiv import through the Zotero translators (ADR-0006) | `RECUEIL_TRANSLATION_SERVER_URL=http://translation-server:1969` |

Starting a profile is deliberately only half of it. The server ignores a sidecar until it is given
the URL, so a URL that is set but not answering is a misconfiguration worth reporting, while a URL
that is unset is a feature that is simply off.

The fifth sidecar in CONCEPT.md §5.1, the SciCite citation-intent model, has no service here: the
published model is a research artefact rather than something with a maintained image, so packaging
it is Phase 5 work. Until then citation contexts are stored unclassified.

### The OCR worker is a caveat, not just a profile

The OCR profile is the one place in this directory that argues with an ADR. ADR-0010 puts the job
queue in the database and runs it inside the server process, and says in as many words that a
single-container deployment stays single-container. The `ocr` profile starts a second container that
opens the same SQLite file to take OCR jobs. On one host, with the same volume and WAL journalling,
that works — but it is a deployment shape the ADR did not sanction, so it is off by default. The
reason to want it is that the OCR toolchain is about half a gigabyte the base image otherwise carries
for a feature many libraries never use. If it proves worth keeping, it needs an ADR of its own.

It is also not a published image, so it has to be built:

```sh
docker compose -f docker-compose.yml -f docker-compose.sidecars.yml --profile ocr build
docker compose -f docker-compose.yml -f docker-compose.sidecars.yml --profile ocr up -d
```

## Building the image

The Dockerfile has two publishable stages. Pass `--target` in anything scripted rather than relying
on stage order.

```sh
# from the repository root, not from deploy/
docker build -f deploy/Dockerfile --target runtime    -t recueil:dev .
docker build -f deploy/Dockerfile --target ocr-worker -t recueil-ocr:dev .
```

Multi-architecture, the way the release workflow does it:

```sh
docker buildx build \
  -f deploy/Dockerfile --target runtime \
  --platform linux/amd64,linux/arm64 \
  --build-arg RECUEIL_VERSION=0.1.0 \
  --build-arg RECUEIL_REVISION="$(git rev-parse HEAD)" \
  -t ghcr.io/etabli-dev/recueil:0.1.0 .
```

Notes on the build:

- The build needs a committed `pnpm-lock.yaml`. `pnpm fetch` runs from the lockfile alone so that a
  source edit does not invalidate the dependency download layer; a build that fails at that step is
  telling you the lockfile is missing, which is the same thing CI's `--frozen-lockfile` says.
- The runtime is Debian slim rather than Alpine. SQLite and image handling reach for native modules,
  and prebuilt binaries exist for glibc far more reliably than for musl; the size saving is not worth
  compiling `better-sqlite3` from source on every arm64 release.
- The entrypoint is resolved at build time from the deployed package's own `bin` field, so it fails
  loudly at build time rather than producing an image whose entrypoint is not there.
- There is no `.dockerignore` in the repository yet, so `COPY . .` currently pulls in `.git` and any
  local `node_modules`. That costs build time, not image size — the runtime stage copies only the
  pruned production tree — but it should be added.

## Releases, provenance and SBOM

Tagging `v*` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds
`linux/amd64` and `linux/arm64` and pushes to `ghcr.io/etabli-dev/recueil`. Every image carries SLSA
provenance and an SBOM as attestations, plus a signed GitHub attestation, so what you pull can be
checked against the commit it came from:

```sh
gh attestation verify oci://ghcr.io/etabli-dev/recueil:0.1.0 --owner etabli-dev
docker buildx imagetools inspect ghcr.io/etabli-dev/recueil:0.1.0 --format '{{ json .Provenance }}'
```

A standalone SPDX document is attached to each release run as a workflow artefact, for scanners that
want a file rather than an attestation.

## Data, backup and restore

Everything stateful lives on one volume:

```
/data
  recueil.sqlite      the library: items, metadata, annotations, jobs, audit log
  storage/            the content-addressed file store, laid out by SHA-256
  scratch/            archive extraction, cleaned after hashing
```

The store is readable without the application, by design (P10): the files are the original bytes
under their hashes, and the database is plain SQLite that `sqlite3` or DuckDB will open.

Back up with the CLI rather than by copying the database file out from under a running server —
`recueil backup` takes a consistent snapshot of the database, a storage manifest and the
configuration, in a layout restic is happy with (CONCEPT.md §5.15):

```sh
docker compose exec recueil recueil backup --output /data/backups
restic -r /srv/restic backup /var/lib/docker/volumes/recueil_recueil-data/_data/backups
```

Restore into an empty volume:

```sh
docker compose run --rm recueil restore --from /data/backups/<snapshot>
```

To copy the volume somewhere else wholesale, stop the server first so SQLite is not mid-write:

```sh
docker compose stop recueil
docker run --rm -v recueil_recueil-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/recueil-data.tar.gz -C /data .
docker compose start recueil
```

### Bind mounts and file ownership

The container runs as uid 1000 (`node`). A named volume inherits the image's ownership, which is why
that is the default. If you would rather see the files on the host, mount a directory you have first
chowned:

```sh
sudo mkdir -p /srv/recueil
sudo chown -R 1000:1000 /srv/recueil
```

and replace the volume line in `docker-compose.yml` with `- /srv/recueil:/data`. Permission errors on
first start are almost always this.

## Reverse proxy and TLS

The container speaks plain HTTP and binds to loopback on the host by default. Terminate TLS in front
of it. With Caddy that is two lines:

```caddy
recueil.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

Set `RECUEIL_BASE_URL=https://recueil.example.org` so generated links, webhook payloads and the
tokened `.bib` endpoints carry the public URL, and `RECUEIL_TRUST_PROXY=true` so the audit log records
the real client address rather than the proxy's. Turn that on only when the proxy in front is one you
control, because it means believing `X-Forwarded-For`.

Recueil is a single-user application with token authentication and no rate limiting in v1. A
Tailscale or WireGuard address is a better place for it than the public internet, and if it is on the
public internet, it wants at least a proxy that enforces basic rate limits.

**AGPL, briefly.** If you run a modified Recueil where other people can reach it over a network, the
licence requires you to offer them the modified source (AGPL-3.0-or-later §13, ADR-0005). Running an
unmodified released image satisfies this by pointing at the upstream repository.

## Upgrading

```sh
docker compose exec recueil recueil backup --output /data/backups   # first
docker compose pull
docker compose up -d
```

Migrations run at start-up and are logged. Pin `RECUEIL_VERSION` to a version rather than `latest` in
anything you rely on, and read the release notes before a major: the plugin API and the data model
may both change under a migration before 1.0 (CONTRIBUTING.md).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `container is unhealthy` at first start | The healthcheck's start period is 60 s; a first start that migrates and indexes a large imported library can exceed it. Check `docker compose logs recueil` before raising it |
| `EACCES` on `/data` | A bind mount owned by someone other than uid 1000. See above |
| Meilisearch exits immediately | `MEILI_MASTER_KEY` is unset. It is required in production mode |
| Enrichment is slow, and the log is full of 429s | No contact address. Set `CROSSREF_MAILTO` and `OPENALEX_MAILTO`; they cost nothing and change the rate limit |
| GROBID is killed | It wants 4–6 GB. The `deploy.resources.limits` entry in the sidecars file is a ceiling, not a reservation |
| `pnpm-lock.yaml: not found` during build | The lockfile is not committed. See "Building the image" |
| The image builds the OCR variant unexpectedly | `--target` was not passed. The default is `runtime`, but say so explicitly |

## Running without Docker

The server is a Node process; Docker is a convenience, not a requirement. The same code runs as a
Tauri sidecar in desktop mode (CONCEPT.md §5.1).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
RECUEIL_DATABASE_URL=file:./data/recueil.sqlite \
RECUEIL_STORAGE_PATH=./data/storage \
  pnpm --filter @recueil/cli exec recueil serve
```

Node 22 LTS is the reference runtime; CI also tests 24.
