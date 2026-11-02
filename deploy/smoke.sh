#!/usr/bin/env bash
# Exercise only disposable local container resources; nothing runs without --run.
set -euo pipefail
usage() {
  echo 'Usage: bash deploy/smoke.sh --run [--output NEW_DIRECTORY] [--image IMAGE --expected-version VERSION]' >&2
}
RUN=false
SUPPLIED_IMAGE=
EXPECTED_VERSION=
OUTPUT=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run) RUN=true; shift ;;
    --image|--expected-version|--output)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { usage; exit 2; }
      case "$1" in
        --image) SUPPLIED_IMAGE=$2 ;;
        --expected-version) EXPECTED_VERSION=$2 ;;
        --output) OUTPUT=$2 ;;
      esac
      shift 2 ;;
    *) usage; exit 2 ;;
  esac
done
[[ "$RUN" == true ]] || { usage; exit 2; }
if [[ -n "$SUPPLIED_IMAGE" && -z "$EXPECTED_VERSION" || -z "$SUPPLIED_IMAGE" && -n "$EXPECTED_VERSION" ]]; then
  echo '--image and --expected-version must be supplied together' >&2; exit 2
fi
REPOSITORY=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
PROBE="$REPOSITORY/deploy/smoke-probe.mjs"
# Keep evidence outside the checkout, so logs and private state cannot enter COPY . .
RUN_DIR=$(python3 - "$REPOSITORY" "$OUTPUT" <<'PY_OUTPUT'
import pathlib,sys,tempfile
repo=pathlib.Path(sys.argv[1]).resolve()
if sys.argv[2]:
 output=pathlib.Path(sys.argv[2]).expanduser().resolve()
 if output==repo or repo in output.parents:
  raise SystemExit('Smoke output must be outside the repository/build context')
 output.mkdir(parents=True,exist_ok=False)
else:
 parent=pathlib.Path(tempfile.gettempdir()).resolve()
 if parent==repo or repo in parent.parents:
  raise SystemExit('Temporary output must be outside the repository/build context')
 output=pathlib.Path(tempfile.mkdtemp(prefix='recueil-container-smoke-',dir=parent)).resolve()
print(output)
PY_OUTPUT
)
AUDIT_ID="recueil-smoke-$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:8])')"
BUILD_MODE=source_build
if [[ -n "$SUPPLIED_IMAGE" ]]; then BUILD_MODE=supplied_image; else EXPECTED_VERSION=0.0.0-local-smoke; fi
printf 'Container smoke evidence: %s\n' "$RUN_DIR"
CONTEXT=$(docker context show)
D=(docker --context "$CONTEXT")
IMAGE="recueil-smoke:$AUDIT_ID"
DATA="$AUDIT_ID-data"
RESTORED="$AUDIT_ID-restored"
API="$AUDIT_ID-api"
AUTH="$AUDIT_ID-auth"
RESTORE_JOB="$AUDIT_ID-restore-job"
RESTORED_API="$AUDIT_ID-restored-api"
COMPOSE_API="$AUDIT_ID-compose"
COMPOSE_DATA="$AUDIT_ID-compose-data"
CONTAINERS=("$API" "$AUTH" "$RESTORE_JOB" "$RESTORED_API" "$COMPOSE_API")
printf '%s
' "$AUDIT_ID" > "$RUN_DIR/owned-resource-prefix.txt"
printf '%s
' "$CONTEXT" > "$RUN_DIR/docker-context.txt"
"${D[@]}" version --format '{{json .Server}}' > "$RUN_DIR/docker-server.json"
"${D[@]}" compose version --short > "$RUN_DIR/compose-version.txt"
# Loopback unauthenticated bootstrap is documented only on Engine28+.
python3 - "$RUN_DIR/docker-server.json" <<'PY_ENGINE'
import json,re,sys
version=json.load(open(sys.argv[1]))['Version']
match=re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:[+-].*)?',version)
if not match or tuple(map(int,match.groups())) < (28,0,0):
 raise SystemExit('Docker Engine28.0.0+ is required before the local bootstrap check; observed '+version)
if tuple(map(int,match.groups())) == (28,0,0) and '-' in version:
 raise SystemExit('A stable Docker Engine28.0.0+ is required, not '+version)
