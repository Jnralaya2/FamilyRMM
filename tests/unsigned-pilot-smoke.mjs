import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const root = process.cwd();
const runId = `${Date.now().toString(36)}-${process.pid}`;
const tempPath = path.join(root, ".artifacts", `unsigned-pilot-smoke-${runId}`);
const databasePath = path.join(tempPath, "rmm.sqlite");
const configPath = path.join(tempPath, "installer-config.json");
let server;
let packagePath;
let serverOutput = "";

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

await mkdir(tempPath, { recursive: true });
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const setupToken = `unsigned-smoke-${runId}`;
server = spawn(process.execPath, ["src/server/index.mjs"], {
  cwd: root,
  env: { ...process.env, RMM_ENV: "development", RMM_HOST: "127.0.0.1", RMM_PORT: String(port), RMM_SERVER_URL: "https://localhost", RMM_DB_PATH: databasePath, RMM_SETUP_TOKEN: setupToken },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

function cookieOf(response) {
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error("The API did not return a session cookie.");
  return cookie;
}

async function containsFile(directory, filename) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) return true;
    if (entry.isDirectory() && await containsFile(entryPath, filename)) return true;
  }
  return false;
}

async function api(route, { method = "GET", body, cookie, csrf, token } = {}) {
  const headers = { Origin: baseUrl };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (token) headers["x-setup-token"] = token;
  const response = await fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status}): ${payload.error || "unknown API error"}`);
  return { response, payload };
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) { ready = true; break; }
    } catch { /* Wait until the temporary API is listening. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Temporary API did not start. ${serverOutput.trim()}`);

  const ownerSetup = await api("/api/auth/setup", { method: "POST", token: setupToken, body: { email: `owner-${runId}@example.test`, password: "unsigned-pilot-smoke-owner-password" } });
  const ownerCookie = cookieOf(ownerSetup.response);
  const license = await api("/api/licenses", { method: "POST", cookie: ownerCookie, csrf: ownerSetup.payload.csrfToken, body: { label: "Unsigned pilot smoke", deviceLimit: "unlimited", sessionLimit: 3 } });
  const customer = await api("/api/auth/register", { method: "POST", body: { email: `customer-${runId}@example.test`, workspace: "Smoke Test Workspace", password: "unsigned-pilot-smoke-customer-password", licenseKey: license.payload.key } });
  const customerCookie = cookieOf(customer.response);
  const customerStatus = await api("/api/auth/status", { cookie: customerCookie });
  const policy = await api("/api/enrollment/policies", { method: "POST", cookie: customerCookie, csrf: customer.payload.csrfToken, body: { name: "Windows smoke test", maxDevices: 2, expiresInHours: 1, approvalMode: "automatic", allowedOperatingSystems: ["Windows"] } });
  const grant = await api(`/api/enrollment/policies/${policy.payload.id}/grants`, { method: "POST", cookie: customerCookie, csrf: customer.payload.csrfToken, body: { maxUses: 1 } });
  const config = await api(`/api/enrollment/grants/${grant.payload.id}/installer-config`, { cookie: customerCookie });
  if (config.payload.serverUrl !== "https://localhost" || config.payload.enrollmentGrant.manifest.organizationId !== customerStatus.payload.administrator.organizationId) {
    throw new Error("The installer config is not bound to the customer's workspace and configured server URL.");
  }
  await writeFile(configPath, JSON.stringify(config.payload, null, 2));
  const grantId = config.payload.enrollmentGrant.manifest.grantId;
  if (!/^[a-f0-9]{32}$/.test(grantId)) throw new Error("The grant ID is invalid.");
  packagePath = path.join(root, ".artifacts", "unsigned-pilot", grantId);
  console.log("Owner setup → unlimited license → customer workspace → enrollment policy/grant → tenant-bound installer config: PASS");

  const build = spawnSync(process.execPath, ["scripts/build-unsigned-agent-package.mjs", configPath], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    timeout: 10 * 60_000,
  });
  if (build.error || build.status !== 0) throw new Error(`Unsigned installer build failed: ${build.error?.message || `exit ${build.status}`}`);

  const info = JSON.parse(await readFile(path.join(packagePath, "build-info.json"), "utf8"));
  if (info.signingStatus !== "unsigned") throw new Error(`Expected an unsigned pilot build, got ${info.signingStatus}.`);
  for (const artifact of [info.installer, info.setup]) {
    const artifactPath = path.join(packagePath, artifact.file);
    await stat(artifactPath);
    const actualHash = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
    if (actualHash !== artifact.sha256) throw new Error(`SHA-256 mismatch for ${artifact.file}.`);
  }
  console.log(`Unsigned MSI + setup EXE + SHA-256 metadata: PASS (${info.installer.file}, ${info.setup.file})`);
  const adminImage = path.join(tempPath, "msi-admin-image");
  const extraction = spawnSync("msiexec.exe", ["/a", path.join(packagePath, info.installer.file), "/qn", `TARGETDIR=${adminImage}`], {
    cwd: root,
    windowsHide: true,
    timeout: 120_000,
    encoding: "utf8",
  });
  if (extraction.error || extraction.status !== 0) throw new Error(`Windows Installer could not extract the MSI (${extraction.error?.message || `exit ${extraction.status}`}).`);
  if (!await containsFile(adminImage, "FamilyRmm.Agent.exe")) throw new Error("MSI administrative extraction did not contain the Windows agent executable.");
  console.log("Windows Installer MSI database and embedded files: PASS (administrative extraction; no service installed)");
  console.log("This smoke test does not run an interactive Windows installation or service lifecycle check.");
} finally {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await exited;
  }
  await rm(tempPath, { recursive: true, force: true });
  if (packagePath) await rm(packagePath, { recursive: true, force: true });
}
