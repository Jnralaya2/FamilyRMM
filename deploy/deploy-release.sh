#!/bin/sh
set -eu
umask 077

bundle_path=${1:-/root/.deploy-bundle-current.zip}
public_host=${2:-familyrmm.xyz}
app_dir=/opt/family-rmm
backup_root=/var/backups/family-rmm
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir=$backup_root/deploy-$stamp
db_backup_in_volume=/var/lib/family-rmm/backups/rmm-$stamp.sqlite
rollback_ready=0
image_probe_ready=0
image_probe_container=
image_probe_dir=
failed_dir=$backup_root/failed-release-$stamp-$$
failed_app_id=
failed_image_id=
failed_image_tag=
restored_caddy_id=
latest_tmp=
old_image_id=
old_caddy_image_id=
old_caddy_container_id=
compose_image=
caddy_compose_image=

case "$public_host" in
  ''|*[!A-Za-z0-9.-]*) echo 'Invalid public hostname.' >&2; exit 1 ;;
esac

fail() {
  printf '%s\n' "ERROR: $*" >&2
  exit 1
}

wait_for_app() {
  attempt=0
  while [ "$attempt" -lt 90 ]; do
    app_id=$(docker compose ps -q app 2>/dev/null || true)
    if [ -n "$app_id" ]; then
      app_health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_id" 2>/dev/null || true)
      if [ "$app_health" = healthy ]; then return 0; fi
      if [ "$app_health" = exited ] || [ "$app_health" = dead ]; then break; fi
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  docker compose ps >&2 || true
  return 1
}

restore_previous() {
  printf 'Deployment failed; restoring the previous source tree and application images. The SQLite database will be left unchanged.\n' >&2
  failed_app_id=$(docker compose ps -a -q app 2>/dev/null || true)
  if [ -n "$failed_app_id" ]; then
    failed_image_id=$(docker inspect -f '{{.Image}}' "$failed_app_id" 2>/dev/null || true)
    if [ -n "$failed_image_id" ] && [ "$failed_image_id" != "$old_image_id" ]; then
      if [ -e "$failed_dir" ]; then
        printf 'Rollback note: not preserving the failed image because the diagnostic path already exists: %s\n' "$failed_dir" >&2
      elif install -d -m 700 "$failed_dir"; then
        failed_image_tag=${compose_image%:*}:familyrmm-failed-$stamp-$$
        if docker image tag "$failed_image_id" "$failed_image_tag" && printf '%s\n' "$failed_image_id" > "$failed_dir/image-id"; then
          printf 'Failed image preserved for diagnosis as %s (%s).\n' "$failed_image_tag" "$failed_image_id" >&2
        else
          printf 'Rollback warning: could not preserve failed image %s; continuing with restoration.\n' "$failed_image_id" >&2
        fi
      else
        printf 'Rollback warning: could not create diagnostic directory %s; continuing with restoration.\n' "$failed_dir" >&2
      fi
    fi
  fi
  if ! tar -xzf "$backup_dir/project.tar.gz" -C "$app_dir"; then
    printf 'ROLLBACK ERROR: could not restore the backed-up application files from %s/project.tar.gz.\n' "$backup_dir" >&2
    return 1
  fi
  if ! docker image tag "$old_image_id" "$compose_image"; then
    printf 'ROLLBACK ERROR: could not retag the previous application image %s as %s.\n' "$old_image_id" "$compose_image" >&2
    return 1
  fi
  if [ -n "$old_caddy_image_id" ] && [ -n "$caddy_compose_image" ] && ! docker image tag "$old_caddy_image_id" "$caddy_compose_image"; then
    printf 'ROLLBACK ERROR: could not retag the previous Caddy image %s as %s.\n' "$old_caddy_image_id" "$caddy_compose_image" >&2
    return 1
  fi
  cd "$app_dir"
  if ! docker compose up -d --no-build --force-recreate app caddy; then
    printf 'ROLLBACK ERROR: Docker Compose could not recreate the previous app and Caddy services.\n' >&2
    return 1
  fi
  if ! wait_for_app; then
    printf 'ROLLBACK ERROR: restored application did not become healthy. Inspect Docker Compose status and logs.\n' >&2
    return 1
  fi
  restored_caddy_id=$(docker compose ps -q caddy 2>/dev/null || true)
  if [ -z "$restored_caddy_id" ] || ! docker exec "$restored_caddy_id" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    printf 'ROLLBACK ERROR: restored Caddy container is unavailable or its configuration is invalid.\n' >&2
    return 1
  fi
  return 0
}

