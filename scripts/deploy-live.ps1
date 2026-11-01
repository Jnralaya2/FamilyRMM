param(
  [string]$VpsTarget = "deploy@YOUR_VPS_IP",
  [string]$PublicUrl = "https://familyrmm.xyz"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# PowerShell 7 can promote native-command stderr (including harmless Docker
# warnings relayed by SSH) to terminating errors when this preference is on.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$bundlePath = Join-Path $repoRoot ".deploy-bundle-current.zip"
$distIndexPath = Join-Path $repoRoot "dist\index.html"
$releaseRunnerPath = Join-Path $repoRoot "deploy\deploy-release.sh"
$rollbackScriptPath = Join-Path $repoRoot "deploy\rollback.sh"
$include = @(
  "agent", "deploy", "scripts", "src", "docs", "dist",
  ".dockerignore", "docker-compose.yml", "Dockerfile", "index.html",
  "package.json", "package-lock.json", "README.md", "tsconfig.json", "vite.config.ts"
)

if ($VpsTarget -notmatch '^deploy@[A-Za-z0-9.-]+$' -or $VpsTarget -match 'YOUR_VPS_IP') { throw "Replace YOUR_VPS_IP with the VPS address and use the deploy@ account." }
if (-not (Get-Command scp -ErrorAction SilentlyContinue) -or -not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw "Windows OpenSSH Client commands 'scp' and 'ssh' are required."
}
$publicUri = [uri]$PublicUrl
if ($publicUri.Scheme -ne 'https' -or $publicUri.Host -notmatch '^[A-Za-z0-9.-]+$') { throw "Use the production HTTPS domain, for example https://familyrmm.xyz." }

Write-Host "Building the expected dashboard asset fingerprint before deployment."
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "The local dashboard build failed; deployment stopped." }
if (-not (Test-Path -LiteralPath $distIndexPath)) { throw "The dashboard build did not emit dist/index.html." }
$localIndex = Get-Content -LiteralPath $distIndexPath -Raw
$expectedAssetMatch = [regex]::Match($localIndex, 'src="([^\"]+\.js)"')
if (-not $expectedAssetMatch.Success) { throw "The dashboard build did not emit a JavaScript asset." }
$expectedAsset = $expectedAssetMatch.Groups[1].Value
$relativeAssetPath = $expectedAsset.TrimStart('/') -replace '/', [IO.Path]::DirectorySeparatorChar
$frontendBundlePath = Join-Path (Join-Path $repoRoot 'dist') $relativeAssetPath
if (-not (Test-Path -LiteralPath $frontendBundlePath)) { throw "The expected dashboard asset is missing: $frontendBundlePath" }
$localBundleText = [IO.File]::ReadAllText($frontendBundlePath)
if (-not $localBundleText.Contains("Download Windows MSI")) { throw "The local production frontend bundle does not contain the Windows Downloads UI." }

