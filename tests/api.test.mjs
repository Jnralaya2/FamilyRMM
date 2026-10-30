import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dbPath = path.join(root, "data", `api-test-${process.pid}.sqlite`);
let child;
let baseUrl;
const bootstrap = "test-bootstrap-token-not-for-production";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("authenticated dashboard API owner setup, reads, CSRF, logout and login", async (t) => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/server/index.mjs"], {
    cwd: root,
    env: { ...process.env, RMM_ENV: "development", RMM_HOST: "127.0.0.1", RMM_PORT: String(port), RMM_DB_PATH: dbPath, RMM_SETUP_TOKEN: bootstrap },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    for (const suffix of ["", "-shm", "-wal"]) await rm(dbPath + suffix, { force: true });
  });

  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) { ready = true; break; } } catch { /* Wait for the API listener. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, `API did not start: ${output}`);

  const status = await fetch(`${baseUrl}/api/auth/status`).then((r) => r.json());
  assert.equal(status.setupRequired, true);
  assert.equal(status.authenticated, false);
  assert.equal((await fetch(`${baseUrl}/api/overview`)).status, 401);

  const origin = { Origin: baseUrl };
  const wrongOrigin = await fetch(`${baseUrl}/api/auth/setup`, { method: "POST", headers: { Origin: "http://attacker.invalid", "Content-Type": "application/json", "x-setup-token": bootstrap }, body: JSON.stringify({ email: "owner@example.test", password: "correct-horse-battery-staple" }) });
  assert.equal(wrongOrigin.status, 403);
  const rejected = await fetch(`${baseUrl}/api/auth/setup`, { method: "POST", headers: { ...origin, "Content-Type": "application/json", "x-setup-token": "wrong" }, body: JSON.stringify({ email: "owner@example.test", password: "correct-horse-battery" }) });
  assert.equal(rejected.status, 403);
  const weakPassword = await fetch(`${baseUrl}/api/auth/setup`, { method: "POST", headers: { ...origin, "Content-Type": "application/json", "x-setup-token": bootstrap }, body: JSON.stringify({ email: "owner@example.test", password: "too-short" }) });
  assert.equal(weakPassword.status, 400);
  const created = await fetch(`${baseUrl}/api/auth/setup`, { method: "POST", headers: { ...origin, "Content-Type": "application/json", "x-setup-token": bootstrap }, body: JSON.stringify({ email: "owner@example.test", password: "correct-horse-battery-staple" }) });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  const cookie = created.headers.getSetCookie()[0].split(";")[0];
  assert.match(created.headers.getSetCookie()[0], /HttpOnly/i);
  assert.match(created.headers.getSetCookie()[0], /SameSite=Strict/i);
  assert.equal(createdBody.administrator.role, "owner");
  assert.ok(createdBody.csrfToken);
  const setupReplay = await fetch(`${baseUrl}/api/auth/setup`, { method: "POST", headers: { ...origin, "Content-Type": "application/json", "x-setup-token": bootstrap }, body: JSON.stringify({ email: "other@example.test", password: "correct-horse-battery-staple" }) });
  assert.equal(setupReplay.status, 403);

  const overview = await fetch(`${baseUrl}/api/overview`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.deepEqual([overview.totalDevices, overview.onlineDevices, overview.offlineDevices], [0, 0, 0]);
  const devices = await fetch(`${baseUrl}/api/devices?q=workstation`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.deepEqual(devices.items, []);
  assert.equal(devices.total, 0);

  const noCsrf = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { ...origin, Cookie: cookie } });
  assert.equal(noCsrf.status, 403);
  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { ...origin, Cookie: cookie, "x-csrf-token": createdBody.csrfToken } });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/overview`, { headers: { Cookie: cookie } })).status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { ...origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.test", password: "correct-horse-battery-staple" }) });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).administrator.email, "owner@example.test");
});
