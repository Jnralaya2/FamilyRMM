# Legacy deployment entry point intentionally disabled.
# It previously extracted a bundle into the application directory before the
# backup gate, which could leave production source files partially replaced.
$ErrorActionPreference = "Stop"
throw "This deployment path is disabled. Do not extract its old ZIP. Use scripts/deploy-live.ps1 only after reviewing and approving the backup-first release workflow."
