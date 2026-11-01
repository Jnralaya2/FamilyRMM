# Windows agent packaging and release

## Dashboard downloads

The **Downloads** page builds a reusable Windows MSI and graphical EXE from the checked-in .NET Windows service agent. In production, the Family RMM server queues and runs the build with its .NET SDK and GNOME msitools compiler; it does not require a paired Windows PC or a separate worker command. Local Windows builds use WiX when available. The page starts the first generic package build automatically and shows downloads when both artifacts are ready. Package links are stable and package scoped. On the configured HTTPS origin, the package endpoint verifies the stored artifact hash before sending it. Downloading a package does not authorize a computer.

The generic package contains the server URL, agent version, and public task-signing key only. It contains no administrator credential, permanent enrollment grant, or private signing key. On first service start, the agent creates a device key protected with machine-scope Windows DPAPI, submits a proof-of-possession enrollment request, and reports its Windows hardware/OS and installed software inventory only after approval. New requests appear under **Enrollment** for an administrator to approve or reject. Approval makes the device manageable; rejection or device revocation prevents authenticated check-ins. The service starts automatically and continues retrying enrollment while approval is pending.

The dashboard also retains policy-grant packages for workflows that need signed, time-limited authorization. Legacy grants do not impose device or package download caps. They may expire or be revoked for enrollment, independently of stable package download links.

## Server address and HTTPS

Set `RMM_SERVER_URL` to the public HTTPS origin before starting the server and building packages. Production startup rejects loopback and non-HTTPS URLs. The MSI is not a universal binary: it is configured for the FamilyRMM server that built it. Verify DNS, TLS, and the public enrollment key on the target deployment before distributing a release.

## Authenticode

Current production pilot builds are unsigned and labeled as such in the dashboard. Windows may show an unknown-publisher warning. Configure `RMM_SIGNTOOL_PATH`, `RMM_SIGN_CERT_THUMBPRINT`, and optionally `RMM_TIMESTAMP_URL` on an isolated release/signing worker before public distribution. Keep the certificate private key in a hardware-backed key store or managed signing service; do not put it in this repository or on the public web server. No production certificate or signing service is configured here.

An Authenticode signature identifies the publisher and protects artifact integrity; SmartScreen reputation may still be limited for a new release. Verify signatures and Windows 10/11 GUI behavior on clean test machines before public distribution.

## Acceptance and release gates

The API integration tests build real MSI and EXE artifacts, download them and check their file signatures. They exercise both the agent against an isolated test API and the production-mode server-side build queue without a separate worker. They do not install MSI in a clean Windows VM. The live API reports healthy, but the live frontend was observed serving an older bundle; a new cache-disabled deployment is required and must pass the asset fingerprint check before live dashboard visibility is claimed.

Before calling a Windows release complete, install the generated MSI on a clean Windows 10/11 VM with UAC, verify automatic service startup after reboot, enrollment approval, inventory, MSI upgrade/repair, uninstall and cleanup. ScreenConnect association and session deployment have not been implemented or tested; see the architecture roadmap. Do not claim a live ScreenConnect session based only on an installer artifact.