PY_ENGINE
python3 - "$RUN_DIR/compose-version.txt" <<'PY_COMPOSE_VERSION'
import pathlib,re,sys
version=pathlib.Path(sys.argv[1]).read_text().strip().removeprefix('v')
match=re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:[+-].*)?',version)
if not match or tuple(map(int,match.groups())) < (2,24,4):
 raise SystemExit('Compose2.24.4+ is required for isolated !override configuration; observed '+version)
if tuple(map(int,match.groups())) == (2,24,4) and '-' in version:
 raise SystemExit('A stable Compose2.24.4+ is required, not '+version)
PY_COMPOSE_VERSION
# Preserve owned containers/volumes and logs for review; stop only this run's servers.
finish() {
  result=$?
  trap - EXIT
  for name in "${CONTAINERS[@]}"; do
    if ! label=$("${D[@]}" inspect --format '{{index .Config.Labels "dev.etabli.audit"}}' "$name" 2> "$RUN_DIR/$name.ownership.stderr"); then
      # A failed/partial run may not have created this name; it must never turn a
      # successful run into an unverified claim that every owned container stopped.
      printf 'Could not verify expected container ownership: %s\n' "$name" >&2
      result=1
      continue
    fi
    if [[ "$label" == "$AUDIT_ID" ]]; then
      "${D[@]}" logs "$name" > "$RUN_DIR/$name.log" 2>&1 || true
      if ! "${D[@]}" stop --time 20 "$name" > /dev/null 2> "$RUN_DIR/$name.stop.stderr"; then result=1; fi
      if ! "${D[@]}" inspect "$name" > "$RUN_DIR/$name.inspect.json" 2> "$RUN_DIR/$name.inspect.stderr"; then
        result=1
      elif ! python3 - "$RUN_DIR/$name.inspect.json" <<'PY_STOPPED'
import json,sys
assert json.load(open(sys.argv[1]))[0]['State']['Running'] is False, 'Owned container is still running'
PY_STOPPED
      then result=1; fi
    else
      printf 'Refusing to stop a container with an unexpected ownership label: %s\n' "$name" >&2
      result=1
    fi
  done
  printf '%s
' "$result" > "$RUN_DIR/exit-code.txt"
  printf 'Container check exit %s; retained evidence/resources: %s
' "$result" "$RUN_DIR"
  exit "$result"
}
trap finish EXIT
for name in "${CONTAINERS[@]}"; do
  if "${D[@]}" container inspect "$name" >/dev/null 2>&1; then
    echo "Refusing an existing container name: $name" >&2; exit 1
  fi
done
for name in "$DATA" "$RESTORED" "$COMPOSE_DATA"; do
  if "${D[@]}" volume inspect "$name" >/dev/null 2>&1; then
    echo "Refusing an existing volume name: $name" >&2; exit 1
  fi
done
python3 - "$REPOSITORY" "$RUN_DIR/source-snapshot.json" <<'PY_SNAPSHOT'
import sys, pathlib, subprocess, hashlib, json, datetime
repo=pathlib.Path(sys.argv[1]); paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=repo).decode().split('\0')
paths.append('.dockerignore'); files={}
for name in sorted(set(paths)-{''}):
 p=repo/name
 if p.is_file(): files[name]=hashlib.sha256(p.read_bytes()).hexdigest()
result={'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'repository':str(repo),'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'working_tree':subprocess.check_output(['git','status','--porcelain=v1'],cwd=repo,text=True),'files_sha256':files}
pathlib.Path(sys.argv[2]).write_text(json.dumps(result,indent=2)+'\n')
PY_SNAPSHOT
REVISION=$(git -C "$REPOSITORY" rev-parse HEAD)
if "${D[@]}" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Refusing an existing image name: $IMAGE" >&2; exit 1
fi
if [[ "$BUILD_MODE" == source_build ]]; then
  "${D[@]}" build --progress=plain -f "$REPOSITORY/deploy/Dockerfile" --target runtime \
    --build-arg "RECUEIL_VERSION=$EXPECTED_VERSION" \
    --build-arg "RECUEIL_REVISION=$REVISION-working-tree" \
    --label "dev.etabli.audit=$AUDIT_ID" --tag "$IMAGE" "$REPOSITORY" \
    > "$RUN_DIR/build.log" 2>&1
