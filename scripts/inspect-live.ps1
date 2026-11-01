param(
  [string]$VpsTarget = "deploy@YOUR_VPS_IP",
  [string]$PublicUrl = "https://familyrmm.xyz"
)

$ErrorActionPreference = "Stop"
if ($VpsTarget -notmatch '^deploy@[A-Za-z0-9.-]+$' -or $VpsTarget -match 'YOUR_VPS_IP') { throw "Replace YOUR_VPS_IP with the VPS address and use the deploy@ account." }
$publicUri = [uri]$PublicUrl
if ($publicUri.Scheme -ne 'https' -or $publicUri.Host -notmatch '^[A-Za-z0-9.-]+$') { throw "Use the production HTTPS domain." }

$remoteScript = @'
set -eu
cd /opt/family-rmm
printf '%s\n' '=== OS ==='
sed -n '1,3p' /etc/os-release
printf '%s\n' '=== deployment directory ==='
pwd
printf '%s\n' '=== compose services ==='
docker compose config --services
printf '%s\n' '=== containers ==='
docker compose ps
printf '%s\n' '=== relevant host services ==='
systemctl list-units --type=service --state=running --no-legend 2>/dev/null | grep -E 'docker|ssh|caddy' || true
app_id=$(docker compose ps -q app)
caddy_id=$(docker compose ps -q caddy)
printf '%s\n' '=== app image, status, and mounts ==='
docker inspect -f 'image={{.Config.Image}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} mounts={{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}};{{end}}' "$app_id"
printf '%s\n' '=== caddy image, status, and mounts ==='
docker inspect -f 'image={{.Config.Image}} status={{.State.Status}} mounts={{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}};{{end}}' "$caddy_id"
printf '%s\n' '=== RMM database integrity and record counts (no record contents) ==='
docker exec "$app_id" node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync("/var/lib/family-rmm/rmm.sqlite",{readOnly:true}); const names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type=\"table\"").all().map(x=>x.name)); const count=(t)=>names.has(t)?db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n:null; console.log(JSON.stringify({integrity:db.prepare("PRAGMA quick_check").get(),devices:count("devices"),administrators:count("administrators"),enrollmentPolicies:count("enrollment_policies"),enrollmentGrants:count("enrollment_grants"),installerPackages:count("installer_packages")})); db.close();'
printf '%s\n' '=== configured reverse proxy (no secrets) ==='
cat deploy/Caddyfile
printf '%s\n' '=== frontend asset inside the running app ==='
docker exec "$app_id" node --input-type=module -e 'import { readFile, access } from "node:fs/promises"; const html=await readFile("/app/dist/index.html","utf8"); const asset=html.match(/src="([^\"]+\.js)"/)?.[1]; if(!asset) throw new Error("Frontend asset is missing"); await access(`/app/dist/${asset.replace(/^\/+/,"")}`); console.log(asset);'
printf '%s\n' '=== DNS addresses from VPS ==='
getent ahostsv4 "$PUBLIC_HOST" || true
'@
$encodedScript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
$remoteCommand = "PUBLIC_HOST='$($publicUri.Host)'; export PUBLIC_HOST; printf '%s' '$encodedScript' | base64 -d | sh"
Write-Host "Running a read-only VPS inventory; no files, services, or data will be changed."
& ssh $VpsTarget $remoteCommand
if ($LASTEXITCODE -ne 0) { throw "Read-only VPS inspection failed (ssh exit code $LASTEXITCODE)." }
