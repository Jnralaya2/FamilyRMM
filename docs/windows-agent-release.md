# Windows agent packaging and release

## What the dashboard builds

The Enrollment page issues a signed, policy-limited authorization and builds two actual artifacts:

- `FamilyRmmAgent-<version>.msi`: per-machine Windows Installer package that installs the `Family RMM Agent` automatic service.
- `FamilyRmmAgentSetup-<version>.exe`: graphical bootstrapper that extracts the MSI to a temporary directory and opens the normal Windows MSI wizard. It requests elevation through the standard Windows UAC mechanism when needed.

Both downloads are administrator-authenticated, integrity-checked against the stored SHA-256 hash, and denied after the associated enrollment grant expires, reaches quota, or is revoked. The enrollment recipient does not enter a code. The package contains a signed, non-secret authorization manifest; each agent creates its own key pair on first run, protects the private key using machine-scope Windows DPAPI, and proves possession during registration.

The service reports its version and computer inventory to the configured server. The test suite builds and downloads both artifacts, checks the installer file signatures, validates the signed manifest with the published server key, then runs the actual .NET agent's self-check and test enrollment/check-in against the test API.

## Server address and distribution

Set `RMM_SERVER_URL` to the reachable RMM HTTPS origin before starting the server and generating packages. In local development it defaults to `http://127.0.0.1:3001`; an installer built with this URL cannot connect to another computer's loopback. Production startup rejects loopback or non-HTTPS URLs.

## Authenticode

Development builds are intentionally unsigned and explicitly labeled as such in the dashboard. Production package creation fails closed without signing configuration. The build pipeline signs the agent executable, MSI, and graphical setup EXE with SHA-256 and an RFC 3161 timestamp, then verifies the signatures. Configure `RMM_SIGNTOOL_PATH`, `RMM_SIGN_CERT_THUMBPRINT`, and optionally `RMM_TIMESTAMP_URL` on an isolated release/signing worker. Keep the certificate private key in a hardware-backed key store or managed signing service; do not put it in this repository or on the public RMM web server. The current local SignTool adapter is a release-worker integration point, not a claim that a signing service or certificate is configured here.

A signing certificate proves publisher identity and protects artifact integrity; it does not guarantee immediate SmartScreen reputation. EV certificates can provide publisher validation but SmartScreen may still apply reputation-based checks. Use a trusted public code-signing certificate, consistent publisher metadata, timestamp signatures, and a gradual controlled rollout. Verify SmartScreen and Windows 10/11 GUI behavior on clean test machines before public distribution.

## Acceptance still required

The current environment has not installed the MSI in a clean Windows 10/11 VM. Release acceptance must exercise GUI install and UAC, service startup after reboot, server registration and inventory, MSI upgrade, repair, uninstall, reinstall, and expired/revoked grants. Development self-check and API tests are not substitutes for those Windows Installer lifecycle checks. ScreenConnect association/session deployment is a separate integration gate documented in the roadmap.