else
  # Resolve once, then create a unique alias for Compose; never rebuild or repull it.
  IMAGE_ID=$("${D[@]}" image inspect --format '{{.Id}}' "$SUPPLIED_IMAGE")
  "${D[@]}" image tag "$IMAGE_ID" "$IMAGE"
fi
"${D[@]}" image inspect "$IMAGE" > "$RUN_DIR/image.inspect.json"
IMAGE_ID=$("${D[@]}" image inspect --format '{{.Id}}' "$IMAGE")
python3 - "$RUN_DIR" "$BUILD_MODE" "$SUPPLIED_IMAGE" "$EXPECTED_VERSION" <<'PY_PROVENANCE'
import pathlib,sys,json
out=pathlib.Path(sys.argv[1]); image=json.loads((out/'image.inspect.json').read_text())[0]
assert image['Os']=='linux', 'This check requires a Linux runtime image'
assert image['Architecture'], 'Image architecture must be recorded'
(out/'image-provenance.json').write_text(json.dumps({'mode':sys.argv[2],'supplied_image':sys.argv[3] or None,'immutable_image_id':image['Id'],'os':image['Os'],'architecture':image['Architecture'],'expected_version':sys.argv[4],'current_source_built':sys.argv[2]=='source_build','source_snapshot_scope':'Image build input snapshot' if sys.argv[2]=='source_build' else 'Current probe/Compose checkout only; supplied image build provenance is not inferred'},indent=2)+'\n')
PY_PROVENANCE
"${D[@]}" volume create --label "dev.etabli.audit=$AUDIT_ID" "$DATA" > /dev/null
"${D[@]}" volume create --label "dev.etabli.audit=$AUDIT_ID" "$RESTORED" > /dev/null
BASE_FLAGS=(--network none --memory 768m --cpus 1 --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges --label "dev.etabli.audit=$AUDIT_ID")
wait_for_health() {
  local name=$1
  for attempt in $(seq 1 30); do
    if "${D[@]}" exec -e "RECUEIL_SMOKE_EXPECTED_VERSION=$EXPECTED_VERSION" "$name" node /audit-probe.mjs health > "$RUN_DIR/$name.health.json" 2> "$RUN_DIR/$name.health.stderr"; then return 0; fi
    sleep 2
  done
  echo "Healthy startup not observed: $name" >&2; return 1
}
"${D[@]}" create --name "$API" "${BASE_FLAGS[@]}" \
  --mount "type=volume,source=$DATA,target=/data" \
  "$IMAGE_ID" serve > "$RUN_DIR/api-container-id.txt"
"${D[@]}" cp "$PROBE" "$API:/audit-probe.mjs"
"${D[@]}" cp "$REPOSITORY/fixtures/scans/born-digital.pdf" "$API:/fixture.pdf"
"${D[@]}" start "$API" > /dev/null
wait_for_health "$API"
"${D[@]}" exec -e "RECUEIL_SMOKE_EXPECTED_VERSION=$EXPECTED_VERSION" "$API" node /audit-probe.mjs seed > "$RUN_DIR/seed.json"
"${D[@]}" stop --time 20 "$API" > /dev/null
# Recreate against the same synthetic volume, now requiring a persisted API token.
"${D[@]}" create --name "$AUTH" "${BASE_FLAGS[@]}" \
  --mount "type=volume,source=$DATA,target=/data" -e RECUEIL_REQUIRE_AUTH=true \
  "$IMAGE_ID" serve > "$RUN_DIR/auth-container-id.txt"
