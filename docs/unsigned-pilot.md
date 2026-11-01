# Unsigned Windows pilot

This workflow builds an unsigned MSI on the platform owner's Windows PC. Use it only for a small pilot with customers who expect the installer and explicitly agree to install it. Windows can show an unknown-publisher/SmartScreen warning. Do not ask customers to disable SmartScreen or bypass a security block. Public distribution still requires Authenticode signing and clean-machine installation acceptance.

## Per-customer flow

1. Confirm payment and issue the customer a one-time Family RMM license key.
2. The customer redeems that key to create their own workspace.
3. In the customer's workspace, create an enrollment policy and issue an authorization. The customer downloads its build config from **Enrollment** and sends it to the platform owner through a trusted channel. The config contains a signed, limited, revocable enrollment grant; treat it like a bearer authorization.
4. On the Windows PC with this repository, Node.js, the .NET 10 SDK, and WiX on `PATH`, build from the repository root:

   ```powershell
   node scripts/build-unsigned-agent-package.mjs "C:\path\to\family-rmm-<grant-id>-installer-config.json"
   ```

5. The MSI is written to `.artifacts/unsigned-pilot/<grant-id>/FamilyRmmAgent-0.2.0.msi`. Send that MSI directly to the customer; do not post a public download link because anyone with the file can consume the grant's remaining device slots.
6. The customer installs the MSI on each authorized Windows PC. After successful installation, the agent connects to the HTTPS server in the grant and reports device status and inventory to that customer's workspace. The platform owner can see grant usage but cannot see the customer's device inventory across tenant boundaries.
7. Revoke the enrollment authorization in the customer's workspace if the config or installer is exposed. License revocation disables the customer's workspace and its agents.

This local-build pilot does not create a server-hosted MSI download or package catalog entry. The customer receives the MSI file from the owner. The agent monitors enrolled device health and inventory; it does not provide interactive remote control or Windows/RDP user-session viewing.

## Owner-PC build smoke check

Before preparing a real customer's installer, run `npm run test:unsigned-pilot` from the repository root on the owner's Windows PC. It creates a temporary API/database, issues a test license and workspace grant, builds both unsigned artifacts using the configured .NET SDK and WiX, checks their recorded SHA-256 hashes, asks Windows Installer to administratively extract the MSI's embedded files, and removes the temporary test data and artifacts. This verifies package generation and MSI readability; it does not install the service, exercise the EXE wizard, verify SmartScreen behavior, or confirm a production VPS is reachable.
