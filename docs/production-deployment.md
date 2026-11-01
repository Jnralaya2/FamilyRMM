# Production deployment and recovery (single VPS)

This is a single-server Docker Compose deployment behind Caddy. Do not expose the Node application port directly. The procedures below are operational changes: use them only for an approved release or a declared recovery event.

## Approved production deployment procedure

Use one release entry point: `scripts/deploy-live.ps1`. Review the local change, build, release bundle, migrations, and rollback plan before asking an authorized administrator to run it. The script uploads the release bundle and protected runner, then calls `deploy/deploy-release.sh` on the VPS. The remote runner validates the existing Compose services and storage paths, builds and inspects the candidate image, creates and validates backups, then replaces source files and recreates app and Caddy. The PowerShell wrapper checks public API/database health and the expected frontend assets.

Replace `YOUR_VPS_IP` in the command examples with the approved host address. Use a dedicated SSH account named `deploy`; do not SSH as root. The account needs write access to its own home directory, Docker access for inspection, and non-interactive `sudo` authorization for installing and running the protected deployment and rollback scripts. The deployer uploads into a mode-700 temporary directory in the account's home, verifies SHA-256 hashes, and installs the release runners under `/root` with `sudo` before execution. Keep the sudoers grant restricted to the required deployment commands.

Do not manually extract a release ZIP into `/opt/family-rmm`. Do not run `deploy/upgrade.sh` or `scripts/deploy-public-readiness.ps1`; both legacy entry points are disabled. Do not casually run `docker compose down -v`, Docker volume removal, `docker system prune`, `docker builder prune`, database restore commands, or a release/rollback command. These can interrupt service or destroy recovery material.

## What a release backup contains

Each release creates a private directory such as `/var/backups/family-rmm/deploy-<UTC timestamp>/` before replacing application files. The directory contains:

- `project.tar.gz`: current application source/configuration, including the existing `.env` and `secrets/` files. The archive is mode `0600` in a mode `0700` directory.
- `database.sqlite`: a consistent SQLite snapshot made with `VACUUM INTO`, copied from the persistent volume and mode `0600`.
- `database.sqlite.sha256`: SHA-256 checksum for the snapshot.
- Previous app and Caddy image IDs and configured image references, plus rollback image tags.
- The persistent data-volume identifier and backup-format version.

The snapshot is validated before source replacement: source archive must exist, be nonempty, and list successfully; database snapshot must exist and be nonempty, its checksum must match, and SQLite `PRAGMA integrity_check` must return `ok`. Required backup metadata and the previous app/Caddy images must be present and inspectable. If a check fails, the release stops before replacing application files. A partial backup may remain for diagnosis; it is not automatically deleted.

The release backup is **not** a full VPS backup. SQLite and installer artifacts share the persistent `rmm_data` volume; the deployment snapshot copies the database but does not archive the artifact directory or Caddy's TLS volumes. Those live volumes are left in place during ordinary deployment/rollback. Protect against host/volume loss with an encrypted off-site backup that covers the database, installer artifacts, Caddy state as appropriate, source/configuration, and required secrets. No scheduled or off-site backup job is included here. The in-volume SQLite snapshot and host backup directories have no automatic retention cleanup and will grow over time.

## Application rollback

After a post-backup failure, the release runner attempts to restore the previous source tree and app/Caddy images. If a failed app image is available, it is preserved under a separate failed-release diagnostic tag/directory; it does not overwrite the good deployment backup. Rollback does **not** restore the SQLite database. It preserves records written before, during, and after the attempted release, provided the previous app version remains compatible with the current schema.

To identify a manual rollback candidate, inspect `/var/backups/family-rmm/LATEST` and list the corresponding `deploy-*` directory. Use only a directory containing the validated source archive, database snapshot and checksum, `old-image-id`, `old-caddy-image-id`, image references, data-volume record, and backup-format marker. The rollback script rechecks the archive, checksum, SQLite integrity, and image availability before changing the current application. It saves a pre-rollback source/app/Caddy image record, restores the prior code and image tags, recreates app and Caddy, and waits for health. It never copies the database snapshot into the live volume.

An authorized administrator can run the checked, full-path backup explicitly during a recovery window:

```powershell
ssh deploy@YOUR_VPS_IP "sudo -n sh /opt/family-rmm/deploy/rollback.sh /var/backups/family-rmm/deploy-<UTC timestamp>"
```

Omitting the path selects `LATEST`; specifying it makes the intended recovery point reviewable. After rollback, verify Docker health, public `/api/health`, the dashboard assets, and agent reconnections. If rollback reports failure, stop and inspect its diagnostics and Docker logs rather than repeatedly rerunning it.

## Database restoration is separate

Restoring `database.sqlite` is not an ordinary code rollback. It can discard device, enrollment, audit, installer, and deployment records written after the snapshot. The app applies forward-only SQLite schema updates at startup; there is no automatic down migration. Before any database restore, preserve the current database separately, compare the migration and schema compatibility, approve the expected data-loss window, stop the app cleanly, validate the selected snapshot, restore with the app's correct file ownership, then run integrity and application health checks. Perform and document a restore drill on an isolated copy first. Do not restore the database automatically from the release trap.

## Legacy scripts and first deployment

`deploy/upgrade.sh` and `scripts/deploy-public-readiness.ps1` are retained only to fail with an explanation; they do not upload or extract anything. The latter previously extracted files before its backup gate and must not be used.

For a first deployment, use a separately reviewed bootstrap procedure: configure the production `.env`, secure the ECDSA enrollment signing key, verify DNS and firewall ports 80/443, then start Compose. Do not use the first-deployment instructions as an upgrade procedure.

## Runtime and storage

Compose runs the Node app on port 3000 behind Caddy on ports 80/443. Caddy stores TLS state in named volumes. SQLite and installer artifacts use the persistent `rmm_data` volume at `/var/lib/family-rmm`; SQLite uses `/var/lib/family-rmm/rmm.sqlite` and artifacts use `/var/lib/family-rmm/artifacts`. This is a single-VPS baseline, not a multi-node/HA deployment.

The production image builds Windows MSI and EXE artifacts from the checked-in agent source using .NET and `wixl`. Current release signing requirements and Windows acceptance testing remain separate release gates; never place a signing private key in the public app image or release bundle.