"${D[@]}" cp "$PROBE" "$AUTH:/audit-probe.mjs"
"${D[@]}" start "$AUTH" > /dev/null
wait_for_health "$AUTH"
"${D[@]}" exec -e "RECUEIL_SMOKE_EXPECTED_VERSION=$EXPECTED_VERSION" "$AUTH" node /audit-probe.mjs check > "$RUN_DIR/restart-auth.json"
"${D[@]}" exec "$AUTH" recueil --json backup --out /data/audit-snapshot > "$RUN_DIR/backup.json"
"${D[@]}" exec "$AUTH" recueil --json restore /data/audit-snapshot --verify-only > "$RUN_DIR/verify.json"
"${D[@]}" stop --time 20 "$AUTH" > /dev/null
"${D[@]}" run --name "$RESTORE_JOB" "${BASE_FLAGS[@]}" \
  --mount "type=volume,source=$DATA,target=/original,readonly" \
  --mount "type=volume,source=$RESTORED,target=/data" \
  "$IMAGE_ID" --json restore /original/audit-snapshot --into /data/restored > "$RUN_DIR/restore.json"
"${D[@]}" create --name "$RESTORED_API" "${BASE_FLAGS[@]}" \
  --mount "type=volume,source=$DATA,target=/original,readonly" \
  --mount "type=volume,source=$RESTORED,target=/data" \
  -e RECUEIL_DATABASE_URL=file:/data/restored/library.sqlite \
  -e RECUEIL_STORAGE_PATH=/data/restored/storage -e RECUEIL_REQUIRE_AUTH=true \
  "$IMAGE_ID" serve > "$RUN_DIR/restored-container-id.txt"
"${D[@]}" cp "$PROBE" "$RESTORED_API:/audit-probe.mjs"
"${D[@]}" start "$RESTORED_API" > /dev/null
wait_for_health "$RESTORED_API"
"${D[@]}" exec -e "RECUEIL_SMOKE_EXPECTED_VERSION=$EXPECTED_VERSION" "$RESTORED_API" node /audit-probe.mjs check /original > "$RUN_DIR/restored-readback.json"
# Exercise the real Compose service definition using isolated explicit overrides.
# !override requires Compose2.24.4+, checked before resources are created.
cat > "$RUN_DIR/compose.env" <<'COMPOSE_ENV'
RECUEIL_HOST=0.0.0.0
RECUEIL_PORT=3000
RECUEIL_DATABASE_URL=file:/data/recueil.sqlite
RECUEIL_STORAGE_PATH=/data/storage
RECUEIL_REQUIRE_AUTH=false
RECUEIL_LOG_LEVEL=info
RECUEIL_OCR_ENGINE=none
COMPOSE_ENV
python3 - "$RUN_DIR" "$AUDIT_ID" "$IMAGE" "$COMPOSE_API" "$COMPOSE_DATA" <<'PY_COMPOSE'
import sys,json,pathlib
out=pathlib.Path(sys.argv[1]); audit,image,name,volume=sys.argv[2:]
q=json.dumps
(out/'compose.override.yml').write_text(f'''services:
  recueil:
    image: {q(image)}
    container_name: {q(name)}
    pull_policy: never
    env_file: !override
      - path: {q(str(out/'compose.env'))}
        required: true
    ports: !override
      - target: 3000
        published: "0"
        host_ip: "127.0.0.1"
        protocol: tcp
    volumes: !override
      - type: volume
        source: recueil-data
        target: /data
    labels:
      dev.etabli.audit: {q(audit)}
    cpus: 1
    mem_limit: 768m
    pids_limit: 256
    restart: "no"
volumes:
  recueil-data:
    name: {q(volume)}
    labels:
      dev.etabli.audit: {q(audit)}
networks:
  default:
    labels:
      dev.etabli.audit: {q(audit)}
''')
PY_COMPOSE
C=("${D[@]}" compose --project-name "$AUDIT_ID" --env-file "$RUN_DIR/compose.env" -f "$REPOSITORY/deploy/docker-compose.yml" -f "$RUN_DIR/compose.override.yml")
"${C[@]}" config --format json > "$RUN_DIR/compose-config.json"
"${C[@]}" create --no-build --pull never recueil > "$RUN_DIR/compose-create.log" 2>&1
"${D[@]}" cp "$PROBE" "$COMPOSE_API:/audit-probe.mjs"
"${C[@]}" up --no-build --pull never -d recueil > "$RUN_DIR/compose-start.log" 2>&1
wait_for_health "$COMPOSE_API"
# Observe the unchanged Compose healthcheck itself, as well as the stricter API probe.
for attempt in $(seq 1 45); do
  state=$("${D[@]}" inspect --format '{{.State.Health.Status}}' "$COMPOSE_API")
  printf '%s\n' "$state" >> "$RUN_DIR/compose-health-states.txt"
  if [[ "$state" == healthy ]]; then break; fi
  if [[ "$state" == unhealthy ]]; then echo 'Compose service became unhealthy' >&2; exit 1; fi
  sleep 2
