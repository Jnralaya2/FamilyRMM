# Family RMM

Self-hosted remote monitoring and management for devices you are authorized to administer.

## Current working slice

The first runnable application includes a protected owner setup/sign-in flow, a real local API, a SQLite development database, and a polished Overview and Devices inventory interface. Dashboard counts, device search, sorting, status filtering, export, and device details read from the database. No sample devices are inserted; new installations correctly show empty inventory until an agent enrolls and checks in.

This is an active build, not a production release. Agent enrollment, MSI generation/signing, PostgreSQL/Docker deployment, task execution, ScreenConnect and the rest of the roadmap are not implemented yet.

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

The API test uses an isolated temporary SQLite database and verifies owner setup, origin checking, password validation, session cookies, protected reads, CSRF, logout and login. It does not insert devices into the development database.

## Production status

Do not expose the current development server to the internet. Before production use, the platform still needs the approved roadmap's production database/deployment, TLS/reverse proxy, account and role management, enrollment policies, authenticated Windows agent, downloadable signed MSI pipeline, remote task controls, ScreenConnect adapter and real-device acceptance testing. Follow [the architecture and delivery plan](docs/architecture-roadmap.md) for status and security decisions.
