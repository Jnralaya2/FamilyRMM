#!/bin/sh
set -eu
umask 077

app_dir=/opt/family-rmm
backup_root=/var/backups/family-rmm
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir=${1:-$(cat "$backup_root/LATEST" 2>/dev/null || true)}
stage_dir=
current_dir=$backup_root/pre-rollback-$stamp-$$
current_image_tag=
current_caddy_image_tag=
compose_image=
caddy_compose_image=
old_image_id=
old_caddy_image_id=
public_host=

fail() {
  printf 'ROLLBACK REFUSED: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$stage_dir" ] && [ -d "$stage_dir" ]; then rm -rf -- "$stage_dir"; fi
}
trap cleanup EXIT

[ -n "$backup_dir" ] || fail "No backup is recorded in $backup_root/LATEST."
case "$backup_dir" in
  "$backup_root"/deploy-*) ;;
  *) fail "Backup path must be a deploy-* directory under $backup_root." ;;
esac
backup_name=${backup_dir#"$backup_root"/}
case "$backup_name" in
  deploy-*[!A-Za-z0-9_-]*|*..*) fail 'Backup directory name contains unsafe path characters.' ;;
esac
[ -d "$backup_dir" ] && [ ! -L "$backup_dir" ] || fail "Backup directory is missing or is a symlink: $backup_dir"

for required_file in project.tar.gz database.sqlite database.sqlite.sha256 old-image-id compose-image data-volume backup-format-version; do
  [ -f "$backup_dir/$required_file" ] && [ ! -L "$backup_dir/$required_file" ] && [ -s "$backup_dir/$required_file" ] || fail "Required backup file is missing, empty, or unsafe: $backup_dir/$required_file"
done

[ "$(cat "$backup_dir/backup-format-version")" = 2 ] || fail 'Unsupported or incomplete backup format; expected validated format version 2.'
old_image_id=$(cat "$backup_dir/old-image-id")
compose_image=$(cat "$backup_dir/compose-image")
[ -n "$old_image_id" ] || fail 'Previous application image ID is empty.'
[ -n "$compose_image" ] || fail 'Previous application image reference is empty.'
docker image inspect "$old_image_id" >/dev/null 2>&1 || fail "Previous application image is unavailable: $old_image_id"

grep -Eq '^[a-fA-F0-9]{64}  database\.sqlite$' "$backup_dir/database.sqlite.sha256" || fail 'Database checksum manifest has an invalid format.'
(cd "$backup_dir" && sha256sum -c database.sqlite.sha256) || fail 'Database snapshot checksum does not match.'
tar -tzf "$backup_dir/project.tar.gz" >/dev/null 2>&1 || fail 'Source archive is corrupt or unreadable.'

stage_dir=$(mktemp -d "$backup_root/.rollback-validate-$stamp-XXXXXX") || fail 'Could not create a private rollback validation directory.'
tar -xzf "$backup_dir/project.tar.gz" -C "$stage_dir" || fail 'Could not stage the source archive for validation.'
[ -s "$stage_dir/docker-compose.yml" ] || fail 'Backup source archive does not contain docker-compose.yml.'
[ -s "$stage_dir/deploy/Caddyfile" ] || fail 'Backup source archive does not contain deploy/Caddyfile.'
[ -s "$stage_dir/.env" ] || fail 'Backup source archive does not contain the preserved production .env.'
[ -s "$stage_dir/secrets/enrollment-private-key.pem" ] || fail 'Backup source archive does not contain the configured enrollment signing secret file.'

docker run --rm --network none --read-only --user 0:0 -v "$backup_dir/database.sqlite:/tmp/family-rmm-backup.sqlite:ro" --entrypoint node "$old_image_id" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync("/tmp/family-rmm-backup.sqlite", { readOnly: true }); const result = db.prepare("PRAGMA integrity_check").get(); db.close(); if (!result || result.integrity_check !== "ok") { console.error("SQLite integrity_check failed."); process.exit(1); }' || fail 'Database snapshot failed SQLite integrity validation.'

if [ -f "$backup_dir/old-caddy-image-id" ] || [ "$(cat "$backup_dir/backup-format-version")" = 2 ]; then
  [ -f "$backup_dir/old-caddy-image-id" ] && [ -s "$backup_dir/old-caddy-image-id" ] || fail 'Backup format requires a previous Caddy image ID.'
  [ -f "$backup_dir/caddy-compose-image" ] && [ -s "$backup_dir/caddy-compose-image" ] || fail 'Backup format requires a previous Caddy image reference.'
  old_caddy_image_id=$(cat "$backup_dir/old-caddy-image-id")
  caddy_compose_image=$(cat "$backup_dir/caddy-compose-image")
  docker image inspect "$old_caddy_image_id" >/dev/null 2>&1 || fail "Previous Caddy image is unavailable: $old_caddy_image_id"
  [ -n "$caddy_compose_image" ] || fail 'Previous Caddy image reference is empty.'
fi

