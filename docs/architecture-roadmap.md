# RMM platform: initial architecture and delivery plan

**Status:** active implementation; first dashboard slice is runnable locally
**Prepared:** 2026-10-30
**Scope:** self-hosted RMM for devices the operator is authorized to administer

This document records the architecture and delivery gates. Implemented items and test evidence are in Section 9; the dashboard slice is not a production-ready RMM platform.

## 1. Development environment inspected

The assigned `Family_RMM` workspace was empty when inspected. There are other `MyRMM` directories on the Desktop, but they are outside this workspace's write permissions. They were not changed or treated as the source of truth.

| Tool | Available | Observation |
|---|---:|---|
| Node.js | Yes | v24.21.0 is installed. Use the current Node LTS line for production, pinned in the project, instead of assuming the local current release is the deployment target. |
| npm / npx | Yes | Available with the Node installation. |
| Python | Yes | 3.14.8 is installed; not selected as the primary application runtime. |
| .NET SDK | Yes | 10.0.403 is installed. |
| Docker | No | Not found on PATH; its installer download stalled and was stopped. Still needed for PostgreSQL/deployment workflow. |
| Git | Yes | v2.56.0.windows.3 exists at `C:\Program Files\Git\cmd\git.exe`; this workspace's repository is initialized. The executable is not on this shell's PATH. |
| Go | No | Not found on PATH; needed for the proposed Windows service agent. |
| WiX CLI | Yes | WiX Toolset v7.0 is available at `C:\Program Files\WiX Toolset\v7.0\bin\wix.exe`; use it for MSI authoring. |
| Inno Setup compiler (`iscc`) | No | Not found on PATH; no longer required because WiX is available. |
| Windows service / certificate utilities | Partly | `sc.exe` and `certutil` are available; `signtool` and OpenSSL are not found on PATH. |

This is a PATH-level inventory, not an exhaustive check for tools installed under other names or locations. The OS CIM query was denied, so the Windows edition could not be confirmed through that query. WiX and Git were found on disk in follow-up checks. Docker remains unavailable; the Go installer reached a Windows permission prompt.

## 2. Proposed technology choices

- **Management API:** TypeScript on the Node.js LTS line, with a maintained HTTP framework, schema validation at every external boundary, and OpenAPI documentation. This fits the available JavaScript environment and supports a clear API contract without coupling the Windows agent to the browser UI.
- **Dashboard:** React and TypeScript, built as a static application served by the management service or reverse proxy. Use a small, consistent component and icon system with keyboard-accessible controls, explicit loading/error/empty states, and real API-backed workflows.
- **Database:** PostgreSQL for the self-hosted production service. The first local dashboard slice uses Node's built-in SQLite module so it can run before Docker is installed; preserve schema ownership and migration boundaries, then move the production deployment to PostgreSQL before agent rollout. Use foreign keys, uniqueness constraints, transaction boundaries, and retention policies.
- **Windows agent:** Go, built as a Windows service for Windows 10/11 and supported Windows Server versions. Go's single-binary deployment and Windows service support make a small outbound-only service practical. The agent should have a narrow, auditable task executor and signed update path.
- **Transport:** HTTPS REST for enrollment and ordinary API operations; outbound mutually authenticated TLS (mTLS) for the agent's persistent event/task channel where practical. Use short-lived server-issued device certificates or equivalent device credentials after enrollment. Never place administrator credentials in an agent or installer.
- **Deployment:** Docker Compose for a documented single-VPS deployment, with PostgreSQL on a private network, a reverse proxy for HTTPS, durable volumes, health checks, and explicit backup/restore procedures. Do not expose PostgreSQL or internal management endpoints publicly.
- **Testing:** TypeScript unit/integration/API tests, PostgreSQL integration tests, Windows agent unit tests, signed-package validation tests, and a documented manual acceptance matrix for Windows service installation and real ScreenConnect operation.

Version pinning, supported dependency versions, vulnerability review, license review, and framework selection will be finalized before the implementation checkpoint. No external package has been selected or installed yet.

## 3. System architecture

```text
Administrator browser
        | HTTPS; session cookie; CSRF protection
        v
Reverse proxy (TLS termination, request limits)
        | private application network
        +--> Management API / web application (RBAC, validation, audit)
        |              |              |
        |              |              +--> ScreenConnect adapter (server-side secrets)
        |              +--> PostgreSQL (inventory, identities, jobs, audit)
        |
        +<== outbound agent mTLS / authenticated event channel == Windows services
                                                                  |
                                                        Windows protected key store
```

