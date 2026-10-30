# Family RMM

Self-hosted remote monitoring and management for devices you are authorized to administer.

## Current working slice

The runnable application includes a protected owner setup/sign-in flow, a local API, a SQLite development database, Overview and Devices inventory pages, Enrollment, and Audit. The administrator can create policy-limited enrollment grants and build actual Windows MSI and graphical EXE installer packages. The Windows service agent enrolls automatically with a device-specific key, checks in, and reports hardware and installed software inventory. Package generation, download, grant revocation, and agent-to-API enrollment/inventory are covered by the end-to-end API test. No sample devices are inserted.

This is an active build, not a production release. Local development builds are unsigned and point to the local development server. Production package creation fails closed unless Authenticode signing is configured. A clean Windows 10/11 graphical install/upgrade/repair/uninstall acceptance run and live ScreenConnect integration remain release gates. PostgreSQL/Docker deployment and remote task execution also remain on the roadmap. See [Windows agent packaging and release](docs/windows-agent-release.md) and [the architecture and delivery plan](docs/architecture-roadmap.md) for constraints and status.

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

The API test uses an isolated temporary SQLite database. It verifies owner setup/auth, enrollment policy and grants, quota/expiry/revocation, builds real MSI and EXE files, checks downloads, runs the .NET agent self-check and enrollment/check-in harness against the live test API, verifies hardware/software inventory, and confirms revoked packages cannot be downloaded. It does not insert devices into the development database.

## Production status

Do not expose the current development server to the internet. For multi-computer distribution, configure `RMM_SERVER_URL` to the publicly reachable HTTPS RMM URL before building packages; a package built with `127.0.0.1` can only reach that same computer. ScreenConnect's supported integration methods need to be confirmed from the user's licensed instance documentation before implementing a live connector; do not guess API endpoints. Follow [the architecture and delivery plan](docs/architecture-roadmap.md) for status and security decisions.