automatic_rollback() {
  status=$?
  trap - EXIT
  if [ -n "$latest_tmp" ]; then rm -f -- "$latest_tmp"; fi
  if [ "$image_probe_ready" -eq 1 ]; then
    docker rm -f "$image_probe_container" >/dev/null 2>&1 || true
    rm -rf -- "$image_probe_dir"
    image_probe_ready=0
  fi
  if [ "$status" -ne 0 ] && [ "$rollback_ready" -eq 1 ]; then
    if restore_previous; then
      printf 'Rollback completed. Application source and images were restored; the database was not restored. Snapshot retained at %s/database.sqlite.\n' "$backup_dir" >&2
    else
      printf 'AUTOMATIC ROLLBACK FAILED. The database was not restored. Recovery materials remain at %s; inspect the VPS before further action.\n' "$backup_dir" >&2
    fi
  fi
  exit "$status"
}

[ -f "$bundle_path" ] || fail "Deployment bundle not found: $bundle_path"
[ -f "$app_dir/docker-compose.yml" ] || fail "Expected existing deployment at $app_dir was not found."
[ -f "$app_dir/.env" ] || fail "Existing $app_dir/.env is missing; refusing to replace the live deployment."
configured_host=$(sed -n 's/^RMM_PUBLIC_HOST=//p' "$app_dir/.env" | head -n 1 | tr -d "\"'")
[ "$configured_host" = "$public_host" ] || fail "Production host mismatch: .env configures '$configured_host' but this deployment targets '$public_host'."

cd "$app_dir"
app_id=$(docker compose ps -q app)
[ -n "$app_id" ] || fail 'The existing app container is not running; inspect the VPS before deploying.'
caddy_id=$(docker compose ps -q caddy)
[ -n "$caddy_id" ] || fail 'The existing Caddy container is not running; inspect the VPS before deploying.'

volume_mount=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/family-rmm"}}{{.Type}} {{.Name}}{{end}}{{end}}' "$app_id")
case "$volume_mount" in
  'volume '*) [ -n "${volume_mount#volume }" ] || fail 'The RMM data volume name is empty.' ;;
  *) fail "The app has no persistent Docker volume mounted at /var/lib/family-rmm ($volume_mount). Refusing to deploy." ;;
esac
db_path=$(docker exec "$app_id" node -p 'process.env.RMM_DB_PATH || ""')
[ "$db_path" = /var/lib/family-rmm/rmm.sqlite ] || fail "Unexpected production database path '$db_path'; refusing to back up the wrong database."
artifact_path=$(docker exec "$app_id" node -p 'process.env.RMM_ARTIFACTS_DIR || ""')
[ "$artifact_path" = /var/lib/family-rmm/artifacts ] || fail "Unexpected installer artifact path '$artifact_path'; refusing to change storage configuration."