The server is the authority for enrollment policy, permissions, task creation, task authorization, revocation, and audit events. Agents initiate outbound connections; managed computers do not need inbound firewall ports. The UI is a client of the API and never connects directly to the database or ScreenConnect with server credentials.

### Core data areas

- Administrators, roles, permission assignments, sessions, and login security events.
- Organizations/tenants (even if the first deployment is single-tenant), device groups, and group membership.
- Devices, device identity public keys/certificate serials, check-ins, current inventory snapshots, and historical metric samples.
- Enrollment policies, package issuance/consumption records, pending enrollment requests if policy requires review, and revocation records.
- Script definitions and versions, scheduled runs, task dispatches, per-device execution state, bounded stdout/stderr, exit code, timing, and cancellation state.
- Audit events with actor, action, target, timestamp, request correlation, and carefully redacted details.
- ScreenConnect association metadata, with no ScreenConnect password or API secret in device records or browser responses.

Use migrations from the first schema change. Store timestamps in UTC, define retention limits for high-volume telemetry and task output, and make audit records append-only to application roles.

## 4. Security architecture and automatic enrollment

### Installation and enrollment flow

1. An administrator generates a generic reusable Windows package from the **Downloads** page, or a policy-scoped package from Enrollment. Device and session caps are not enforced. The generic package is independent of enrollment authorization and is safe to share; package download does not authorize a computer.
2. The package contains the configured server URL and public task-signing key, never an administrator credential, enrollment grant, or private key. A recipient installs the MSI through normal Windows Installer UI and UAC; the package registers an automatic Windows service.
3. On first start, the agent creates a unique ECDSA key pair and protects its private key with machine-scope DPAPI. It submits a timestamped nonce and proof of possession over HTTPS. A new device is created as pending and receives no management access before administrator approval. The dashboard exposes approve/reject controls; rejection or subsequent device revocation blocks authenticated requests.
4. After approval, the agent polls enrollment status, then reports initial hardware/OS/software inventory and starts its authenticated heartbeat. The device appears in the existing dashboard. Nonces, per-device signatures, server-side state and administrator approval protect the flow; the MSI is not an authorization secret.
5. Policy-scoped signed grants remain supported for controlled workflows. Legacy quota fields and license caps are retained for compatibility but no longer block device enrollment or downloads. Grant expiration/revocation controls grant-based enrollment, not access to an already-generated generic package.

A publisher signature proves package origin and integrity; it does not by itself authorize an arbitrary computer to join. The reusable MSI only permits a device to request enrollment. An administrator must approve each device before it receives management access. Each installation gets a distinct device identity, and administrators can revoke an enrolled identity.

### MSI generation and release pipeline

- Build versioned MSI artifacts from a reviewed, reproducible release input. Keep product code/upgrade code, semantic version, publisher name, service lifecycle, upgrade/repair/uninstall behavior, and supported Windows versions under source control.
- Separate immutable agent binaries from policy configuration. A package-generation service embeds the server URL and signed policy grant in the MSI (or uses a signed configuration resource fetched by a package-specific URL). Package configuration never contains an admin password, reusable fleet key, or private key.
- Preserve an MSI catalog with version, hash, creation time, signing status, generic/policy-scoped mode, and stable package download path. Enforce administrator permissions on generation; emit clear pending/approved/denied and first-check-in states. Package downloads do not depend on enrollment grants.
- Sign agent executable/DLL files before MSI assembly, then sign the final MSI after all configuration is embedded. Timestamp signatures. Any post-signing modification invalidates the signature. Keep signing out of the application server: use a protected release/signing service or HSM-backed key, with authorization and audit for each package. If the dashboard creates unique MSI bytes on demand, it submits build inputs to that signing service and returns the completed artifact; it never reads the signing private key.
- The dashboard download can be backed by a completed, signed artifact only. A build/signing failure must fail closed and display an error; it must never return an unsigned MSI as a successful production download.

### Authenticode and public distribution

For public MSI distribution, sign the MSI and the agent's executable code with an Authenticode code-signing identity chaining to a CA trusted by Windows. Organizational validation (OV) is the practical baseline; Microsoft's Artifact Signing is another option where the publisher and region are eligible. A self-signed certificate is suitable only for local testing or a managed fleet where its trust root was installed administratively. Protect signing keys in an HSM or managed signing service; never commit a PFX/password or expose the key to the web application.

