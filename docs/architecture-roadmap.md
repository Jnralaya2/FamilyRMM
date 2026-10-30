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

1. An administrator creates/selects an enrollment policy and generates a Windows MSI from the dashboard. The policy controls server audience, allowed OS/version, default group, expiry, a maximum number of successful enrollments, and automatic approval vs pending approval. The dashboard shows package/agent version, creation/expiry, use count, status, policy, and download/revoke actions.
2. The generated MSI contains the server address and a **signed, non-secret enrollment grant** bound to that server and policy. It is safe to distribute the same MSI to the policy's authorized computers: the grant is not an administrator credential and cannot authenticate an agent by itself. The server enforces expiry, policy, atomic enrollment quota, and revocation. Administrators can revoke a grant, preventing further enrollments, and revoke an individual device identity after enrollment. Package creation, download, claim, denial, and revocation are audited.
3. A recipient double-clicks the MSI and completes the normal Windows Installer UI. Installing the Windows service requests normal UAC elevation when required; no shell/PowerShell command or enrollment code is needed. The MSI creates a device key pair locally; where supported, keep the private key in the Windows machine key store with restrictive ACLs, and protect persisted credentials using Windows DPAPI or a non-exportable key provider.
4. The agent presents the signed grant and its unique device public key over TLS. The server validates the signing key, audience, expiry, policy, quota/replay rules, and approval mode. It reserves/consumes an enrollment slot transactionally to prevent parallel installers exceeding the limit. Failure is shown in dashboard enrollment status and audited without recording credentials.
5. On approval, the server issues a device-specific credential/certificate. The agent stores its private key protected by Windows, connects outbound, reports initial hardware/software inventory, and begins heartbeat. The dashboard shows enrollment/install state and last successful check-in.
6. The dashboard can revoke the package grant and can separately revoke a device identity immediately. Device revocation blocks future API/session/task access, closes live sessions, and records actor, reason, and time. A revoked device needs a newly authorized enrollment grant to re-enroll.

A publisher signature proves package origin and integrity; it does not by itself authorize an arbitrary computer to join. Enrollment authority comes from an administrator-generated, policy-limited grant and the user's controlled distribution of that installer. The grant is signed but non-secret, can enroll only up to a fixed quota before expiry, and is revocable. Each successful installation receives a distinct device identity. If Windows installer custom actions cannot safely enforce these rules, use a minimal signed bootstrapper or MSI custom action with the same server-side policy checks; do not weaken the authorization model.

### MSI generation and release pipeline

- Build versioned MSI artifacts from a reviewed, reproducible release input. Keep product code/upgrade code, semantic version, publisher name, service lifecycle, upgrade/repair/uninstall behavior, and supported Windows versions under source control.
- Separate immutable agent binaries from policy configuration. A package-generation service embeds the server URL and signed policy grant in the MSI (or uses a signed configuration resource fetched by a package-specific URL). Package configuration never contains an admin password, reusable fleet key, or private key.
- Preserve an MSI catalog with version, hash, creation time, signing status, policy/grant ID, expiry/quota, and revocation state. Enforce administrator permissions on generation/download/revocation; emit clear installation and first-connection statuses.
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

Design and implement the adapter during core development, independently of live credentials. Keep a provider interface and server-only connector with operations to validate configuration, find/search a guest session, associate or update a device mapping, and create a host-session launch URL through a supported ScreenConnect method. Persist the ScreenConnect session identifier and stable mapping key with a uniqueness constraint; prefer an agent-supplied stable device ID plus configured matching rules, and require admin resolution when ambiguous rather than creating duplicates. The API returns a short-lived authorized launch response and clear states for unlinked, offline, unavailable, permission denied, or provider error. Never send ScreenConnect credentials to the browser or log them.

Implement configuration validation, credential storage interface, provider adapter, mapping/deduplication, launch workflow, timeout/retry behavior, audit events, and automated contract/error tests before a live tenant is available. Keep a visible integration status. **Implemented** means adapter code and automated tests exist; **live-verified** means the workflow has been exercised against the user's configured/licensed instance. Do not conflate these states. Final API details and a live session test depend on the user's instance URL, edition, supported API/auth mechanism, and a least-privilege integration account. Consult the vendor's [ScreenConnect documentation](https://docs.connectwise.com/ScreenConnect_Documentation) for current supported interfaces.

