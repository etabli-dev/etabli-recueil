# Run Recueil in a local container

The current image contains the CLI and HTTP API, SQLite, and a local file store. It does not serve the separate Vite web frontend. Start with synthetic data; production deployment and live-service interoperability have separate acceptance requirements.

**Verification status (2026-11-02):** a local Linux ARM64 image build and isolated CLI/API checks passed: non-root startup, token-required access, synthetic PDF upload/deduplication, restart persistence, verified backup and restoration to a separate empty volume with identical document bytes. The actual Compose service reached healthy and responded over its host-loopback port. See [the refinement record](../spec/refinement-2026-10.md) for the evidence and preserved harness failures. No registry image, multi-architecture release, sidecar integration or production deployment is claimed.

## Requirements and first start

Use Docker Engine **28.0.0 or newer** with Compose v2.24+ (`env_file.required` is used), sufficient disk for the dependency/build layers and library, and network access for the first image build. The image uses Node 22 and the repository's pinned pnpm. Docker Desktop/Colima or an equivalent engine is needed on macOS; installing the CLI alone is insufficient. The observed local ARM64 image size was 134,243,541 bytes; build-cache/disk use and minimum memory requirements have not been established. Podman has not been verified. The engine minimum matters for first-token setup: [Docker documents](https://docs.docker.com/engine/network/port-publishing/#publishing-ports) that versions before 28.0.0 can expose localhost-published ports to other hosts on the same network segment.

For an existing installation, compare its `.env` with the new example before running these commands. Preserve the original file, private keys and verified backups. The scaffold used `RECUEIL_VERSION` as an image tag; move that image-tag value to `RECUEIL_IMAGE_TAG` (the application version is now supplied at image build). Old bootstrap-token, worker and sidecar variables do not configure authentication or integrations in this server. Do not apply the unauthenticated first-token instructions to an existing remotely reachable instance: first review its published addresses and proxies, or keep authentication enabled and use an existing administrator token. No existing `.env` is rewritten by this guide.

From the repository root:

```sh
test -e deploy/.env || cp deploy/.env.example deploy/.env
cd deploy
docker compose up --build -d
docker compose logs --tail=100 recueil
curl --fail http://127.0.0.1:3000/health
```

Compose builds `deploy/Dockerfile`'s `runtime` target locally as `recueil:local`; no registry pull is required. It publishes only `127.0.0.1:3000`, runs as uid 1000, and stores state in its named `recueil-data` volume. The default permits unauthenticated local API access so the first token can be created. Keep this instance local until authentication is enabled. The health response should report a working database and writable storage; a running container alone does not establish readiness.

To select another local image name/tag or host port, edit `RECUEIL_IMAGE`, `RECUEIL_IMAGE_TAG` or `RECUEIL_PUBLISH_PORT` in `.env`. These are Compose settings; `RECUEIL_VERSION` is the application version embedded during image build. An existing data volume survives service recreation. Do not use `docker compose down -v` on a library you intend to keep.

## Create the first API token

The HTTP token API is implemented. The proposed `recueil token create` command and `RECUEIL_BOOTSTRAP_TOKEN` environment variable are not implemented.

While the server is reachable only on host loopback, save the one-time token response to a private temporary file. The response contains a secret; do not put it in logs, Git or screenshots.

```sh
umask 077
RECUEIL_TOKEN_FILE=$(mktemp "${TMPDIR:-/tmp}/recueil-token.XXXXXX")
curl --fail --silent --show-error \
  --header 'Content-Type: application/json' \
  --data '{"name":"local-administrator","scopes":["admin:*"]}' \
  --output "$RECUEIL_TOKEN_FILE" \
  http://127.0.0.1:3000/api/v1/tokens
```

Store the response's `secret` in your password manager. Set `RECUEIL_REQUIRE_AUTH=true` in `deploy/.env`, then run `docker compose up -d --force-recreate recueil` from `deploy/`. An unauthenticated `/api/v1/items` request must now return 401; the same request with `Authorization: Bearer <saved secret>` must return 200. `/health` remains available without a token. Create narrower scoped client tokens through the authenticated token API. Delete the temporary response only after its secret is safely saved and verified.

## Current configuration

[`.env.example`](.env.example) lists settings consumed by the current server; [config.ts](../apps/server/src/config.ts) is authoritative. Common settings are:

| Setting | Purpose |
|---|---|
| `RECUEIL_DATABASE_URL`, `RECUEIL_STORAGE_PATH` | SQLite file and content-addressed store; both default under `/data` in the image |
| `RECUEIL_REQUIRE_AUTH` | Require API bearer tokens; enable before remote access |
| `RECUEIL_BASE_URL`, `RECUEIL_CORS_ORIGIN` | Public base URL and explicitly allowed browser origins for the separate frontend |
| `RECUEIL_TRUST_PROXY` | Trust forwarded headers only behind a proxy you control |
| `RECUEIL_SECRET_KEY` | Privately backed-up 32-byte key for encrypted ingestion/storage credentials; required only when those credentials are stored |
| `RECUEIL_INGEST_ALLOWED_ROOTS` | Comma-separated absolute input roots inside the container; also mount those deliberate directories |
| `RECUEIL_INGEST_SCRATCH_PATH`, `RECUEIL_MAX_UPLOAD_BYTES` | Scratch directory and upload limit |
| `RECUEIL_OCR_ENGINE` | `none` in the base image; OCR requires a separately supplied executable and validated configuration |

Environment values can be read by the host/container administrator. The `${file:/run/secrets/name}` expansion described in design documents is not implemented by current server configuration; passing that text does not load a secret file. Back up any `RECUEIL_SECRET_KEY` privately: the redacted backup configuration cannot recover it.