Sign the agent binaries first, package the final configured MSI, then sign and timestamp that MSI. Verify publisher, signature, chain, timestamp, and artifact hash in release checks. MSI signing is a final packaging step, so changing signing provider or certificate does not require redesigning the API, database, agent protocol, or dashboard; only the signing adapter/configuration and publisher metadata change. All files that Windows may execute (service EXE, DLLs, custom-action binaries and updater) need an appropriate signature as well.

Signing does not promise a warning-free first download. Microsoft SmartScreen considers both publisher and file reputation; newly signed products may initially show an unknown-publisher-reputation warning while reputation accumulates. EV certificates no longer provide an instant SmartScreen bypass. Keep publisher identity consistent, publish from the official HTTPS dashboard, provide a hash and verified-publisher instructions, and never instruct recipients to disable SmartScreen. See Microsoft's current [code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options) and [SmartScreen reputation guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

### Management and task safeguards

- Administrator login uses a modern password hash, rate limits, secure session cookies, CSRF protection, session rotation, and explicit role checks on every management route and socket action.
- Start with roles such as Owner, Administrator, Operator, and Read-only, with least-privilege permissions for device actions, scripts, enrollment, users, audit, and configuration.
- Script execution requires an authenticated authorized administrator, explicit target resolution, a durable task record, an immutable script version/hash, policy validation, task expiry, timeout/output limits, and an audit event before dispatch. Agents verify server identity, task identity, expiry, and signature/MAC before execution. Results are correlated to the task and are not executable input to another task.
- Never execute arbitrary shell content received from unauthenticated clients. Define cancellation semantics precisely: pending work can be cancelled; already-running PowerShell may only be interruptible when the agent can safely terminate its process.
- Validate and bound every API and agent payload. Apply TLS, rate limiting, secure headers, dependency scanning, database least privilege, secret redaction, and operational logging without credentials or script secrets.
- Keep TLS private keys, session secrets, database credentials, ScreenConnect API credentials, and code-signing private keys out of source control and container images. Use deployment secret files or a supported secret manager with rotation instructions.
- Signed agent updates use a separate update-signing trust root, version/rollback policy, and signature verification before replacement.

### ScreenConnect boundary

ScreenConnect integration is **not implemented**. Do not show a connection or enrollment as successful until a supported adapter exists and confirms the session on the configured instance. Use a supported deployment method for client installation and verify the client appears in the instance's actual session list; downloading an ordinary client is not enrollment. Each configured instance will need its canonical URL, supported edition/version, server-side least-privilege credential reference, health state and audit trail. Device/session mappings and access links must be instance-scoped, and credentials must never be sent to the browser or logged.