## 5. Product and dashboard design system

Before building pages, establish design tokens for typography, spacing, borders, surfaces, semantic status colors, focus rings, and motion. Use a restrained neutral canvas with one brand accent and consistent online/warning/offline/error semantics. Use a professional SVG icon set with labels or accessible names; no emoji as controls.

The primary navigation should organize Overview, Devices, Software, Scripts & Tasks, Groups, Audit, and Administration. The device list should prioritize scanability: searchable and filterable rows, sortable columns, stable status indicators, useful pagination, and clear bulk-selection rules. A device detail view should use a consistent header and tabs for Summary, Hardware, Software, Performance, Tasks, and Access. Charts must show actual sampled data, units, time ranges, and gaps; no seed data in production.

Every action needs a defined permission, API operation, success state, failure state, and audit behavior before its control is rendered. Destructive actions use a focused confirmation dialog with the target named. Loading, no-data, filtered-empty, offline, and API-error states are designed intentionally. Layouts adapt to small screens, and keyboard focus, contrast, form labels, table semantics, and reduced-motion preferences are part of acceptance.

Before expanding to the full product, implement a reviewable, working Overview dashboard and Devices inventory page using real backend APIs. Treat this as a design review checkpoint: typography, spacing, color/semantic status, iconography, navigation, table density, responsive behavior, accessibility and all visible actions must be coherent and functional before the remaining dashboard pages are built. Do not use fake device rows to make the initial review look populated; make the empty/loading/error states polished until real agents provide data.

## 6. Implementation roadmap and feature checklist

Work proceeds in small reviewable checkpoints. The status column remains **Not started** until work is implemented and evidence is recorded.

| Phase | Deliverable / exit condition | Status |
|---|---|---|
| 0. Foundation | Prepare workspace, establish Git, verify/pin runtime and package/installer/signing tools, record architecture decisions. | Partial: Git repo initialized; Node/npm available. Docker and Go are still unavailable; WiX and SignTool were not confirmed on PATH in the latest environment check. |
| 1. Platform skeleton | Docker Compose, PostgreSQL, migrations, health checks, typed API, structured logs, configuration validation, CI-ready commands, and local developer guide. | In progress: local SQLite-backed API, health check, Vite development server and README exist; PostgreSQL/Docker deployment remains. |
| 2. Admin identity | First-run owner setup, secure login/logout, session/CSRF protection, RBAC, account management, audit event foundation, and auth tests. | Partial: one-time owner bootstrap, scrypt password hash, sessions, origin/CSRF checks, login rate limit and audit events. RBAC/user administration remain. |
| 3. Enrollment and MSI pipeline | Policy UI/API; dashboard package generation/download/version catalog; multi-device signed grants with expiry/quota/revocation; MSI service lifecycle; device key provisioning; install/enrollment status; signing-service interface. | Partial: policy/grant APIs and dashboard workflows, Ed25519 signed non-secret grants, quota/expiry/revocation, pending approval, device identity key proof and signed heartbeat/inventory APIs are implemented and API-tested. Windows agent, MSI generation/download/signing, package catalog, protected machine key storage and Windows acceptance tests remain unimplemented. |
| 4. Agent baseline | Windows service install/uninstall, outbound authenticated connection, heartbeat, reconnect/backoff, device identity, version reporting, and real Windows install test. | Not started |
| 5. Inventory and monitoring | Host/OS/hardware/network/uptime collection, software inventory, storage and performance samples, online/offline rules, device search/filter/grouping, and data correctness tests. | Not started |
| 6. Design review dashboard | Complete design tokens/system; working Overview and Devices inventory pages backed by real APIs; polished empty/loading/error states; responsive/accessibility review; user design review checkpoint. | Implemented locally: owner setup is complete; Overview and Devices use real APIs; enrollment controls now use real policy/grant/approval APIs. User review is ongoing. |
| 7. Product dashboard | Device detail, Hardware, Software, Groups, installer/agent administration, enrollment/settings, audit, system health, accessibility; every visible action wired and permission-checked. | Partial: Enrollment policy/authorization workflows and a searchable, read-only audit log are backed by real API routes. Full device detail pages, groups and remaining admin features are outstanding. |
| 8. Scripts and tasks | Script library/versioning, targets/groups, scheduling, signed task envelope, authorization, timeouts, cancellation semantics, result display, execution history, and hostile-input/auth tests. | Not started |
| 9. ScreenConnect adapter | Implement provider interface, config validation, credential interface, device mapping/deduplication, session launch, statuses, audit and automated contract tests. Live verification is a separate gate requiring real tenant access. | Not started. Official ConnectWise developer information currently describes ScreenConnect integration through embedded extensions, while API reference access is gated; exact supported methods must be based on the user's licensed instance documentation rather than guessed endpoints. |
| 10. Production hardening | TLS/reverse proxy, backups and restore drill, retention, migrations/update procedure, monitoring/alerts, dependency/security review, signed MSI release pipeline, clean VPS and Windows deployment tests. | Not started |
| 11. Release | Administrator/operator documentation, complete test report, clean Windows 10/11 and Linux acceptance runs, source package, and final ZIP containing verified project files. | Not started |