done
[[ "$state" == healthy ]] || { echo 'Compose service healthcheck did not become healthy' >&2; exit 1; }
"${D[@]}" inspect "$COMPOSE_API" > "$RUN_DIR/compose-running.inspect.json"
"${D[@]}" volume inspect "$COMPOSE_DATA" > "$RUN_DIR/compose-volume.inspect.json"
"${D[@]}" network inspect "${AUDIT_ID}_default" > "$RUN_DIR/compose-network.inspect.json"
"${C[@]}" port recueil 3000 > "$RUN_DIR/compose-published-port.txt"
python3 - "$RUN_DIR" "$AUDIT_ID" "$IMAGE_ID" <<'PY_COMPOSE_CHECK'
import sys,pathlib,json,urllib.request
p=pathlib.Path(sys.argv[1]);audit=sys.argv[2]
config=json.loads((p/'compose-config.json').read_text()); service=config['services']['recueil']
assert service['environment']['RECUEIL_REQUIRE_AUTH']=='false'
assert service['image'].startswith('recueil-smoke:')
inspect=json.loads((p/'compose-running.inspect.json').read_text())[0]
assert inspect['Config']['Labels']['dev.etabli.audit']==audit
assert inspect['Image']==sys.argv[3], 'Compose must use the resolved immutable image'
assert inspect['Config']['User'] not in ('','0','root')
assert inspect['State']['Health']['Status']=='healthy'
volume=json.loads((p/'compose-volume.inspect.json').read_text())[0]
network=json.loads((p/'compose-network.inspect.json').read_text())[0]
assert volume['Labels']['dev.etabli.audit']==audit
assert network['Labels']['dev.etabli.audit']==audit and network['Internal'] is False
endpoint=(p/'compose-published-port.txt').read_text().strip()
assert endpoint.startswith('127.0.0.1:') and int(endpoint.rsplit(':',1)[1])>0, endpoint
with urllib.request.urlopen('http://'+endpoint+'/health',timeout=10) as response:
 assert response.status==200
 health=json.load(response)
assert health['database']['ok'] and health['storage']['ok']
(p/'compose-acceptance.json').write_text(json.dumps({'status':'pass','project':audit,'published_endpoint':endpoint,'image':service['image'],'loopback_http_health':True,'compose_healthcheck':'healthy','nonroot':True,'repository_env_file_used':False,'existing_library_used':False},indent=2)+'\n')
PY_COMPOSE_CHECK
python3 - "$RUN_DIR" <<'PY_RESULTS'
import pathlib,sys,json
p=pathlib.Path(sys.argv[1]); read=lambda name:json.loads((p/name).read_text())
image=read('image.inspect.json')[0]
assert image['Os']=='linux' and image['Architecture']
seed=read('seed.json'); restart=read('restart-auth.json'); restored=read('restored-readback.json'); verify=read('verify.json'); result=read('restore.json')
assert verify['ok'] is True and not verify['failures']
assert result['blobsRestored'] >= 1
for key in ['itemId','documentId','sha256','byteSize']:
 assert seed[key]==restart[key]==restored[key], key
(p/'acceptance.json').write_text(json.dumps({'status':'pass','scope':'Local Linux '+image['Architecture']+' development runtime; synthetic API/auth/blob persistence/backup/restore only','image_provenance':read('image-provenance.json'),'source_snapshot':'source-snapshot.json','health_nonroot':True,'deduplication':True,'invalid_input':True,'token_required':True,'restart_persistence':True,'backup_verified':True,'compose_local_loopback_health':read('compose-acceptance.json')['status']=='pass','restored_blob_hash':restored['sha256'],'not_verified':['published registry image','multi-architecture image','reverse proxy or public deployment','live services','representative real library','sidecars','OCR worker']},indent=2)+'\n')
PY_RESULTS
