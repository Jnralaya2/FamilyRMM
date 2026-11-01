import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configPath = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node scripts/installer-build-worker.mjs <worker-config.json>");
const workerConfig = JSON.parse(await readFile(configPath, "utf8"));
const serverUrl = String(workerConfig.serverUrl || "").replace(/\/$/, "");
const workerToken = String(workerConfig.workerToken || "");
if (!/^https:\/\//i.test(serverUrl) || workerToken.length < 40) throw new Error("Worker config must contain the Family RMM HTTPS URL and a valid pairing token.");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function api(route, init = {}) {
  return fetch(`${serverUrl}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${workerToken}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(init.timeout || 30_000),
  });
}

console.log(`Family RMM unsigned installer worker connected to ${serverUrl}. Keep this window open while customers build installers.`);
for (;;) {
  let response;
  try { response = await api("/api/installer-build-worker/claim", { method: "POST" }); }
  catch (error) { console.error(`Worker connection error: ${error.message}`); await sleep(8_000); continue; }
  if (response.status === 204) { await sleep(4_000); continue; }
  if (!response.ok) { console.error(`Build queue returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`); await sleep(8_000); continue; }

  const { job } = await response.json();
  const jobDirectory = path.join(root, ".artifacts", "worker-build", job.id);
  await mkdir(jobDirectory, { recursive: true });
  const packageConfigPath = path.join(jobDirectory, "package-config.json");
  try {
    await writeFile(packageConfigPath, JSON.stringify(job.packageConfig, null, 2), { flag: "w" });
    console.log(`Building unsigned MSI and EXE for enrollment authorization ${job.grantId}.`);
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "build-agent-package.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        RMM_ENV: "production",
        RMM_ALLOW_UNSIGNED_INSTALLERS: "1",
        RMM_SIGNTOOL_PATH: "",
        RMM_SIGN_CERT_THUMBPRINT: "",
        RMM_PACKAGE_CONFIG_PATH: packageConfigPath,
        RMM_PACKAGE_DIR: jobDirectory,
        RMM_PACKAGE_VERSION: String(job.packageConfig.agentVersion || "0.2.4"),
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 20 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error((result.stderr || result.stdout || result.error?.message || `Builder exited ${result.status}`).trim().slice(-1_400));

    const buildInfo = JSON.parse(await readFile(path.join(jobDirectory, "build-info.json"), "utf8"));
    if (buildInfo.signingStatus !== "unsigned") throw new Error("This worker is configured for unsigned pilot packages only.");
    const installerFiles = [
      ["msi", buildInfo.installer.file],
      ["exe", buildInfo.setup.file],
    ];
    for (const [format, fileName] of installerFiles) {
      const bytes = await readFile(path.join(jobDirectory, fileName));
      const uploaded = await api(`/api/installer-build-worker/jobs/${job.id}/${format}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
        timeout: 5 * 60_000,
      });
      if (!uploaded.ok) throw new Error(`Uploading ${format.toUpperCase()} failed (HTTP ${uploaded.status}): ${(await uploaded.text()).slice(0, 500)}`);
    }
    console.log(`Unsigned MSI and EXE are ready for authorization ${job.grantId}.`);
  } catch (error) {
    console.error(`Build ${job.id} failed: ${error.message}`);
    try {
      await api(`/api/installer-build-worker/jobs/${job.id}/failed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: error.message.slice(0, 1_400) }),
      });
    } catch (reportError) { console.error(`Could not report build failure: ${reportError.message}`); }
  } finally {
    await rm(jobDirectory, { recursive: true, force: true });
  }
}