Feature coverage to track across those phases: administrator accounts and permissions; device lifecycle and revocation; device groups; hardware/software inventory; performance history; agent management and updates; script library; one-device and group execution; schedules; execution history/results/cancellation; ScreenConnect access; audit log; enrollment policies; system health; Docker deployment; backup/recovery; operator documentation. Do not create navigation entries for unfinished pages. Do not use fake devices or simulated success in production paths.

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
| Dashboard/API | Route/API integration, filters/sort/pagination, empty/error/loading states, permissions, form validation, and action feedback. Accessibility checks include keyboard paths, focus, labels, and contrast review. | Owner account is set up. Dashboard review is available at the local Vite URL; real devices still require the not-yet-built Windows agent/MSI. |
| Remote scripts | Task signature/expiry, role restrictions, target set, output bounds, timeout, cancellation-while-pending, exit codes, duplicate delivery/idempotency, and audit completeness. | Run benign, administrator-approved PowerShell on disposable Windows agents; verify output, errors, timing, and unauthorized denial. |
| ScreenConnect | Provider contract, config validation, credential redaction, mapping/deduplication, session-launch response, and unavailable/not-associated/ambiguous errors. | Launch and associate real sessions against the configured licensed ScreenConnect environment; otherwise mark implemented but not live-verified and identify exact dependency. |
| Deployment/security | Container health, configuration fail-fast, secret absence in image/repository, HTTPS/proxy headers, rate limits, dependency review, and restore procedure. | Fresh Linux VPS or clean VM deployment, DNS/TLS, firewall, backup restore, and update/migration walkthrough. |

Release gates: no known critical/high exploitable security issue without an explicit remediation decision; all required automated suites pass in their stated environment; Windows install/enrollment/heartbeat and benign task acceptance are performed on a clean disposable Windows system; clean deployment and restore are exercised; and ScreenConnect is either live-tested or clearly listed as unavailable/unverified. If device hardware, certificate, tenant credentials, licensing, or network access is needed, request it only at the phase that depends on it.

## 8. Decisions and unresolved inputs

1. **Write location:** continue in `Family_RMM`. Existing sibling project folders are read-only under the current permissions; no changes have been made to them.
2. **Production signing:** acquire Authenticode signing for the publisher identity and separately protect update signing. Private keys remain off the app server and source repository. SmartScreen reputation may take time to build.
3. **Enrollment policy defaults:** choose safe defaults (limited expiry/quota and approval mode) before exposing package generation. The installing user still never enters a code.
4. **ScreenConnect:** adapter design and implementation are in scope before credentials exist. Live verification later requires the instance URL, edition, supported API/auth method, and a least-privilege integration account. Never put credentials in this document.
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
- [ ] Implement Go Windows service agent, signed MSI packaging/download/version catalog and clean Windows 10/11 install/upgrade/repair/uninstall acceptance.
- [ ] Implement ScreenConnect integration from the official API/extension docs available to the user's licensed account; keep live integration verification separate.