ConnectWise describes ScreenConnect integration as embedded extensions and gates product API documentation through its developer program; use only integration methods documented for the target instance/version. The [ScreenConnect developer page](https://developer.connectwise.com/Products/ConnectWise_ScreenConnect) directs developers to the University for API documentation, and ConnectWise explains that documentation access depends on registration and approval in its [developer-network guide](https://developer.connectwise.com/Best_Practices/Getting_Started). Implementation needs approved docs for the selected instance, URL, edition/version and a least-privilege integration account. Live verification additionally requires an authorized instance and a disposable enrolled Windows endpoint. Do not infer a universal REST API or claim arbitrary instances are compatible.

## 5. Product and dashboard design system

Before building pages, establish design tokens for typography, spacing, borders, surfaces, semantic status colors, focus rings, and motion. Use a restrained neutral canvas with one brand accent and consistent online/warning/offline/error semantics. Use a professional SVG icon set with labels or accessible names; no emoji as controls.

The primary navigation should organize Overview, Devices, Software, Scripts & Tasks, Groups, Audit, and Administration. The device list should prioritize scanability: searchable and filterable rows, sortable columns, stable status indicators, useful pagination, and clear bulk-selection rules. A device detail view should use a consistent header and tabs for Summary, Hardware, Software, Performance, Tasks, and Access. Charts must show actual sampled data, units, time ranges, and gaps; no seed data in production.

Every action needs a defined permission, API operation, success state, failure state, and audit behavior before its control is rendered. Destructive actions use a focused confirmation dialog with the target named. Loading, no-data, filtered-empty, offline, and API-error states are designed intentionally. Layouts adapt to small screens, and keyboard focus, contrast, form labels, table semantics, and reduced-motion preferences are part of acceptance.

Before expanding to the full product, implement a reviewable, working Overview dashboard and Devices inventory page using real backend APIs. Treat this as a design review checkpoint: typography, spacing, color/semantic status, iconography, navigation, table density, responsive behavior, accessibility and all visible actions must be coherent and functional before the remaining dashboard pages are built. Do not use fake device rows to make the initial review look populated; make the empty/loading/error states polished until real agents provide data.

## 6. Implementation roadmap and feature checklist

Work proceeds in small reviewable checkpoints. The status column remains **Not started** until work is implemented and evidence is recorded.

| Phase | Deliverable / exit condition | Status |
|---|---|---|
| 0. Foundation | Prepare workspace, establish Git, verify/pin runtime and package/installer/signing tools, record architecture decisions. | Partial: Git, Node/npm, .NET SDK and WiX are available; Docker, Go and SignTool are unavailable. .NET is used for the Windows agent. |
| 1. Platform skeleton | Docker Compose, PostgreSQL, migrations, health checks, typed API, structured logs, configuration validation, CI-ready commands, and local developer guide. | In progress: local SQLite-backed API, health check, Vite development server and README exist; PostgreSQL/Docker deployment remains. |
| 2. Admin identity | First-run owner setup, secure login/logout, session/CSRF protection, RBAC, account management, audit event foundation, and auth tests. | Partial: one-time owner bootstrap, scrypt password hash, sessions, origin/CSRF checks, login rate limit and audit events. RBAC/user administration remain. |
| 3. Enrollment and MSI pipeline | Policy UI/API; dashboard package generation/download/version catalog; server-side MSI build; device key provisioning; install/enrollment status; signing-service interface. | Implemented and API-tested: generic MSI + graphical EXE builds run from the dashboard using the production app's .NET SDK and Linux-native msitools compiler; no Windows worker command is needed. Production-mode integration tests verify the queued build and real file downloads. Packages are unsigned pilot builds; clean Windows GUI lifecycle tests and production Authenticode signing remain. |
| 4. Agent baseline | Windows service install/uninstall, outbound authenticated connection, heartbeat, reconnect/backoff, device identity, version reporting, and real Windows install test. | Agent implemented: self-contained .NET Windows Service, automatic signed enrollment, DPAPI-protected unique identity, heartbeat, hardware/software inventory, and signed package self-check. API integration test validates live test-server enrollment/reporting. MSI install/UAC/reboot/upgrade/repair/uninstall still require clean Windows 10/11 acceptance. |
| 5. Inventory and monitoring | Host/OS/hardware/network/uptime collection, software inventory, storage and performance samples, online/offline rules, device search/filter/grouping, and data correctness tests. | Partial: agent reports OS, BIOS/model, CPU, cores, memory, IP addresses, and installed software; API integration test verifies device detail receives real inventory. Storage, richer metrics and Windows VM acceptance remain. |
| 6. Design review dashboard | Complete design tokens/system; working Overview and Devices inventory pages backed by real APIs; polished empty/loading/error states; responsive/accessibility review; user design review checkpoint. | Implemented locally: owner setup is complete; Overview and Devices use real APIs; enrollment controls now use real policy/grant/approval APIs. User review is ongoing. |
| 7. Product dashboard | Device detail, Hardware, Software, Groups, installer/agent administration, enrollment/settings, audit, system health, accessibility; every visible action wired and permission-checked. | Partial: Enrollment policy/authorization workflows and a searchable, read-only audit log are backed by real API routes. Full device detail pages, groups and remaining admin features are outstanding. |
| 8. Scripts and software deployment | MSI/EXE catalog upload with integrity hashes; administrator PowerShell scripts; approved device selection and bulk queue; server-signed, expiry-bound task envelopes; device-authenticated claim/download/results; agent-side hash verification, bounded timeout/output; per-target activity and audit. Scheduling, cancellation of running work, metadata/signature validation and clean VM installer acceptance remain. | Partial: software MSI/EXE upload, PowerShell script catalog, bulk job targeting to enrolled devices, signed task delivery and result state are implemented. API integration test executes a harmless PowerShell smoke script; installer payload transport is hash-checked but the smoke test deliberately does not run its dummy MSI. Clean VM install/update testing and scheduling/cancellation remain. |
| 9. Deployment channels and ScreenConnect adapter | Build real deployment connectors for administrator-authorized channels (first priority: supported ScreenConnect instances), with per-instance connection/health/secret configuration, device association, target selection, install initiation, progress/failure reporting, audit, cancellation where supported, and contract tests. Verify each supported instance type/version separately. | Partial: customer workspaces can save multiple distinct canonical HTTPS cloud/self-hosted URLs, optional version, and audit add/remove actions. Records are tenant-scoped with per-workspace URL uniqueness; the API never returns another workspace's instances. Entries report awaiting adapter. Authentication, session sync, device mapping, connection test, deployment and host-session launch remain unimplemented. ConnectWise gates integration documentation through its developer program, so supported API/extension docs and least-privilege instance access are prerequisites. No API path or deployment success is being guessed. |
| 10. Production hardening | TLS/reverse proxy, backups and restore drill, retention, migrations/update procedure, monitoring/alerts, dependency/security review, signed MSI release pipeline, clean VPS and Windows deployment tests. | Not started |
| 11. Release | Administrator/operator documentation, complete test report, clean Windows 10/11 and Linux acceptance runs, source package, and final ZIP containing verified project files. | Not started |

Feature coverage to track across those phases: administrator accounts and permissions; device lifecycle and revocation; device groups; hardware/software inventory; performance history; agent management and updates; installer generation and authorized multi-device enrollment; deployment-channel connectors that can initiate installs on selected authorized computers and report actual results; script library; one-device and group execution; schedules; execution history/results/cancellation; multi-instance ScreenConnect access; audit log; enrollment policies; system health; Docker deployment; backup/recovery; operator documentation. Do not create navigation entries for unfinished pages. Do not use fake devices or simulated success in production paths.

## 7. Testing and acceptance strategy

Tests are added with the feature they protect. A release report records the command/environment, expected and actual outcomes, pass/fail, fixes, and known limits. No result is marked passed without running it. A missing external service or signing certificate is recorded as blocked by that dependency, not silently skipped or claimed successful.

| Area | Automated evidence | Real-world acceptance evidence |
|---|---|---|
| Database | Migration up/down or forward-compatibility policy, constraints, transaction/rollback, retention, and authorization scoping tests against PostgreSQL. | Clean-volume startup, migration, backup, and restore on a disposable deployment. |
| Authentication/RBAC | Login success/failure, lockout/rate limit, session rotation/expiry, CSRF, role matrix, tenant/device isolation, and unauthorized script/action rejection. | Login and least-privilege workflow in deployed HTTPS environment. |
| Enrollment | Valid multi-device grant claims, altered signature, wrong audience, expiry, quota reached, policy rejection/approval, concurrent claim race, grant revocation, per-device identity, credential protection metadata, and device-revocation denial. | MSI on clean Windows VM; normal graphical flow and UAC; no enrollment code typed; authorized device appears; expired/revoked grant denied. |
| MSI installer | Artifact signature/metadata/hash, service install/remove/upgrade/repair definitions, clean build reproducibility, policy payload validation, and fail-closed signing behavior. | On clean Windows 10 and Windows 11 VMs: graphical install, UAC, service creation/start and post-reboot startup, auto-registration, dashboard presence, hardware/software inventory, upgrade, repair, uninstall, reinstall/re-enrollment, expired/revoked grant. Record exact OS/build and signature state. |
| Agent lifecycle | Identity persistence, heartbeat, reconnect/backoff, malformed server response, TLS failure, version, and simulated network loss. | Install/reboot/uninstall on Windows 10/11 and supported Server VM; disconnect/reconnect network; verify service recovery. |
| Inventory/monitoring | Schema validation, required fields, software normalization, duplicate handling, stale/offline thresholds, history windows, and data ownership. | Compare reported OS, memory, CPU, disks, IPs, users, uptime, and installed apps with the tested host. |
| Dashboard/API | Route/API integration, filters/sort/pagination, empty/error/loading states, permissions, form validation, and action feedback. Accessibility checks include keyboard paths, focus, labels, and contrast review. | Windows Downloads and enrollment review screens are available; production HTTPS download and clean Windows acceptance remain unverified. |
| Remote scripts | Task signature/expiry, role restrictions, target set, output bounds, timeout, cancellation-while-pending, exit codes, duplicate delivery/idempotency, and audit completeness. | Run benign, administrator-approved PowerShell on disposable Windows agents; verify output, errors, timing, and unauthorized denial. |
| Deployment and ScreenConnect | No connector implementation or tests exist. | Requires approved ScreenConnect integration documentation, an instance URL/edition/version, least-privilege integration credentials, and a disposable Windows endpoint. A normal client download does not satisfy enrollment. |
| Deployment/security | Container health, configuration fail-fast, secret absence in image/repository, HTTPS/proxy headers, rate limits, dependency review, and restore procedure. | Fresh Linux VPS or clean VM deployment, DNS/TLS, firewall, backup restore, and update/migration walkthrough. |

Release gates: no known critical/high exploitable security issue without an explicit remediation decision; all required automated suites pass in their stated environment; Windows install/enrollment/heartbeat and benign task acceptance are performed on a clean disposable Windows system; clean deployment and restore are exercised; and ScreenConnect is either live-tested or clearly listed as unavailable/unverified. If device hardware, certificate, tenant credentials, licensing, or network access is needed, request it only at the phase that depends on it.

## 8. Decisions and unresolved inputs

1. **Write location:** continue in `Family_RMM`. Existing sibling project folders are read-only under the current permissions; no changes have been made to them.
2. **Production signing:** acquire Authenticode signing for the publisher identity and separately protect update signing. Private keys remain off the app server and source repository. SmartScreen reputation may take time to build.
3. **Enrollment:** generic packages require explicit administrator approval for each device; grants remain available for policy-scoped enrollment. Download alone does not authorize access.
4. **ScreenConnect:** implementation and live verification are blocked on approved docs, the user's instance URL, edition/version, and a least-privilege integration account. Never put credentials in this document.
5. **Deployment target:** final capacity, DNS/domain, SMTP (if account recovery is needed), backup location, and retention targets should be set before production deployment.
6. **Development tools:** Git and Node/npm are available. Docker, Go and SignTool are not on PATH in the latest check. The earlier Go installer required Windows consent; no elevation dialog was automated and no claim is made that Go completed installation.

## 9. Current completion record

- [x] Read the complete project brief and inspect the assigned workspace.
- [x] Check availability of Node.js, npm/npx, Python, .NET, Docker, Git, Go, WiX, Inno Setup compiler, SignTool, and service utilities by PATH.
- [x] Update plan for multi-device MSI generation/download, policy quotas/expiry/revocation, Authenticode, SmartScreen, ScreenConnect adapter implementation/live verification, and the design review checkpoint.
- [x] Initialize Git repository in `Family_RMM` and create the first runnable dashboard/API slice.
- [x] Implement local owner setup/login, protected API, SQLite-backed Overview/Devices, health status, real-data empty states, search/filter/sort/pagination/CSV export, and device details.
- [x] Run `npm.cmd run build` successfully; Vite emitted only non-fatal `use client` bundle warnings from Lucide.
- [x] Run `npm.cmd test` successfully with localhost permission; covers setup/origin/password validation, session cookie, protected reads, CSRF/logout, login, policy/grant creation, Ed25519 auto-enrollment, grant quota across multiple devices, signed heartbeat and inventory, replay denial, pending approval, and device revocation.
- [x] Implement authenticated dashboard policy creation, signed authorization issuance, pending enrollment approval/rejection, and grant revocation controls; controls call real API routes.
- [x] Implement a searchable audit log page backed by the audit API, including administrator, target, timestamp and event detail.
- [x] Run `npm.cmd run build` after adding the Enrollment page; build passed with only the existing non-fatal Lucide bundler warnings.
- [ ] Install Docker Desktop and Go. Docker download stalled and was stopped; Go installer is waiting on Windows consent. No feature enablement or reboot has been made.
- [ ] Capture user review of Overview, Devices and the new Enrollment page.
- [x] Implement .NET Windows service agent, MSI/EXE generation and generic dashboard downloads with pending approval enrollment; API integration test builds and exercises real agent source against the isolated test API.
- [x] Remove the production Windows worker requirement; production mode now builds actual MSI/EXE artifacts in the Family RMM server queue and the Downloads page starts its generic package build automatically.
- [x] Change live deployment to rebuild the app without Docker cache and verify the live frontend asset fingerprint after the health check.
- [x] Test the production-mode installer queue and verify real MSI/EXE downloads. The Windows host integration suite passed; the Linux Docker image build still needs deployment verification.
- [ ] Build a production MSI against a reachable HTTPS deployment and pass clean Windows 10/11 GUI install/reboot/uninstall acceptance. Public DNS for the configured hostname did not resolve in this execution environment.
- [ ] Implement ScreenConnect integration from approved instance documentation and live-test client deployment/session presence. This remains unimplemented and requires the configuration and credentials listed above.