old_image_id=$(docker inspect -f '{{.Image}}' "$app_id")
old_caddy_image_id=$(docker inspect -f '{{.Image}}' "$caddy_id")
old_caddy_container_id=$caddy_id
# Use the running app container's own configured image reference. Compose's
# --images output includes every service and may list Caddy before the app;
# tagging the app's saved image against that first entry can overwrite Caddy.
compose_image=$(docker inspect -f '{{.Config.Image}}' "$app_id")
caddy_compose_image=$(docker inspect -f '{{.Config.Image}}' "$caddy_id")
[ -n "$old_image_id" ] || fail 'Could not identify the currently running app image.'
[ -n "$old_caddy_image_id" ] || fail 'Could not identify the currently running Caddy image.'
[ -n "$compose_image" ] || fail 'Could not identify the app image configured by Compose.'
[ -n "$caddy_compose_image" ] || fail 'Could not identify the Caddy image configured by Compose.'
case "$compose_image" in
  */*:*) ;;
  *:*) ;;
  *) compose_image=$compose_image:latest ;;
esac
rollback_image=${compose_image%:*}:familyrmm-rollback-$stamp-$$
rollback_caddy_image=${caddy_compose_image%:*}:familyrmm-rollback-$stamp-$$

# Do not prune global Docker build cache. This deployment uses --no-cache and
# should not alter build caches belonging to this or other Docker projects.
available_kb=$(df -Pk "$app_dir" | awk 'NR == 2 { print $4 }')
available_inodes=$(df -Pi "$app_dir" | awk 'NR == 2 { print $4 }')
case "$available_kb" in
  ''|*[!0-9]*) fail 'Could not determine free disk space after clearing Docker build cache.' ;;
esac
case "$available_inodes" in
  ''|*[!0-9]*) fail 'Could not determine free inode capacity after clearing Docker build cache.' ;;
esac
if [ "$available_kb" -lt 2097152 ]; then
  docker system df >&2 || true
  df -h "$app_dir" >&2 || true
  fail "Only $((available_kb / 1024)) MiB is free after clearing Docker build cache; at least 2048 MiB is required for a clean image build. No live container was replaced."
fi
if [ "$available_inodes" -lt 50000 ]; then
  fail "Only $available_inodes filesystem inodes are free after clearing Docker build cache; at least 50000 are required for a clean image build. No live container was replaced."
fi

[ ! -e "$backup_dir" ] || fail "Backup path already exists; refusing to overwrite it: $backup_dir"
install -d -m 700 "$backup_root" "$backup_dir"
tar -czf "$backup_dir/project.tar.gz" \
  --exclude=./.git --exclude=./node_modules --exclude=./.artifacts --exclude=./.logs \
  --exclude=./.dotnet-cli --exclude=./.nuget --exclude=./data \
  --exclude=./agent/bin --exclude=./agent/obj --exclude=./.deploy-bundle\* \
  -C "$app_dir" .
[ -s "$backup_dir/project.tar.gz" ] || fail 'The source archive is missing or empty; refusing to deploy.'
chmod 600 "$backup_dir/project.tar.gz"
archive_contents=$(tar -tzf "$backup_dir/project.tar.gz") || fail 'The source archive failed validation; refusing to deploy.'
for archived_path in ./docker-compose.yml ./.env ./secrets/enrollment-private-key.pem ./deploy/Caddyfile; do
  printf '%s\n' "$archive_contents" | grep -Fqx "$archived_path" || fail "Required recovery file is missing from the source archive: $archived_path"
done

docker image inspect "$old_image_id" >/dev/null || fail "Previous application image is not available locally: $old_image_id"
docker image inspect "$old_caddy_image_id" >/dev/null || fail "Previous Caddy image is not available locally: $old_caddy_image_id"
if docker image inspect "$rollback_image" >/dev/null 2>&1; then fail "Rollback image tag already exists; refusing to overwrite it: $rollback_image"; fi
if docker image inspect "$rollback_caddy_image" >/dev/null 2>&1; then fail "Rollback Caddy image tag already exists; refusing to overwrite it: $rollback_caddy_image"; fi
docker image tag "$old_image_id" "$rollback_image"
docker image tag "$old_caddy_image_id" "$rollback_caddy_image"
printf '%s\n' "$old_image_id" > "$backup_dir/old-image-id"
printf '%s\n' "$old_caddy_image_id" > "$backup_dir/old-caddy-image-id"
printf '%s\n' "$compose_image" > "$backup_dir/compose-image"
printf '%s\n' "$caddy_compose_image" > "$backup_dir/caddy-compose-image"
printf '%s\n' "$rollback_image" > "$backup_dir/rollback-image"
printf '%s\n' "$rollback_caddy_image" > "$backup_dir/rollback-caddy-image"
printf '%s\n' "$volume_mount" > "$backup_dir/data-volume"
printf '%s\n' '2' > "$backup_dir/backup-format-version"

docker exec "$app_id" node --input-type=module -e "import { mkdir } from 'node:fs/promises'; import { DatabaseSync } from 'node:sqlite'; await mkdir('/var/lib/family-rmm/backups', { recursive: true }); const db = new DatabaseSync('/var/lib/family-rmm/rmm.sqlite'); db.exec(\"VACUUM INTO '$db_backup_in_volume'\"); db.close();"
docker exec "$app_id" test -s "$db_backup_in_volume" || fail 'SQLite snapshot was not created or is empty; refusing to deploy.'
docker cp "$app_id:$db_backup_in_volume" "$backup_dir/database.sqlite"
[ -s "$backup_dir/database.sqlite" ] || fail 'Copied SQLite snapshot is missing or empty; refusing to deploy.'
chmod 600 "$backup_dir/database.sqlite"
(cd "$backup_dir" && sha256sum database.sqlite > database.sqlite.sha256)
chmod 600 "$backup_dir/database.sqlite.sha256"
(cd "$backup_dir" && sha256sum -c database.sqlite.sha256) || fail 'SQLite snapshot SHA-256 validation failed; refusing to deploy.'
docker run --rm --network none --read-only --user 0:0 -v "$backup_dir/database.sqlite:/tmp/family-rmm-backup.sqlite:ro" --entrypoint node "$old_image_id" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync("/tmp/family-rmm-backup.sqlite", { readOnly: true }); const result = db.prepare("PRAGMA integrity_check").get(); db.close(); if (!result || result.integrity_check !== "ok") { console.error("SQLite integrity_check failed."); process.exit(1); }' || fail 'SQLite snapshot integrity validation failed; refusing to deploy.'
for required_file in project.tar.gz database.sqlite database.sqlite.sha256 old-image-id old-caddy-image-id compose-image caddy-compose-image rollback-image rollback-caddy-image data-volume backup-format-version; do
  [ -s "$backup_dir/$required_file" ] || fail "Required backup file is missing or empty: $backup_dir/$required_file"
done
docker image inspect "$(cat "$backup_dir/old-image-id")" >/dev/null || fail 'Recorded previous app image failed validation; refusing to deploy.'
docker image inspect "$(cat "$backup_dir/old-caddy-image-id")" >/dev/null || fail 'Recorded previous Caddy image failed validation; refusing to deploy.'
tar -tzf "$backup_dir/project.tar.gz" >/dev/null || fail 'Recorded source archive failed its final validation; refusing to deploy.'
# LATEST is a regular text pointer containing the selected backup directory.
# Replace it atomically only after all recovery materials have passed validation.
if [ -e "$backup_root/LATEST" ] && { [ ! -f "$backup_root/LATEST" ] || [ -L "$backup_root/LATEST" ]; }; then
  fail "The LATEST pointer exists but is not a regular file: $backup_root/LATEST"
fi
latest_tmp=$backup_root/.LATEST-$stamp-$$
printf '%s\n' "$backup_dir" > "$latest_tmp"
chmod 600 "$latest_tmp"
mv -f -- "$latest_tmp" "$backup_root/LATEST"
latest_tmp=
rollback_ready=1
trap automatic_rollback EXIT

printf 'Backup complete: %s\nPersistent volume preserved: %s\n' "$backup_dir" "$volume_mount"
expected_asset=$(python3 - "$bundle_path" <<'PY'
import re
import sys
import zipfile

def normalize(name):
    name = name.replace("\\", "/")
    while name.startswith("./"):
        name = name[2:]
    return name

with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    normalized = [(item, normalize(item.filename)) for item in entries]
    index_entries = [(item, name) for item, name in normalized if name.endswith("dist/index.html")]
    if len(index_entries) != 1:
        names = "\n".join(name for _, name in normalized[:30])
        raise SystemExit("Could not uniquely locate dist/index.html in deployment ZIP. First entries:\n" + names)
    index_item, index_name = index_entries[0]
    prefix = index_name[:-len("dist/index.html")]
    html = archive.read(index_item).decode("utf-8")
match = re.search(r'src="(/assets/[^\"]+\.js)"', html)
if not match:
    raise SystemExit("Deployment archive has no frontend JavaScript reference.")
print(match.group(1))
PY
)

# Explicitly overwrite each release file. Preserve server-only .env and secrets,
# which are intentionally absent from the upload archive.
python3 - "$bundle_path" "$app_dir" <<'PY'
import os
import shutil
import sys
import zipfile

def normalize(name):
    name = name.replace("\\", "/")
    while name.startswith("./"):
        name = name[2:]
    return name

archive_path, target_root = sys.argv[1:]
target_root = os.path.realpath(target_root)
with zipfile.ZipFile(archive_path) as archive:
    entries = archive.infolist()
    normalized = [(item, normalize(item.filename)) for item in entries]
    index_entries = [(item, name) for item, name in normalized if name.endswith("dist/index.html")]
    if len(index_entries) != 1:
        raise SystemExit("Could not uniquely locate dist/index.html in deployment ZIP.")
    prefix = index_entries[0][1][:-len("dist/index.html")]
    for item, name in normalized:
        if prefix and name.startswith(prefix):
            name = name[len(prefix):]
        elif prefix:
            raise SystemExit(f"Unexpected archive root prefix for: {name}")
        if name in ("", ".") or name.endswith("/"):
            continue
        if name == ".env" or name.startswith("secrets/") or name.startswith("data/"):
            raise SystemExit(f"Refusing to overwrite server-only data: {name}")
        target = os.path.realpath(os.path.join(target_root, name))
        if os.path.commonpath((target_root, target)) != target_root:
            raise SystemExit(f"Unsafe path in deployment archive: {name}")
        if item.is_dir():
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with archive.open(item, "r") as source, open(target, "wb") as destination:
            shutil.copyfileobj(source, destination)
print("Deployment files explicitly extracted.")
PY

# A per-Dockerfile ignore file overrides .dockerignore. This project does not
# use one; preserve any old override in the backup before removing it.
if [ -f "$app_dir/Dockerfile.dockerignore" ]; then
  mv "$app_dir/Dockerfile.dockerignore" "$backup_dir/Dockerfile.dockerignore"
fi
host_asset=$(python3 - "$app_dir/dist/index.html" <<'PY'
import re
import sys

with open(sys.argv[1], encoding="utf-8") as page:
    match = re.search(r'src="(/assets/[^\"]+\.js)"', page.read())
if not match:
    raise SystemExit("Extracted frontend has no JavaScript reference.")
print(match.group(1))
PY
)
[ "$host_asset" = "$expected_asset" ] || fail "Extracted frontend is $host_asset; archive contains $expected_asset."

docker compose build --no-cache app
image_probe_container=$(docker create "$compose_image")
image_probe_dir=$(mktemp -d)
image_probe_ready=1
docker cp "$image_probe_container:/app/dist/index.html" "$image_probe_dir/index.html"
docker cp "$image_probe_container:/app/dist${expected_asset}" "$image_probe_dir/app.js"
image_asset=$(python3 - "$image_probe_dir/index.html" "$image_probe_dir/app.js" <<'PY'
import re
import sys

with open(sys.argv[1], encoding="utf-8") as page:
    match = re.search(r'src="(/assets/[^\"]+\.js)"', page.read())
if not match:
    raise SystemExit("Built image frontend has no JavaScript asset reference.")
with open(sys.argv[2], encoding="utf-8") as bundle:
    js = bundle.read()
if "Download Windows MSI" not in js or "Download Windows EXE" not in js:
    raise SystemExit("Built image frontend is missing the Windows installer download UI.")
print(match.group(1))
PY
)
[ -n "$image_asset" ] || fail 'Built image frontend asset verification returned an empty path.'
docker rm "$image_probe_container" >/dev/null
rm -rf -- "$image_probe_dir"
image_probe_ready=0
[ "$image_asset" = "$expected_asset" ] || fail "Built image contains $image_asset; expected $expected_asset."

docker compose up -d --force-recreate app caddy
new_caddy_id=$(docker compose ps -q caddy)
[ -n "$new_caddy_id" ] && [ "$new_caddy_id" != "$old_caddy_container_id" ] || fail 'Caddy was not recreated; refusing to report deployment success.'
new_caddy_image=$(docker inspect -f '{{.Config.Image}}' "$new_caddy_id")
case "$new_caddy_image" in
  caddy:*) ;;
  *) fail "The caddy service is running unexpected image '$new_caddy_image'; refusing to report deployment success." ;;
esac
docker exec "$new_caddy_id" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
wait_for_app || fail 'Updated app did not become healthy.'

rollback_ready=0
trap - EXIT
printf 'DEPLOYMENT_OK host=%s asset=%s backup=%s caddy_recreated=yes\n' "$public_host" "$expected_asset" "$backup_dir"
