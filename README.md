# Family RMM

Self-hosted remote monitoring and management for devices you are authorized to administer.

## Current working slice

The runnable application includes a protected owner setup/sign-in flow, a local API, a SQLite development database, Overview and Devices inventory pages, Enrollment, Windows Downloads, Audit, and Software & Deployments. The production server builds the reusable Windows MSI/EXE directly from the agent source when Downloads is opened; no separate Windows build worker or command is required. The package has a permanent download link and contains no enrollment grant; each installation submits a pending request and remains unmanaged until an administrator approves it. Device enrollment and administrator sessions are not restricted by plan limits. Administrators can separately upload application MSI/EXE installers or author PowerShell scripts, select enrolled computers in bulk, queue signed deployment tasks, and review device-reported results. The Windows service agent verifies task signatures, authenticates each request with its device key, checks installer hashes, runs approved installers/scripts, and reports outcomes. Deployment targets require Family RMM Agent 0.2.0 or newer; older agents remain visible but are blocked from job selection until upgraded. A software update action requires a matching installed application in each target's reported inventory. ScreenConnect deployment remains unimplemented.

This is an active build, not a production release. Local development installers are unsigned. A clean Windows 10/11 graphical agent lifecycle acceptance run and live ScreenConnect integration remain release gates. The deployment integration test verifies signed tasks, package transport, bulk queue state and a harmless PowerShell script; it does not install a third-party MSI/EXE in a clean VM. PostgreSQL migration, off-server backup/restore, package metadata verification, and remote push to unmanaged computers remain on the roadmap. Scheduled deployments are supported as one-time jobs; recurring schedules are not implemented. See [Windows agent packaging and release](docs/windows-agent-release.md) and [the architecture and delivery plan](docs/architecture-roadmap.md) for constraints and status.

## One-time customer licenses

The legacy customer workspace key feature remains available for multi-workspace separation. Device enrollment and administrator sessions are unlimited; license records do not disable a workspace or enrolled agent.

An unsigned Windows pilot can be built locally on the platform owner's Windows PC from a customer's limited enrollment config; the owner sends the MSI directly to that customer. Windows may show an unknown-publisher warning. Public MSI distribution still requires Authenticode signing and clean-machine installer acceptance. See [the unsigned pilot workflow](docs/unsigned-pilot.md).

## Run on Windows

From PowerShell in this folder:

```powershell
npm.cmd install
npm.cmd run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). On the first run, copy the one-time owner setup token printed by the local server into the setup screen, then create your own administrator email and password. The development server binds to loopback only. The token becomes invalid after the owner account is created.

The Vite dashboard uses `127.0.0.1:5173`; its API is proxied to the local Node service at `127.0.0.1:3001`. The development database and logs are under the untracked `data/` and `.logs/` directories.

## Checks

```powershell
npm.cmd test
npm.cmd run build
```

The API tests use isolated SQLite databases. They verify owner setup/auth, policy expiry/revocation, unlimited enrollment, permanent package downloads independent of grant revocation, real MSI/EXE artifacts, agent self-check and check-in, hardware/software inventory, and the pending-enrollment approval flow. A production-mode integration test also exercises the server-side build queue and downloads both MSI and EXE without a separate worker. These tests do not install the MSI in a clean Windows VM or verify the production Docker image on Linux.

## Production deployment from Windows

This project does not require GitHub for production deployment. The Windows PowerShell deployer builds the frontend locally, packages the actual `dist` output with the backend and agent source, uploads it with OpenSSH/SCP, and runs the protected release script over SSH. The current deployment files target `/opt/family-rmm` on the VPS; verify the live host before deploying with:

Replace `YOUR_VPS_IP` in the examples with the intended VPS address. The SSH account is the dedicated `deploy` user, not root. It needs permission to run Docker for inspection and approved non-interactive `sudo` access to install and run the protected release and rollback scripts. The deployer stages uploads in a mode-700 directory under that user's home, verifies their SHA-256 hashes, then installs the runners as root.

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\inspect-live.ps1 -VpsTarget "deploy@YOUR_VPS_IP" -PublicUrl "https://familyrmm.xyz"
```

The inspection only reads the VPS. It reports the running Compose services, image/mount information, database integrity and record counts, Caddy config, and the VPS DNS result. It does not print `.env`, credentials, device records, or enrollment details.

Deploy the current workspace with:

```powershell
.\scripts\deploy-live.ps1 -VpsTarget "deploy@YOUR_VPS_IP" -PublicUrl "https://familyrmm.xyz"
```

The approved release entry point is `scripts/deploy-live.ps1`; see [the production deployment and recovery procedure](docs/production-deployment.md). It builds and verifies the frontend, uploads the bundle and protected runner, and checks the public HTTPS API/assets afterward. Before replacing source files, the remote runner writes a root-only source/configuration archive, a `VACUUM INTO` SQLite snapshot with SHA-256 and `PRAGMA integrity_check` validation, and records the prior app/Caddy image IDs and references under `/var/backups/family-rmm/deploy-<UTC timestamp>/`. It preserves the existing `.env`, secrets, and Docker volumes. It does not run `docker compose down -v`, remove volumes, or prune global Docker build cache. App and Caddy are recreated together, so a short connection interruption is possible.

If the new app fails health or Caddy validation after backup, the remote runner attempts to restore the previous source and app/Caddy images. Rollback never restores the SQLite database automatically. If a later update needs a manual code/image rollback, review the target backup and run:

```powershell
ssh deploy@YOUR_VPS_IP "sudo -n sh /opt/family-rmm/deploy/rollback.sh /var/backups/family-rmm/deploy-<UTC timestamp>"
```

Each rollback validates source archive contents, database checksum/integrity, and image availability before modifying the app, then archives the current source and images. The live database is left unchanged. Database restoration is a separate, explicitly approved recovery operation because it can discard records written since the snapshot and migrations are forward-only. The SQLite snapshot is on the VPS only; installer artifacts and Caddy TLS volumes are not included in this per-release backup. Configure and restore-test a separate encrypted off-site backup for VPS or disk loss. `deploy/upgrade.sh` and `scripts/deploy-public-readiness.ps1` are disabled; do not extract bundles directly into `/opt/family-rmm`.

The checked-in Compose architecture configures the Node app on port 3000 behind Caddy on ports 80/443. Caddy reads `RMM_PUBLIC_HOST` from the production `.env`, reverse-proxies to `app:3000`, and stores TLS state in its named data/config volumes. SQLite and installer artifacts use the persistent `rmm_data` volume at `/var/lib/family-rmm`; the app reads `/var/lib/family-rmm/rmm.sqlite` and writes `/var/lib/family-rmm/artifacts`. The domain's DNS A/AAAA records and the actual VPS service inventory must still be confirmed by the read-only inspection because this environment cannot open the user's SSH session.

## Production status

Do not expose the current development server to the internet. For multi-computer distribution, configure `RMM_SERVER_URL` to the publicly reachable HTTPS RMM URL before building packages; a package built with `127.0.0.1` can only reach that same computer. A clean Windows 10/11 MSI lifecycle run and live ScreenConnect integration remain release gates. ScreenConnect's supported integration methods require approved developer documentation and an authorized instance account; do not guess API endpoints. Follow [the architecture and delivery plan](docs/architecture-roadmap.md) for status and security decisions.
