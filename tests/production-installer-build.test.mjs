import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dbPath = path.join(root, "data", `production-installer-test-${process.pid}.sqlite`);
const artifactsPath = path.join(root, ".artifacts", `production-installer-test-${process.pid}`);
const setupToken = "production-installer-test-setup-token";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("production dashboard builds and serves the real MSI/EXE without a separate Windows worker", async (t) => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const signingKey = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const child = spawn(process.execPath, ["src/server/index.mjs"], {
    cwd: root,
    env: { ...process.env, RMM_ENV: "production", RMM_HOST: "127.0.0.1", RMM_PORT: String(port),
      RMM_SERVER_URL: "https://rmm.example.test", RMM_DB_PATH: dbPath, RMM_ARTIFACTS_DIR: artifactsPath,
      RMM_SETUP_TOKEN: setupToken, RMM_ENROLLMENT_PRIVATE_KEY: signingKey.privateKey },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    for (const suffix of ["", "-shm", "-wal"]) await rm(dbPath + suffix, { force: true });
    await rm(artifactsPath, { recursive: true, force: true });
  });

  let started = false;
  let lastReadinessError = "No health response was received.";
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) { started = true; break; }
      lastReadinessError = `Health endpoint returned HTTP ${response.status}.`;
    } catch (error) {
      lastReadinessError = String(error?.cause?.code || error?.code || error?.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(started, `production API did not become healthy: ${output}\nLast health probe: ${lastReadinessError}`);

  const origin = { Origin: baseUrl };
  const owner = await fetch(`${baseUrl}/api/auth/setup`, {
    method: "POST", headers: { ...origin, "Content-Type": "application/json", "x-setup-token": setupToken },
    body: JSON.stringify({ email: "installer-owner@example.test", password: "installer-production-test-password" }),
  });
  assert.equal(owner.status, 201, await owner.clone().text());
  const auth = await owner.json();
  const cookie = owner.headers.getSetCookie()[0].split(";")[0];
  const adminHeaders = { ...origin, Cookie: cookie, "Content-Type": "application/json", "x-csrf-token": auth.csrfToken };

  const buildResponse = await fetch(`${baseUrl}/api/installer-packages`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ generic: true }),
  });
  assert.equal(buildResponse.status, 202, await buildResponse.clone().text());
  const queued = await buildResponse.json();
  assert.equal(queued.status, "building");

  let ready;
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const result = await fetch(`${baseUrl}/api/installer-packages`, { headers: { Cookie: cookie } }).then((r) => r.json());
    ready = result.items.find((item) => item.id === queued.id);
    if (ready?.status === "ready" || ready?.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.equal(ready?.status, "ready", `production installer build did not complete: ${ready?.buildError || output}`);

  const config = JSON.parse(await readFile(path.join(artifactsPath, "packages", queued.id, "package-config.json"), "utf8"));
  assert.equal(config.serverUrl, "https://rmm.example.test");
  assert.ok(config.taskSigningPublicKey);
  assert.equal(typeof config.enrollmentGrant?.manifest?.grantId, "string", "generic production installers carry a signed, workspace-scoped enrollment authorization");
  const msiResponse = await fetch(`${baseUrl}/api/installer-packages/${queued.id}/msi`, { headers: { Cookie: cookie } });
  assert.equal(msiResponse.status, 200);
  const msi = new Uint8Array(await msiResponse.arrayBuffer());
  assert.ok(msi.length > 10_000_000);
  assert.deepEqual([...msi.slice(0, 4)], [0xd0, 0xcf, 0x11, 0xe0]);
  const exeResponse = await fetch(`${baseUrl}/api/installer-packages/${queued.id}/exe`, { headers: { Cookie: cookie } });
  assert.equal(exeResponse.status, 200);
  const exe = new Uint8Array(await exeResponse.arrayBuffer());
  assert.ok(exe.length > msi.length);
  assert.deepEqual([...exe.slice(0, 2)], [0x4d, 0x5a]);
});
