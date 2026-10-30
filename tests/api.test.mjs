import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { rm } from "node:fs/promises";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";

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

  const adminHeaders = { ...origin, Cookie: cookie, "Content-Type": "application/json", "x-csrf-token": createdBody.csrfToken };
  const policyResponse = await fetch(`${baseUrl}/api/enrollment/policies`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "Windows fleet", maxDevices: 2, expiresInHours: 24, approvalMode: "automatic", allowedOperatingSystems: ["Windows"] }) });
  assert.equal(policyResponse.status, 201);
  const policy = await policyResponse.json();
  const grantResponse = await fetch(`${baseUrl}/api/enrollment/policies/${policy.id}/grants`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ maxUses: 2, expiresInHours: 24 }) });
  assert.equal(grantResponse.status, 201);
  const grant = (await grantResponse.json()).enrollmentGrant;
  const overallocatedGrant = await fetch(`${baseUrl}/api/enrollment/policies/${policy.id}/grants`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ maxUses: 1 }) });
  assert.equal(overallocatedGrant.status, 400, "policy-wide device limit prevents over-allocation across grants");
  const agentKeys = generateKeyPairSync("ed25519");
  const agentPublicKey = agentKeys.publicKey.export({ type: "spki", format: "pem" });
  const deviceId = "0123456789abcdef0123456789abcdef";
  const clientNonce = "ABCDEFGHIJKLMNOPQRSTUVWX0123456789";
  const timestamp = Date.now();
  const proof = sign(null, Buffer.from(`${grant.manifest.grantId}\n${deviceId}\n${timestamp}\n${clientNonce}`), agentKeys.privateKey).toString("base64url");
  const enrollment = await fetch(`${baseUrl}/api/agent/enroll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enrollmentGrant: grant, deviceId, name: "test-workstation", operatingSystem: "Windows 11", osVersion: "24H2", architecture: "amd64", agentVersion: "0.1.0", devicePublicKey: agentPublicKey, clientNonce, timestamp, proofSignature: proof }) });
  assert.equal(enrollment.status, 201);
  assert.equal((await enrollment.json()).status, "approved");

  const heartbeatBody = JSON.stringify({ name: "test-workstation", operatingSystem: "Windows 11", manufacturer: "Test vendor", model: "Test model", cpuCores: 8, totalMemoryMB: 16384, ipAddresses: ["192.0.2.5"], agentVersion: "0.1.0", metrics: { cpuPercent: 13, memoryPercent: 42 } });
  const agentHeaders = (nonce) => {
    const time = String(Date.now());
    const signature = sign(null, Buffer.concat([Buffer.from(`${time}\n${nonce}\n`), Buffer.from(heartbeatBody)]), agentKeys.privateKey).toString("base64url");
    return { "Content-Type": "application/json", "x-device-id": deviceId, "x-device-timestamp": time, "x-device-nonce": nonce, "x-device-signature": signature };
  };
  const nonce = "heartbeat-nonce-0000000001";
  assert.equal((await fetch(`${baseUrl}/api/agent/heartbeat`, { method: "POST", headers: agentHeaders(nonce), body: heartbeatBody })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/agent/heartbeat`, { method: "POST", headers: agentHeaders(nonce), body: heartbeatBody })).status, 409, "signed requests cannot be replayed");
  const afterCheckIn = await fetch(`${baseUrl}/api/devices/${deviceId}`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(afterCheckIn.device.manufacturer, "Test vendor");
  assert.equal(afterCheckIn.device.totalMemoryMB, 16384);
  const softwareBody = JSON.stringify({ software: [{ name: "Inventory test app", version: "2.4.1", publisher: "Example Publisher" }] });
  const inventoryNonce = "software-inventory-nonce-0001";
  const inventoryTime = String(Date.now());
  const inventorySignature = sign(null, Buffer.concat([Buffer.from(`${inventoryTime}\n${inventoryNonce}\n`), Buffer.from(softwareBody)]), agentKeys.privateKey).toString("base64url");
  const softwareResponse = await fetch(`${baseUrl}/api/agent/inventory`, { method: "POST", headers: { "Content-Type": "application/json", "x-device-id": deviceId, "x-device-timestamp": inventoryTime, "x-device-nonce": inventoryNonce, "x-device-signature": inventorySignature }, body: softwareBody });
  assert.equal(softwareResponse.status, 200);
  const withSoftware = await fetch(`${baseUrl}/api/devices/${deviceId}`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(withSoftware.software[0].name, "Inventory test app");
  assert.equal(withSoftware.software[0].publisher, "Example Publisher");

  const secondKeys = generateKeyPairSync("ed25519");
  const secondId = "1123456789abcdef0123456789abcdef";
  const secondNonce = "ABCDEFGHIJKLMNOPQRSTUVWX01234567";
  const secondTimestamp = Date.now();
  const secondProof = sign(null, Buffer.from(`${grant.manifest.grantId}\n${secondId}\n${secondTimestamp}\n${secondNonce}`), secondKeys.privateKey).toString("base64url");
  const secondEnrollment = await fetch(`${baseUrl}/api/agent/enroll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enrollmentGrant: grant, deviceId: secondId, name: "test-workstation-2", operatingSystem: "Windows 10", devicePublicKey: secondKeys.publicKey.export({ type: "spki", format: "pem" }), clientNonce: secondNonce, timestamp: secondTimestamp, proofSignature: secondProof }) });
  assert.equal(secondEnrollment.status, 201);
  const overflowId = "2123456789abcdef0123456789abcdef";
  const overflowNonce = "ABCDEFGHIJKLMNOPQRSTUVWX01234568";
  const overflowTimestamp = Date.now();
  const overflowProof = sign(null, Buffer.from(`${grant.manifest.grantId}\n${overflowId}\n${overflowTimestamp}\n${overflowNonce}`), secondKeys.privateKey).toString("base64url");
  const overflow = await fetch(`${baseUrl}/api/agent/enroll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enrollmentGrant: grant, deviceId: overflowId, name: "overflow", operatingSystem: "Windows 11", devicePublicKey: secondKeys.publicKey.export({ type: "spki", format: "pem" }), clientNonce: overflowNonce, timestamp: overflowTimestamp, proofSignature: overflowProof }) });
  assert.equal(overflow.status, 409, "grant quota is enforced for multiple recipients");
  const pendingPolicyResponse = await fetch(`${baseUrl}/api/enrollment/policies`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "Review required", maxDevices: 5, expiresInHours: 24, approvalMode: "approval", allowedOperatingSystems: ["Windows"] }) });
  const pendingPolicy = await pendingPolicyResponse.json();
  const pendingGrantResponse = await fetch(`${baseUrl}/api/enrollment/policies/${pendingPolicy.id}/grants`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ maxUses: 2 }) });
  const pendingGrant = (await pendingGrantResponse.json()).enrollmentGrant;
  const pendingId = "3123456789abcdef0123456789abcdef";
  const pendingNonce = "ABCDEFGHIJKLMNOPQRSTUVWX01234569";
  const pendingTimestamp = Date.now();
  const pendingProof = sign(null, Buffer.from(`${pendingGrant.manifest.grantId}\n${pendingId}\n${pendingTimestamp}\n${pendingNonce}`), agentKeys.privateKey).toString("base64url");
  const pendingEnroll = await fetch(`${baseUrl}/api/agent/enroll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enrollmentGrant: pendingGrant, deviceId: pendingId, name: "approval-pending", operatingSystem: "Windows 11", devicePublicKey: agentPublicKey, clientNonce: pendingNonce, timestamp: pendingTimestamp, proofSignature: pendingProof }) });
  assert.equal(pendingEnroll.status, 202);
  const pendingList = await fetch(`${baseUrl}/api/enrollment/pending`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(pendingList.items.some((item) => item.id === pendingId), true);
  const approve = await fetch(`${baseUrl}/api/enrollment/pending/${pendingId}/approve`, { method: "POST", headers: adminHeaders });
  assert.equal(approve.status, 200);
  const revoke = await fetch(`${baseUrl}/api/devices/${deviceId}/revoke`, { method: "POST", headers: adminHeaders });
  assert.equal(revoke.status, 200);
  const revokedHeartbeat = await fetch(`${baseUrl}/api/agent/heartbeat`, { method: "POST", headers: agentHeaders("heartbeat-after-revoke-0001"), body: heartbeatBody });
  assert.equal(revokedHeartbeat.status, 403);

  const noCsrf = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { ...origin, Cookie: cookie } });
  assert.equal(noCsrf.status, 403);
  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { ...origin, Cookie: cookie, "x-csrf-token": createdBody.csrfToken } });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/overview`, { headers: { Cookie: cookie } })).status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { ...origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.test", password: "correct-horse-battery-staple" }) });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).administrator.email, "owner@example.test");
});