## Backup and restore

From `deploy/`, take a uniquely named snapshot while the service runs, then verify it:

```sh
RECUEIL_SNAPSHOT="/data/backups/$(date -u +%Y%m%dT%H%M%SZ)"
docker compose exec -T recueil recueil backup --out "$RECUEIL_SNAPSHOT"
docker compose exec -T recueil recueil restore "$RECUEIL_SNAPSHOT" --verify-only
```

The snapshot includes a consistent SQLite copy, a storage manifest and blobs, plus redacted configuration. A backup on the same volume does not protect against loss of that volume: copy the verified snapshot to separately managed storage and retain its private configuration/key backup. For example, copy to a new directory outside the checkout:

```sh
mkdir -p "$HOME/Backups/recueil"
RECUEIL_BACKUP_COPY="$HOME/Backups/recueil/$(date -u +%Y%m%dT%H%M%SZ)"
test ! -e "$RECUEIL_BACKUP_COPY" && \
  docker compose cp "recueil:$RECUEIL_SNAPSHOT" "$RECUEIL_BACKUP_COPY"
```

Retain that verified copy on separately managed storage; a second directory on the same disk is not an off-device backup.

Restore into a new, empty location, without `--force`:

```sh
docker compose exec -T recueil recueil restore "$RECUEIL_SNAPSHOT" --into /data/restored-check
```

That writes `/data/restored-check/library.sqlite`, `storage/` and redacted `config/recueil.json`. It does not switch the running server to the restored library. Validate the restored files and application reads separately before choosing a recovery location; only then set `RECUEIL_DATABASE_URL` and `RECUEIL_STORAGE_PATH` to it and recreate the service. Keep the original library and backup until recovery is verified. Do not restore over an active database.

For an upgrade, take and externally retain a verified backup first, rebuild the desired source revision with `docker compose build recueil`, recreate with `docker compose up -d recueil`, and check health and representative library reads. Migrations run on startup; rollback may require restoring the pre-upgrade snapshot rather than starting an older binary against a migrated database.

## Build and distribution

From the repository root:

```sh
docker build -f deploy/Dockerfile --target runtime \
  --build-arg RECUEIL_VERSION=0.0.0-dev \
  --build-arg RECUEIL_REVISION="$(git rev-parse HEAD)" \
  -t recueil:local .
```

`.dockerignore` excludes local dependencies, generated outputs, Git metadata and local environment/key files. Lockfiles, package manifests, source, migrations, build scripts and fixtures remain build inputs. The image resolves the CLI launcher from its package manifest and copies its production dependency tree; neither pnpm nor workspace symlinks are required to run the deployed CLI.

The tag-triggered [release workflow](../.github/workflows/release.yml) prepares multi-architecture images and provenance/SBOM outputs. Its existence is not evidence that a particular image or attestation has been published. Do not substitute an assumed registry tag for the verified local build. Deployment of modified AGPL software must retain the applicable source-delivery notices and source access.

## Run the container regression check

The portable check requires host **Bash, Git and Python 3.9+**, Docker Engine **28.0.0+**, and Compose **2.24.4+**. The ordinary Compose guide above requires 2.24.0 for `env_file.required`; the smoke check additionally uses [`!override`, introduced in 2.24.4](https://docs.docker.com/reference/compose-file/merge/), to exclude the repository `.env` and existing volumes. The Docker daemon's loopback-published ports must be reachable from this host; a remote daemon requires deliberate port forwarding.

From the repository root, build the current runtime and exercise only disposable data:

```sh
bash deploy/smoke.sh --run
```

It prints a new evidence directory outside the checkout, builds for the daemon's native Linux architecture, and verifies non-root startup, PDF upload/deduplication, rejected inputs, token enforcement after restart, backup/restore with identical bytes, and the actual Compose healthcheck and host-loopback endpoint. Probe/fixture files are copied into newly created containers; the daemon does not need to bind-mount the checkout. The required `Container build and recovery` CI job runs this same command from a clean checkout and retains its evidence. The extracted command passed locally in existing-image mode on November 2, preserving all runtime/recovery/Compose assertions; the exact source revision's workflow result supplies clean-build CI evidence. A configured CI job is not a passing CI result.

To recheck an already-built local image without recompiling, provide its expected embedded application version:

```sh
bash deploy/smoke.sh --run --image recueil:local --expected-version 0.0.0-dev
```

This mode resolves the supplied image once to an immutable ID and records its identity separately from the current probe/Compose source snapshot. It does not claim that image was built from the current checkout. Use the version actually supplied when building that image. `--output /absolute/new/directory` optionally selects a nonexisting evidence directory outside the repository. The check never publishes an image or uses an existing library. On exit it stops only its labelled containers and retains those containers, unique images, networks and synthetic volumes for inspection; cleanup must verify the saved ownership prefix and must never use a global prune.

## Deferred integrations

[`docker-compose.sidecars.yml`](docker-compose.sidecars.yml) retains historical, profile-disabled sketches for GROBID, Meilisearch and Zotero translation-server. Current server configuration does not connect those services by the proposed environment variables. Starting them does not establish integration. The former OCR worker service/target was removed because `recueil worker` does not exist; no separate worker feature was added. The base image does not include OCRmyPDF/Tesseract.

`recueil check`, token-management CLI commands and several later roadmap commands remain explicitly unimplemented. Use `recueil --help` and the current API, not examples from the specification as proof of implemented behavior. Production reverse-proxy/TLS, authentication boundaries, external services, representative real-library recovery and resource limits still need their own validation. The completed synthetic local container check does not establish any of those.

## Without Docker

Follow the [repository README](../README.md) for frozen pnpm installation/build, CLI/API startup and the separate web frontend. Container use is optional.
