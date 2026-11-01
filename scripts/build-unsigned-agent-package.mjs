import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configPath = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node scripts/build-unsigned-agent-package.mjs <installer-config.json>");

const config = JSON.parse(await readFile(configPath, "utf8"));
const grantId = config.enrollmentGrant?.manifest?.grantId;
if (!/^https:\/\//i.test(config.serverUrl || "") || !/^[a-f0-9]{32}$/.test(grantId || "") ||
    config.enrollmentGrant?.manifest?.serverUrl !== config.serverUrl || !config.enrollmentGrant?.signature || !config.taskSigningPublicKey) {
  throw new Error("The config must contain a valid HTTPS server and signed enrollment authorization downloaded from Family RMM.");
}

const outputPath = path.join(root, ".artifacts", "unsigned-pilot", grantId);
await mkdir(outputPath, { recursive: true });
const result = spawnSync(process.execPath, [path.join(root, "scripts", "build-agent-package.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    RMM_ENV: "production",
    RMM_ALLOW_UNSIGNED_INSTALLERS: "1",
    RMM_SIGNTOOL_PATH: "",
    RMM_SIGN_CERT_THUMBPRINT: "",
    RMM_PACKAGE_CONFIG_PATH: configPath,
    RMM_PACKAGE_DIR: outputPath,
    RMM_PACKAGE_VERSION: String(config.agentVersion || "0.2.4"),
  },
  stdio: "inherit",
  windowsHide: true,
  timeout: 10 * 60_000,
});
if (result.error || result.status !== 0) {
  throw new Error(`Unsigned pilot package build failed: ${result.error?.message || `exit ${result.status}`}`);
}

process.stdout.write(`\nUnsigned pilot MSI: ${path.join(outputPath, `FamilyRmmAgent-${config.agentVersion || "0.2.4"}.msi`)}\n`);
process.stdout.write("Send this MSI only to the customer authorized by the included enrollment grant. Windows may show an unknown-publisher warning.\n");