public_host=$(sed -n 's/^RMM_PUBLIC_HOST=//p' "$stage_dir/.env" | head -n 1 | tr -d "\"'")
case "$public_host" in
  ''|*[!A-Za-z0-9.-]*) fail 'Backed-up .env has no valid RMM_PUBLIC_HOST.' ;;
esac
if [ -n "$old_caddy_image_id" ]; then
  docker run --rm --network none --read-only --user 0:0 -e "RMM_PUBLIC_HOST=$public_host" -v "$stage_dir/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" --entrypoint caddy "$old_caddy_image_id" validate --config /etc/caddy/Caddyfile --adapter caddyfile || fail 'Previous Caddy image rejected the backed-up Caddyfile.'
fi

cd "$app_dir"
[ ! -e "$current_dir" ] || fail "Pre-rollback archive already exists; refusing to overwrite it: $current_dir"
install -d -m 700 "$current_dir"
tar -czf "$current_dir/project.tar.gz" \
  --exclude=./.git --exclude=./node_modules --exclude=./.artifacts --exclude=./.logs \
  --exclude=./.dotnet-cli --exclude=./.nuget --exclude=./data \
  --exclude=./agent/bin --exclude=./agent/obj --exclude=./.deploy-bundle\* \
  -C "$app_dir" . || fail 'Could not preserve the current source tree before rollback.'
[ -s "$current_dir/project.tar.gz" ] || fail 'Pre-rollback source archive is missing or empty.'
chmod 600 "$current_dir/project.tar.gz"

current_app_id=$(docker compose ps -a -q app 2>/dev/null || true)
if [ -n "$current_app_id" ]; then
  current_app_image_id=$(docker inspect -f '{{.Image}}' "$current_app_id" 2>/dev/null || true)
  current_compose_image=$(docker inspect -f '{{.Config.Image}}' "$current_app_id" 2>/dev/null || true)
  [ -n "$current_compose_image" ] || current_compose_image=$compose_image
  if [ -n "$current_app_image_id" ]; then
    current_image_tag=${current_compose_image%:*}:familyrmm-pre-rollback-$stamp-$$
    docker image tag "$current_app_image_id" "$current_image_tag" || fail 'Could not preserve the current application image before rollback.'
    printf '%s\n' "$current_app_image_id" > "$current_dir/image-id"
    printf '%s\n' "$current_image_tag" > "$current_dir/image-tag"
  fi
fi
current_caddy_id=$(docker compose ps -a -q caddy 2>/dev/null || true)
if [ -n "$current_caddy_id" ]; then
  current_caddy_id_value=$(docker inspect -f '{{.Image}}' "$current_caddy_id" 2>/dev/null || true)
  current_caddy_ref=$(docker inspect -f '{{.Config.Image}}' "$current_caddy_id" 2>/dev/null || true)
  if [ -n "$current_caddy_id_value" ] && [ -n "$current_caddy_ref" ]; then
    current_caddy_image_tag=${current_caddy_ref%:*}:familyrmm-pre-rollback-$stamp-$$
    docker image tag "$current_caddy_id_value" "$current_caddy_image_tag" || fail 'Could not preserve the current Caddy image before rollback.'
    printf '%s\n' "$current_caddy_id_value" > "$current_dir/caddy-image-id"
    printf '%s\n' "$current_caddy_image_tag" > "$current_dir/caddy-image-tag"
  fi
fi

tar -xzf "$backup_dir/project.tar.gz" -C "$app_dir" || fail 'Could not restore the validated source archive; current files may be partially restored.'
docker image tag "$old_image_id" "$compose_image" || fail 'Could not restore the previous application image tag.'
if [ -n "$old_caddy_image_id" ]; then
  docker image tag "$old_caddy_image_id" "$caddy_compose_image" || fail 'Could not restore the previous Caddy image tag.'
fi
cd "$app_dir"
docker compose up -d --no-build --force-recreate app caddy || fail 'Docker Compose could not recreate the previous application and Caddy services.'

attempt=0
while [ "$attempt" -lt 90 ]; do
  app_id=$(docker compose ps -q app 2>/dev/null || true)
  if [ -n "$app_id" ]; then
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_id" 2>/dev/null || true)
    if [ "$health" = healthy ]; then break; fi
    if [ "$health" = exited ] || [ "$health" = dead ]; then break; fi
  fi
  sleep 2
  attempt=$((attempt + 1))
done
[ "${health:-}" = healthy ] || fail 'Restored app did not become healthy within 180 seconds.'
restored_caddy_id=$(docker compose ps -q caddy 2>/dev/null || true)
[ -n "$restored_caddy_id" ] || fail 'Restored Caddy container is not running.'
docker exec "$restored_caddy_id" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || fail 'Restored Caddy configuration failed validation.'

printf 'Rollback complete. Application source and images restored from %s. The live database was not changed. Database snapshot retained at %s/database.sqlite. Pre-rollback source/image archive: %s\n' "$backup_dir" "$backup_dir" "$current_dir"
