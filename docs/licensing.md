# One-time customer licenses

Family RMM currently supports a manual one-time license workflow. Collect payment outside the app, then issue a license key from the platform-owner account.

## Issue and redeem a key

1. Sign in with the platform-owner account and open **Customer licenses**. Set a public email, phone, or HTTPS purchase contact; visitors see that link before account creation.
2. After payment is confirmed manually, create a labeled license. Device enrollment and administrator sessions are unlimited; license records do not impose device or session caps.
3. Copy the generated key immediately. The server stores only its SHA-256 hash, so the full key cannot be recovered after leaving the page.
4. Send the key to the customer after payment is confirmed.
5. The customer chooses **Bought a license? Create your workspace**, enters the key, workspace name, email, and password. Each key activates one workspace once.
6. For an unsigned Windows pilot, the customer creates an enrollment authorization in their workspace, downloads its build config, and sends it to the platform owner. The owner builds the MSI locally and sends the file directly to that customer. See [the unsigned pilot workflow](unsigned-pilot.md).

Licenses have no expiry date. Revocation is not a payment refund workflow; handle refunds separately. Current agent authorization is controlled by enrollment approval and device revocation.

## Enforcement

- Accounts, devices, enrollment grants, installers, deployments, and audit records are scoped to a workspace.
- Customer workspaces receive monitoring and enrollment. Software deployment remains available only to the platform-owner workspace.
- Device enrollment requires an administrator to approve the pending device (or a valid signed enrollment grant). The reusable generic installer itself grants no management permission.
- Device requests use a per-device key proof; administrators can revoke an enrolled device.
- Legacy license cap fields remain for database compatibility and are not enforced.
- A revoked device no longer consumes a device slot. Revoking the workspace license locks the entire workspace.
- Existing single-owner data is migrated to the original platform workspace. Previously issued enrollment grants remain valid for that workspace.

## Current sales boundary

Licensed customer workspace owners can enroll computers, inspect their software inventory, upload MSI/EXE installers, author PowerShell scripts, queue bulk installs/updates and schedule one-time deployments. Deployment packages and jobs are restricted to the customer workspace; agents must be enrolled and use Family RMM Agent 0.2.0 or newer. EXE packages need vendor-documented silent arguments. Script and installer jobs run as LocalSystem, so customers should only deploy software and scripts they trust. Updates require the target application to appear in the device's latest reported inventory. Scheduled jobs run once at the chosen time when the agent checks in; recurring schedules are not implemented.

Checkout, payment-provider integrations, invoices, tax handling, automated receipts, password recovery, license transfer, automatic update discovery, recurring deployment schedules, and ScreenConnect integration are not implemented. The platform owner manually records payment and sends each one-time key. Customer account email addresses must be unique across the service.

Before advertising public signups, review account recovery, privacy/retention terms, abuse response, backups, dependency/security posture, and production capacity. The current single-VPS SQLite deployment is a single-server baseline.