$stagePath = Join-Path $env:TEMP ("familyrmm-deploy-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stagePath | Out-Null
try {
  foreach ($entry in $include) {
    $sourcePath = Join-Path $repoRoot $entry
    if (-not (Test-Path -LiteralPath $sourcePath)) { throw "Required deployment file is missing: $entry" }
    if ((Get-Item -LiteralPath $sourcePath).PSIsContainer) {
      $files = Get-ChildItem -LiteralPath $sourcePath -Recurse -File | Where-Object { $_.FullName -notmatch '[\\/](bin|obj)[\\/]' }
      foreach ($file in $files) {
        $rootPrefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $file.FullName.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
          throw "Deployment file is outside the project directory: $($file.FullName)"
        }
        $relativePath = $file.FullName.Substring($rootPrefix.Length)
        $stagedFile = Join-Path $stagePath $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $stagedFile) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $stagedFile
      }
    } else {
      Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $stagePath $entry)
    }
  }
  if (Test-Path -LiteralPath $bundlePath) { Remove-Item -LiteralPath $bundlePath -Force }
  Compress-Archive -Path (Join-Path $stagePath '*') -DestinationPath $bundlePath -CompressionLevel Optimal
} finally {
  Remove-Item -LiteralPath $stagePath -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Uploading the deployment bundle and protected runners to the deploy account's private home directory."
$remoteStageDir = ".familyrmm-deploy-$([guid]::NewGuid().ToString('N'))"
& ssh $VpsTarget "umask 077 && mkdir -m 700 '$remoteStageDir'"
if ($LASTEXITCODE -ne 0) { throw "Could not create a private upload directory in the deploy account's home directory." }
& scp $bundlePath $releaseRunnerPath $rollbackScriptPath "${VpsTarget}:$remoteStageDir/"
$scpExitCode = $LASTEXITCODE
if ($scpExitCode -ne 0) {
  Write-Warning "SCP returned exit code $scpExitCode. Verifying the uploaded files before deciding whether deployment can continue."
}
$expectedHashes = @{
  ".deploy-bundle-current.zip" = (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
  "deploy-release.sh" = (Get-FileHash -LiteralPath $releaseRunnerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  "rollback.sh" = (Get-FileHash -LiteralPath $rollbackScriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
}
$savedErrorActionPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = "Continue"
  $remoteHashes = @(& ssh $VpsTarget "cd '$remoteStageDir' && sha256sum .deploy-bundle-current.zip deploy-release.sh rollback.sh" 2>&1)
  $verifyExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $savedErrorActionPreference
}
foreach ($line in $remoteHashes) { Write-Host ([string]$line) }
$verifiedHashes = @{}
foreach ($line in $remoteHashes) {
  $match = [regex]::Match([string]$line, '^([a-fA-F0-9]{64})\s+\*?(\.deploy-bundle-current\.zip|deploy-release\.sh|rollback\.sh)$')
  if ($match.Success) { $verifiedHashes[$match.Groups[2].Value] = $match.Groups[1].Value.ToLowerInvariant() }
}
$missingOrMismatched = @($expectedHashes.Keys | Where-Object {
  -not $verifiedHashes.ContainsKey($_) -or $verifiedHashes[$_] -ne $expectedHashes[$_]
})
if ($verifyExitCode -ne 0 -or $missingOrMismatched.Count -gt 0) {
  throw "SCP upload did not pass remote SHA-256 verification (SCP exit code $scpExitCode). Mismatched or missing files: $($missingOrMismatched -join ', '). No deployment was started. Retry after confirming SSH connectivity."
}
Write-Host "All uploaded files match their local SHA-256 hashes; continuing with the protected deployment."

Write-Host "Creating a protected code and database backup before deployment. The deploy account must have non-interactive sudo access."
$remoteCommand = "set -eu; cd '$remoteStageDir'; sudo -n install -o root -g root -m 600 .deploy-bundle-current.zip /root/.deploy-bundle-current.zip; sudo -n install -o root -g root -m 700 deploy-release.sh /root/deploy-release.sh; sudo -n install -o root -g root -m 700 rollback.sh /root/rollback.sh; rm -f -- .deploy-bundle-current.zip deploy-release.sh rollback.sh; cd; rmdir -- '$remoteStageDir'; sudo -n sh /root/deploy-release.sh /root/.deploy-bundle-current.zip $($publicUri.Host)"
$savedErrorActionPreference = $ErrorActionPreference
try {
  # Windows PowerShell 5.1 reports native stderr as NativeCommandError. Keep
  # that non-terminating while SSH runs so harmless remote Docker warnings can
  # be captured; the SSH exit code below still decides deployment success.
  $ErrorActionPreference = "Continue"
  $remoteOutput = @(& ssh $VpsTarget $remoteCommand 2>&1)
  $remoteExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $savedErrorActionPreference
}
foreach ($line in $remoteOutput) { Write-Host ([string]$line) }
if ($remoteExitCode -ne 0) {
  $remoteTail = ($remoteOutput | Select-Object -Last 80 | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  throw "VPS upgrade failed (ssh exit code $remoteExitCode). Remote output tail:`n$remoteTail"
}

Write-Host "Checking the public HTTPS health endpoint..."
try {
  $health = Invoke-RestMethod -Uri "$PublicUrl/api/health" -TimeoutSec 30
  if ($health.status -ne "ok" -or $health.database -ne "connected") { throw "Health response did not report status=ok and database=connected." }
} catch {
  $healthError = $_.Exception.Message
  Write-Warning "Public API health check failed; requesting application rollback."
  & ssh $VpsTarget "sudo -n sh /opt/family-rmm/deploy/rollback.sh"
  if ($LASTEXITCODE -ne 0) { throw "Public API health failed ($healthError), and automatic rollback also failed. The protected backup is under /var/backups/family-rmm on the VPS." }
  throw "Public API health failed; the prior app image and source were restored. Database backup remains preserved. Details: $healthError"
}
$indexCheckUrl = $PublicUrl.TrimEnd('/') + "/?deploycheck=" + [guid]::NewGuid().ToString("N")
$liveIndex = (Invoke-WebRequest -Uri $indexCheckUrl -Headers @{ "Cache-Control" = "no-cache"; "Pragma" = "no-cache" } -TimeoutSec 30 -UseBasicParsing).Content
if (-not $liveIndex.Contains($expectedAsset)) {
  $liveAssets = [regex]::Matches($liveIndex, '(?:src|href)="([^"]+\.(?:js|css))"') | ForEach-Object { $_.Groups[1].Value }
  throw "The VPS app should serve $expectedAsset, but a cache-busted request to $PublicUrl returned assets [$($liveAssets -join ', ')]. Check the domain's reverse proxy, CDN, or DNS target."
}
$assetUrl = [uri]::new([uri]$PublicUrl, $expectedAsset).AbsoluteUri
$assetCheckUrl = $assetUrl + "?deploycheck=" + [guid]::NewGuid().ToString("N")
$assetResponse = Invoke-WebRequest -Uri $assetCheckUrl -Headers @{ "Cache-Control" = "no-cache" } -TimeoutSec 30 -UseBasicParsing
if ($assetResponse.StatusCode -ne 200) { throw "The live HTML references $expectedAsset but the asset did not load successfully." }
$liveAssetPath = Join-Path $env:TEMP ("familyrmm-live-asset-" + [guid]::NewGuid().ToString("N") + ".js")
try {
  $assetDownloadUrl = $assetUrl + "?deploycheck=" + [guid]::NewGuid().ToString("N")
  Invoke-WebRequest -Uri $assetDownloadUrl -Headers @{ "Cache-Control" = "no-cache" } -TimeoutSec 30 -UseBasicParsing -OutFile $liveAssetPath
  $liveAssetText = [IO.File]::ReadAllText($liveAssetPath)
} finally {
  Remove-Item -LiteralPath $liveAssetPath -Force -ErrorAction SilentlyContinue
}
if (-not $liveAssetText.Contains("Download Windows MSI")) {
  throw "The public domain serves $expectedAsset, but that JavaScript does not contain the Windows Downloads UI. The production build source or cache is stale."
}
if (-not $liveAssetText.Contains("Download Windows EXE")) { throw "The public dashboard asset is missing its Windows EXE download UI." }
Write-Host "Live API and Windows MSI/EXE dashboard UI asset $expectedAsset are verified at $PublicUrl."
