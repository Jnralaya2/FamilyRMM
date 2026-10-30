import { createServer } from "node:http";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, scrypt as scryptCallback, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scrypt = promisify(scryptCallback);
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const host = process.env.RMM_HOST || "127.0.0.1";
const port = Number(process.env.RMM_PORT || (process.env.RMM_DEV_API_ONLY ? 3001 : 3000));
const secureCookie = process.env.RMM_COOKIE_SECURE === "1" || process.env.RMM_ENV === "production";
const dataPath = path.resolve(root, process.env.RMM_DB_PATH || "data/rmm.sqlite");
await mkdir(path.dirname(dataPath), { recursive: true });

const db = new DatabaseSync(dataPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS administrators (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES administrators(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    operating_system TEXT,
    os_version TEXT,
    architecture TEXT,
    manufacturer TEXT,
    model TEXT,
    cpu TEXT,
    cpu_cores INTEGER,
    total_memory_mb INTEGER,
    ip_addresses TEXT,
    agent_version TEXT,
    last_seen TEXT,
    enrolled_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS devices_last_seen_idx ON devices(last_seen);
  CREATE TABLE IF NOT EXISTS metric_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    recorded_at TEXT NOT NULL,
    cpu_percent REAL,
    memory_percent REAL
  );
  CREATE INDEX IF NOT EXISTS metrics_time_idx ON metric_samples(recorded_at, device_id);
  CREATE TABLE IF NOT EXISTS software_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    version TEXT,
    publisher TEXT,
    installed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS software_device_idx ON software_inventory(device_id, name);
  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT,
    action TEXT NOT NULL,
    target_id TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS enrollment_policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    max_devices INTEGER NOT NULL,
    expires_in_hours INTEGER NOT NULL,
    approval_mode TEXT NOT NULL,
    allowed_os_json TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES administrators(id),
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS enrollment_grants (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES enrollment_policies(id),
    manifest_json TEXT NOT NULL,
    signature TEXT NOT NULL,
    max_uses INTEGER NOT NULL,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES administrators(id),
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS enrollment_claims (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    grant_id TEXT NOT NULL REFERENCES enrollment_grants(id),
    client_nonce TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reviewed_by TEXT,
    reviewed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS enrollment_claims_state_idx ON enrollment_claims(state, created_at);
  CREATE TABLE IF NOT EXISTS agent_request_nonces (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    nonce TEXT NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY(device_id, nonce)
  );
`);

// Forward-only SQLite migrations keep existing local development databases usable.
const deviceColumns = new Set(db.prepare("PRAGMA table_info(devices)").all().map((column) => column.name));
if (!deviceColumns.has("device_public_key")) db.exec("ALTER TABLE devices ADD COLUMN device_public_key TEXT");
if (!deviceColumns.has("enrollment_grant_id")) db.exec("ALTER TABLE devices ADD COLUMN enrollment_grant_id TEXT");
if (!deviceColumns.has("enrollment_state")) db.exec("ALTER TABLE devices ADD COLUMN enrollment_state TEXT NOT NULL DEFAULT 'approved'");

const serverUrl = (process.env.RMM_SERVER_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
if (process.env.RMM_ENV === "production") {
  let configuredUrl;
  try { configuredUrl = new URL(serverUrl); } catch { configuredUrl = null; }
  if (!configuredUrl || configuredUrl.protocol !== "https:" || configuredUrl.username || configuredUrl.password || ["localhost", "127.0.0.1", "::1"].includes(configuredUrl.hostname)) {
    console.error("RMM_SERVER_URL must be an HTTPS URL on a non-loopback host in production.");
    process.exit(1);
  }
}
let enrollmentPrivateKey;
let enrollmentPublicKey;
if (process.env.RMM_ENROLLMENT_PRIVATE_KEY) {
  enrollmentPrivateKey = process.env.RMM_ENROLLMENT_PRIVATE_KEY.replace(/\\n/g, "\n");
  enrollmentPublicKey = createPublicKey(enrollmentPrivateKey).export({ format: "pem", type: "spki" }).toString();
} else if (process.env.RMM_ENV === "production") {
  console.error("RMM_ENROLLMENT_PRIVATE_KEY must be supplied from protected secret storage in production.");
  process.exit(1);
} else {
  const signingPath = path.join(path.dirname(dataPath), "dev-enrollment-signing-key.pem");
  try {
    enrollmentPrivateKey = await readFile(signingPath, "utf8");
  } catch {
    const pair = generateKeyPairSync("ed25519", { privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    enrollmentPrivateKey = pair.privateKey;
    try { await writeFile(signingPath, enrollmentPrivateKey, { flag: "wx", mode: 0o600 }); }
    catch { enrollmentPrivateKey = await readFile(signingPath, "utf8"); }
  }
  enrollmentPublicKey = createPublicKey(enrollmentPrivateKey).export({ format: "pem", type: "spki" }).toString();
}
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const signManifest = (manifest) => cryptoSign(null, Buffer.from(canonicalJson(manifest)), enrollmentPrivateKey).toString("base64url");

const counts = db.prepare("SELECT COUNT(*) AS n FROM administrators").get();
let setupToken = null;
if (counts.n === 0) {
  setupToken = process.env.RMM_SETUP_TOKEN || (process.env.RMM_ENV === "production" ? null : randomBytes(24).toString("base64url"));
  if (!setupToken) {
    console.error("RMM_SETUP_TOKEN must be set for first-run production owner setup.");
    process.exit(1);
  }
  if (!process.env.RMM_SETUP_TOKEN) {
    console.log("\nFirst-run owner setup token (keep this local):");
    console.log(setupToken);
    console.log("Enter it in the setup screen. It is invalidated after the first administrator is created.\n");
  }
}

const insertAudit = db.prepare(`INSERT INTO audit_events(actor_id, action, target_id, detail, created_at)
  VALUES (?, ?, ?, ?, ?)`);
function audit(action, actorId = null, targetId = null, detail = null) {
  insertAudit.run(actorId, action, targetId, detail, new Date().toISOString());
}
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const parseCookies = (header = "") => Object.fromEntries(header.split(";").map((part) => {
  const i = part.indexOf("=");
  if (i < 0) return ["", ""];
  let value = part.slice(i + 1).trim();
  try { value = decodeURIComponent(value); } catch { value = ""; }
  return [part.slice(0, i).trim(), value];
}));
const cookieName = "family_rmm_session";
const sessionMaxAge = 8 * 60 * 60 * 1000;
const sessionInsert = db.prepare(`INSERT INTO sessions(token_hash, admin_id, csrf_token, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?)`);
const sessionSelect = db.prepare(`SELECT s.token_hash, s.csrf_token, s.expires_at, a.id, a.email, a.role
  FROM sessions s JOIN administrators a ON a.id=s.admin_id WHERE s.token_hash=?`);

function send(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", ...extraHeaders });
  res.end(body);
}
function setSessionCookie(res, token) {
  const pieces = [`${cookieName}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=28800"];
  if (secureCookie) pieces.push("Secure");
  res.setHeader("Set-Cookie", pieces.join("; "));
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? "; Secure" : ""}`);
}
function currentSession(req) {
  const token = parseCookies(req.headers.cookie)[cookieName];
  if (!token || token.length > 256) return null;
  const row = sessionSelect.get(hashToken(token));
  if (!row || row.expires_at < Date.now()) {
    if (row) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(row.token_hash);
    return null;
  }
  return row;
}
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function readRawBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function parseRawJson(raw) {
  try { return JSON.parse(raw.toString("utf8") || "{}"); } catch { return null; }
}
function authenticateAgentRequest(req, raw, res) {
  const deviceId = String(req.headers["x-device-id"] || "");
  const timestamp = String(req.headers["x-device-timestamp"] || "");
  const nonce = String(req.headers["x-device-nonce"] || "");
  const signature = String(req.headers["x-device-signature"] || "");
  if (!/^[A-Fa-f0-9-]{16,64}$/.test(deviceId) || !/^\d{10,16}$/.test(timestamp) || !/^[A-Za-z0-9_-]{20,120}$/.test(nonce) || signature.length > 256) {
    send(res, 401, { error: "Invalid agent authentication." }); return null;
  }
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > 60_000) { send(res, 401, { error: "Agent request expired." }); return null; }
  const device = db.prepare("SELECT id, device_public_key, revoked_at, enrollment_state FROM devices WHERE id=?").get(deviceId);
  if (!device || device.revoked_at || device.enrollment_state !== "approved" || !device.device_public_key) { send(res, 403, { error: "This device is not authorized." }); return null; }
  const message = Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), raw]);
  let valid = false;
  try { valid = cryptoVerify(null, message, device.device_public_key, Buffer.from(signature, "base64url")); } catch { valid = false; }
  if (!valid) { send(res, 401, { error: "Agent signature is invalid." }); return null; }
  try { db.prepare("INSERT INTO agent_request_nonces(device_id, nonce, used_at) VALUES(?,?,?)").run(deviceId, nonce, Date.now()); }
  catch { send(res, 409, { error: "Agent request nonce has already been used." }); return null; }
  db.prepare("DELETE FROM agent_request_nonces WHERE used_at < ?").run(Date.now() - 10 * 60_000);
  return device;
}
function requireAdmin(req, res) {
  const session = currentSession(req);
  if (!session) { send(res, 401, { error: "Sign in to continue." }); return null; }
  return session;
}
function csrfValid(req, session) {
  const value = req.headers["x-csrf-token"];
  return typeof value === "string" && value.length === session.csrf_token.length && timingSafeEqual(Buffer.from(value), Buffer.from(session.csrf_token));
}
function isOnline(lastSeen) {
  return Boolean(lastSeen && Date.now() - Date.parse(lastSeen) <= 120_000);
}
function deviceView(row) {
  let ips = [];
  try { ips = JSON.parse(row.ip_addresses || "[]"); } catch { /* Keep corrupt legacy data out of the response. */ }
  return {
    id: row.id,
    name: row.name,
    operatingSystem: row.operating_system,
    osVersion: row.os_version,
    architecture: row.architecture,
    manufacturer: row.manufacturer,
    model: row.model,
    cpu: row.cpu,
    cpuCores: row.cpu_cores,
    totalMemoryMB: row.total_memory_mb,
    ipAddresses: ips,
    agentVersion: row.agent_version,
    cpuUsagePercent: row.cpu_percent ?? null,
    memoryUsagePercent: row.memory_percent ?? null,
    lastSeen: row.last_seen,
    enrolledAt: row.enrolled_at,
    status: row.revoked_at ? "Revoked" : row.enrollment_state === "pending" ? "Pending approval" : row.enrollment_state === "rejected" ? "Rejected" : isOnline(row.last_seen) ? "Online" : "Offline",
  };
}

const loginAttempts = new Map();
function rateLimited(key) {
  const now = Date.now();
  const prior = loginAttempts.get(key);
  if (!prior || now - prior.start > 15 * 60_000) { loginAttempts.set(key, { start: now, count: 1 }); return false; }
  prior.count++;
  return prior.count > 10;
}

async function api(req, res, url) {
  const route = url.pathname;
  if (route === "/api/health" && req.method === "GET") {
    try { db.prepare("SELECT 1").get(); send(res, 200, { status: "ok", database: "connected", checkedAt: new Date().toISOString() }); }
    catch { send(res, 503, { status: "degraded", database: "unavailable" }); }
    return;
  }
  if (route === "/api/auth/status" && req.method === "GET") {
    const session = currentSession(req);
    send(res, 200, {
      setupRequired: db.prepare("SELECT COUNT(*) AS n FROM administrators").get().n === 0,
      authenticated: Boolean(session),
      administrator: session ? { id: session.id, email: session.email, role: session.role } : null,
      csrfToken: session?.csrf_token || null,
    });
    return;
  }
  if (!route.startsWith("/api/")) { send(res, 404, { error: "Not found." }); return; }

  if (route === "/api/auth/setup" && req.method === "POST") {
    if (!checkOrigin(req)) { send(res, 403, { error: "Request origin rejected." }); return; }
    const providedSetupToken = String(req.headers["x-setup-token"] || "");
    if (!setupToken || providedSetupToken.length !== setupToken.length || !timingSafeEqual(Buffer.from(providedSetupToken), Buffer.from(setupToken))) {
      send(res, 403, { error: "Setup token is invalid or setup is already complete." }); return;
    }
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid request." }); return; }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 256) {
      send(res, 400, { error: "Enter a valid email and a password between 12 and 256 characters." }); return;
    }
    if (db.prepare("SELECT COUNT(*) AS n FROM administrators").get().n !== 0) { setupToken = null; send(res, 409, { error: "Owner setup has already completed." }); return; }
    const salt = randomBytes(16).toString("hex");
    const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
    const id = randomBytes(16).toString("hex");
    db.prepare("INSERT INTO administrators(id,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?)")
      .run(id, email, salt, passwordHash, new Date().toISOString());
    audit("administrator.owner_created", id, id);
    setupToken = null;
    const sessionToken = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const now = Date.now();
    sessionInsert.run(hashToken(sessionToken), id, csrf, now, now + sessionMaxAge);
    setSessionCookie(res, sessionToken);
    send(res, 201, { administrator: { id, email, role: "owner" }, csrfToken: csrf });
    return;
  }
  if (route === "/api/auth/login" && req.method === "POST") {
    if (!checkOrigin(req)) { send(res, 403, { error: "Request origin rejected." }); return; }
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid request." }); return; }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
    const key = `${req.socket.remoteAddress || "local"}:${email}`;
    if (rateLimited(key)) { send(res, 429, { error: "Too many sign-in attempts. Try again in 15 minutes." }); return; }
    const admin = db.prepare("SELECT * FROM administrators WHERE email=?").get(email);
    let valid = false;
    if (admin && typeof body.password === "string" && body.password.length <= 256) {
      const candidate = await scrypt(body.password, admin.password_salt, 64);
      valid = timingSafeEqual(candidate, Buffer.from(admin.password_hash, "hex"));
    }
    if (!valid) { audit("administrator.login_failed", null, null, email.slice(0, 254)); send(res, 401, { error: "Email or password is incorrect." }); return; }
    loginAttempts.delete(key);
    const sessionToken = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const now = Date.now();
    sessionInsert.run(hashToken(sessionToken), admin.id, csrf, now, now + sessionMaxAge);
    audit("administrator.login", admin.id, admin.id);
    setSessionCookie(res, sessionToken);
    send(res, 200, { administrator: { id: admin.id, email: admin.email, role: admin.role }, csrfToken: csrf });
    return;
  }

  if (route === "/api/enrollment/public-key" && req.method === "GET") {
    send(res, 200, { algorithm: "Ed25519", publicKey: enrollmentPublicKey, serverUrl });
    return;
  }
  if (route === "/api/agent/enroll" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid enrollment request." }); return; }
    const grant = body.enrollmentGrant;
    const manifest = grant?.manifest;
    const signature = typeof grant?.signature === "string" ? grant.signature : "";
    if (!manifest || typeof manifest !== "object" || signature.length > 256) { send(res, 400, { error: "A signed enrollment grant is required." }); return; }
    let signatureValid = false;
    try { signatureValid = cryptoVerify(null, Buffer.from(canonicalJson(manifest)), enrollmentPublicKey, Buffer.from(signature, "base64url")); } catch { signatureValid = false; }
    if (!signatureValid) { send(res, 403, { error: "Enrollment grant signature is invalid." }); return; }
    if (manifest.version !== 1 || manifest.serverUrl !== serverUrl || manifest.audience !== serverUrl || typeof manifest.grantId !== "string" || typeof manifest.policyId !== "string") {
      send(res, 403, { error: "Enrollment grant is for a different server or policy." }); return;
    }
    const grantRow = db.prepare("SELECT * FROM enrollment_grants WHERE id=?").get(manifest.grantId);
    const policy = db.prepare("SELECT * FROM enrollment_policies WHERE id=?").get(manifest.policyId);
    if (!grantRow || !policy || grantRow.policy_id !== policy.id || grantRow.revoked_at || policy.revoked_at) { send(res, 403, { error: "Enrollment grant or policy has been revoked." }); return; }
    if (Date.parse(grantRow.expires_at) <= Date.now() || Date.parse(manifest.expiresAt) <= Date.now()) { send(res, 410, { error: "Enrollment grant has expired." }); return; }
    if (grantRow.manifest_json !== canonicalJson(manifest) || grantRow.signature !== signature || manifest.maxUses !== grantRow.max_uses) { send(res, 403, { error: "Enrollment grant does not match the server record." }); return; }
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const os = typeof body.operatingSystem === "string" ? body.operatingSystem.trim() : "";
    const publicKeyPem = typeof body.devicePublicKey === "string" ? body.devicePublicKey : "";
    const clientNonce = typeof body.clientNonce === "string" ? body.clientNonce : "";
    const clientTimestamp = Number(body.timestamp);
    const proof = typeof body.proofSignature === "string" ? body.proofSignature : "";
    let publicKey;
    try { publicKey = createPublicKey(publicKeyPem); } catch { publicKey = null; }
    if (!/^[A-Fa-f0-9-]{16,64}$/.test(deviceId) || !name || name.length > 200 || !os || os.length > 120 || !publicKey || publicKey.asymmetricKeyType !== "ed25519" || publicKeyPem.length > 4096 || !/^[A-Za-z0-9_-]{20,120}$/.test(clientNonce) || !Number.isSafeInteger(clientTimestamp) || Math.abs(Date.now() - clientTimestamp) > 5 * 60_000) {
      send(res, 400, { error: "Device identity or installation details are invalid." }); return;
    }
    const allowedOS = JSON.parse(policy.allowed_os_json);
    if (allowedOS.length && !allowedOS.some((allowed) => os.toLowerCase().includes(allowed.toLowerCase()))) { send(res, 403, { error: "This operating system is not allowed by the enrollment policy." }); return; }
    const proofMessage = Buffer.from(`${manifest.grantId}\n${deviceId}\n${clientTimestamp}\n${clientNonce}`);
    let proofValid = false;
    try { proofValid = cryptoVerify(null, proofMessage, publicKey, Buffer.from(proof, "base64url")); } catch { proofValid = false; }
    if (!proofValid) { send(res, 401, { error: "Device key proof is invalid." }); return; }

    const existing = db.prepare("SELECT * FROM devices WHERE id=?").get(deviceId);
    if (existing) {
      if (existing.enrollment_grant_id === grantRow.id && existing.device_public_key === publicKeyPem && !existing.revoked_at) {
        send(res, existing.enrollment_state === "pending" ? 202 : 200, { deviceId, status: existing.enrollment_state, idempotent: true }); return;
      }
      send(res, 409, { error: "This device identity has already been used." }); return;
    }
    const mode = policy.approval_mode;
    const state = mode === "approval" ? "pending" : "approved";
    if (grantRow.used_count >= grantRow.max_uses) { send(res, 409, { error: "This enrollment grant has reached its device limit." }); return; }
    const now = new Date().toISOString();
    const insertDevice = db.prepare(`INSERT INTO devices(id,name,operating_system,os_version,architecture,ip_addresses,agent_version,last_seen,enrolled_at,device_public_key,enrollment_grant_id,enrollment_state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const createClaim = db.prepare("INSERT INTO enrollment_claims(device_id,grant_id,client_nonce,state,created_at) VALUES(?,?,?,?,?)");
    const reserveGrant = db.prepare("UPDATE enrollment_grants SET used_count=used_count+1 WHERE id=? AND used_count < max_uses AND revoked_at IS NULL");
    try {
      db.exec("BEGIN IMMEDIATE");
      const reserved = reserveGrant.run(grantRow.id);
      if (reserved.changes !== 1) { db.exec("ROLLBACK"); send(res, 409, { error: "This enrollment grant has reached its device limit." }); return; }
      insertDevice.run(deviceId, name, os, String(body.osVersion || "").slice(0, 120), String(body.architecture || "").slice(0, 64), "[]", String(body.agentVersion || "").slice(0, 80), null, now, publicKeyPem, grantRow.id, state);
      createClaim.run(deviceId, grantRow.id, clientNonce, state, now);
      audit(state === "approved" ? "agent.enrollment_approved" : "agent.enrollment_pending", null, deviceId, JSON.stringify({ grantId: grantRow.id, policyId: policy.id }));
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
      send(res, 409, { error: "Enrollment could not be recorded." }); return;
    }
    send(res, state === "pending" ? 202 : 201, { deviceId, status: state, checkInAllowed: state === "approved" });
    return;
  }
  if ((route === "/api/agent/heartbeat" || route === "/api/agent/inventory") && req.method === "POST") {
    let raw;
    try { raw = await readRawBody(req, route.endsWith("inventory") ? 1024 * 1024 : 64 * 1024); } catch { send(res, 413, { error: "Agent report is too large." }); return; }
    const body = parseRawJson(raw);
    if (!body || typeof body !== "object") { send(res, 400, { error: "Invalid agent report." }); return; }
    const device = authenticateAgentRequest(req, raw, res);
    if (!device) return;
    if (route === "/api/agent/heartbeat") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name && name.length > 200) { send(res, 400, { error: "Device name is too long." }); return; }
      const safePercent = (n) => Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
      const now = new Date().toISOString();
      db.prepare(`UPDATE devices SET name=COALESCE(NULLIF(?,''),name), operating_system=COALESCE(NULLIF(?,''),operating_system),
        os_version=COALESCE(NULLIF(?,''),os_version), architecture=COALESCE(NULLIF(?,''),architecture), manufacturer=COALESCE(NULLIF(?,''),manufacturer),
        model=COALESCE(NULLIF(?,''),model), cpu=COALESCE(NULLIF(?,''),cpu), cpu_cores=COALESCE(?,cpu_cores), total_memory_mb=COALESCE(?,total_memory_mb),
        ip_addresses=COALESCE(?,ip_addresses), agent_version=COALESCE(NULLIF(?,''),agent_version), last_seen=? WHERE id=?`)
        .run(name, String(body.operatingSystem || "").slice(0,120), String(body.osVersion || "").slice(0,120), String(body.architecture || "").slice(0,64),
          String(body.manufacturer || "").slice(0,200), String(body.model || "").slice(0,200), String(body.cpu || "").slice(0,300),
          Number.isInteger(body.cpuCores) && body.cpuCores > 0 && body.cpuCores <= 1024 ? body.cpuCores : null,
          Number.isInteger(body.totalMemoryMB) && body.totalMemoryMB > 0 && body.totalMemoryMB <= 4_194_304 ? body.totalMemoryMB : null,
          Array.isArray(body.ipAddresses) ? JSON.stringify(body.ipAddresses.filter((ip) => typeof ip === "string").slice(0,32).map((ip) => ip.slice(0,64))) : null,
          String(body.agentVersion || "").slice(0,80), now, device.id);
      const cpu = safePercent(body.metrics?.cpuPercent);
      const memory = safePercent(body.metrics?.memoryPercent);
      if (cpu !== null || memory !== null) {
        const previous = db.prepare("SELECT recorded_at FROM metric_samples WHERE device_id=? ORDER BY recorded_at DESC LIMIT 1").get(device.id);
        if (!previous || Date.now() - Date.parse(previous.recorded_at) >= 5000) {
          db.prepare("INSERT INTO metric_samples(device_id,recorded_at,cpu_percent,memory_percent) VALUES(?,?,?,?)").run(device.id, now, cpu, memory);
        }
      }
      send(res, 200, { ok: true, checkedInAt: now });
      return;
    }
    const apps = body.software;
    if (!Array.isArray(apps) || apps.length > 10000 || apps.some((app) => !app || typeof app.name !== "string" || app.name.length === 0 || app.name.length > 300)) {
      send(res, 400, { error: "Software inventory is invalid." }); return;
    }
    const insertSoftware = db.prepare("INSERT INTO software_inventory(device_id,name,version,publisher,installed_at) VALUES(?,?,?,?,?)");
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("DELETE FROM software_inventory WHERE device_id=?").run(device.id);
      for (const app of apps) insertSoftware.run(device.id, app.name, typeof app.version === "string" ? app.version.slice(0,120) : null,
        typeof app.publisher === "string" ? app.publisher.slice(0,200) : null, typeof app.installedAt === "string" && !Number.isNaN(Date.parse(app.installedAt)) ? app.installedAt : null);
      db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(new Date().toISOString(), device.id);
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
      send(res, 500, { error: "Software inventory could not be saved." }); return;
    }
    send(res, 200, { ok: true, applications: apps.length });
    return;
  }

  const session = requireAdmin(req, res);
  if (!session) return;
  if ((req.method === "POST" || req.method === "DELETE" || req.method === "PATCH") && !checkOrigin(req)) {
    send(res, 403, { error: "Request origin rejected." }); return;
  }
  if (route === "/api/auth/logout" && req.method === "POST") {
    if (!csrfValid(req, session)) { send(res, 403, { error: "Security token expired. Refresh and try again." }); return; }
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(session.token_hash);
    audit("administrator.logout", session.id, session.id);
    clearSessionCookie(res);
    send(res, 200, { ok: true });
    return;
  }
  if ((req.method === "POST" || req.method === "DELETE" || req.method === "PATCH") && !csrfValid(req, session)) {
    send(res, 403, { error: "Security token expired. Refresh and try again." }); return;
  }
  const hasManagementRights = session.role === "owner" || session.role === "administrator";
  if ((route.startsWith("/api/enrollment/") || route.startsWith("/api/installer-packages") || route.startsWith("/api/devices/")) && !hasManagementRights) {
    send(res, 403, { error: "Your role cannot manage enrollment or devices." }); return;
  }
  if (route === "/api/enrollment/policies" && req.method === "GET") {
    const policies = db.prepare(`SELECT p.id,p.name,p.max_devices AS maxDevices,p.expires_in_hours AS expiresInHours,p.approval_mode AS approvalMode,
      p.allowed_os_json AS allowedOperatingSystems,p.created_at AS createdAt,p.revoked_at AS revokedAt,
      (SELECT COUNT(*) FROM enrollment_grants g WHERE g.policy_id=p.id AND g.revoked_at IS NULL AND g.expires_at>?) AS activeGrants
      FROM enrollment_policies p ORDER BY p.created_at DESC`).all(new Date().toISOString()).map((p) => ({ ...p, allowedOperatingSystems: JSON.parse(p.allowedOperatingSystems) }));
    send(res, 200, { items: policies }); return;
  }
  if (route === "/api/enrollment/policies" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid policy request." }); return; }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const maxDevices = Number(body.maxDevices);
    const expiresInHours = Number(body.expiresInHours);
    const approvalMode = body.approvalMode === "approval" ? "approval" : body.approvalMode === "automatic" ? "automatic" : "";
    const operatingSystems = Array.isArray(body.allowedOperatingSystems) ? body.allowedOperatingSystems : ["Windows"];
    if (!name || name.length > 100 || !Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 10000 || !Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 8760 || !approvalMode || operatingSystems.length > 10 || operatingSystems.some((os) => typeof os !== "string" || os.trim().length < 2 || os.trim().length > 32)) {
      send(res, 400, { error: "Enter a name, a device limit from 1 to 10,000, expiry from 1 to 8,760 hours, an approval mode and up to ten allowed OS values." }); return;
    }
    const id = randomBytes(16).toString("hex");
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO enrollment_policies(id,name,max_devices,expires_in_hours,approval_mode,allowed_os_json,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, name, maxDevices, expiresInHours, approvalMode, JSON.stringify(operatingSystems.map((os) => os.trim())), session.id, now);
    audit("enrollment.policy_created", session.id, id, JSON.stringify({ maxDevices, expiresInHours, approvalMode }));
    send(res, 201, { id, name, maxDevices, expiresInHours, approvalMode, allowedOperatingSystems: operatingSystems, createdAt: now }); return;
  }
  const policyRevoke = route.match(/^\/api\/enrollment\/policies\/([a-f0-9]{32})\/revoke$/);
  if (policyRevoke && req.method === "POST") {
    const result = db.prepare("UPDATE enrollment_policies SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(new Date().toISOString(), policyRevoke[1]);
    if (!result.changes) { send(res, 404, { error: "Policy not found or already revoked." }); return; }
    db.prepare("UPDATE enrollment_grants SET revoked_at=? WHERE policy_id=? AND revoked_at IS NULL").run(new Date().toISOString(), policyRevoke[1]);
    audit("enrollment.policy_revoked", session.id, policyRevoke[1]);
    send(res, 200, { ok: true }); return;
  }
  const grantCollection = route === "/api/enrollment/grants";
  if (grantCollection && req.method === "GET") {
    const items = db.prepare(`SELECT g.id,g.policy_id AS policyId,p.name AS policyName,g.max_uses AS maxUses,g.used_count AS usedCount,
      g.expires_at AS expiresAt,g.created_at AS createdAt,g.revoked_at AS revokedAt FROM enrollment_grants g
      JOIN enrollment_policies p ON p.id=g.policy_id ORDER BY g.created_at DESC`).all();
    send(res, 200, { items }); return;
  }
  const issueGrant = route.match(/^\/api\/enrollment\/policies\/([a-f0-9]{32})\/grants$/);
  if (issueGrant && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid grant request." }); return; }
    let issued;
    try {
      db.exec("BEGIN IMMEDIATE");
      const policy = db.prepare("SELECT * FROM enrollment_policies WHERE id=? AND revoked_at IS NULL").get(issueGrant[1]);
      if (!policy) { db.exec("ROLLBACK"); send(res, 404, { error: "Active enrollment policy not found." }); return; }
      const nowIso = new Date().toISOString();
      const usage = db.prepare(`SELECT COALESCE(SUM(used_count),0) AS consumed,
        COALESCE(SUM(CASE WHEN revoked_at IS NULL AND expires_at>? THEN max_uses-used_count ELSE 0 END),0) AS reserved
        FROM enrollment_grants WHERE policy_id=?`).get(nowIso, policy.id);
      const availablePolicySlots = Math.max(0, policy.max_devices - usage.consumed - usage.reserved);
      const maxUses = body.maxUses === undefined ? availablePolicySlots : Number(body.maxUses);
      const hours = body.expiresInHours === undefined ? policy.expires_in_hours : Number(body.expiresInHours);
      if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > availablePolicySlots || !Number.isInteger(hours) || hours < 1 || hours > policy.expires_in_hours) {
        db.exec("ROLLBACK"); send(res, 400, { error: `Grant limits must fit the policy. ${availablePolicySlots} enrollment slot(s) remain available.` }); return;
      }
      const id = randomBytes(16).toString("hex");
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + hours * 60 * 60_000).toISOString();
      const manifest = { version: 1, grantId: id, policyId: policy.id, serverUrl, audience: serverUrl, issuedAt: createdAt, expiresAt,
        maxUses, allowedOperatingSystems: JSON.parse(policy.allowed_os_json), approvalMode: policy.approval_mode };
      const signature = signManifest(manifest);
      db.prepare(`INSERT INTO enrollment_grants(id,policy_id,manifest_json,signature,max_uses,expires_at,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, policy.id, canonicalJson(manifest), signature, maxUses, expiresAt, session.id, createdAt);
      audit("enrollment.grant_created", session.id, id, JSON.stringify({ policyId: policy.id, maxUses, expiresAt }));
      db.exec("COMMIT");
      issued = { id, policyId: policy.id, createdAt, expiresAt, maxUses, usedCount: 0, enrollmentGrant: { manifest, signature } };
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
      send(res, 500, { error: "Enrollment authorization could not be issued." }); return;
    }
    send(res, 201, issued); return;
  }
  const grantRevoke = route.match(/^\/api\/enrollment\/grants\/([a-f0-9]{32})\/revoke$/);
  if (grantRevoke && req.method === "POST") {
    const result = db.prepare("UPDATE enrollment_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(new Date().toISOString(), grantRevoke[1]);
    if (!result.changes) { send(res, 404, { error: "Grant not found or already revoked." }); return; }
    audit("enrollment.grant_revoked", session.id, grantRevoke[1]);
    send(res, 200, { ok: true }); return;
  }
  if (route === "/api/enrollment/pending" && req.method === "GET") {
    const items = db.prepare(`SELECT d.id,d.name,d.operating_system AS operatingSystem,d.os_version AS osVersion,d.enrolled_at AS requestedAt,
      p.name AS policyName,c.grant_id AS grantId FROM enrollment_claims c JOIN devices d ON d.id=c.device_id
      JOIN enrollment_grants g ON g.id=c.grant_id JOIN enrollment_policies p ON p.id=g.policy_id WHERE c.state='pending' ORDER BY c.created_at`).all();
    send(res, 200, { items }); return;
  }
  const reviewClaim = route.match(/^\/api\/enrollment\/pending\/([A-Fa-f0-9-]{16,64})\/(approve|reject)$/);
  if (reviewClaim && req.method === "POST") {
    const [, deviceId, action] = reviewClaim;
    const claim = db.prepare("SELECT * FROM enrollment_claims WHERE device_id=? AND state='pending'").get(deviceId);
    if (!claim) { send(res, 404, { error: "Pending enrollment request not found." }); return; }
    if (action === "approve") {
      db.prepare("UPDATE enrollment_claims SET state='approved',reviewed_by=?,reviewed_at=? WHERE device_id=?").run(session.id, new Date().toISOString(), deviceId);
      db.prepare("UPDATE devices SET enrollment_state='approved' WHERE id=? AND revoked_at IS NULL").run(deviceId);
      audit("enrollment.device_approved", session.id, deviceId, JSON.stringify({ grantId: claim.grant_id }));
      send(res, 200, { ok: true, status: "approved" }); return;
    }
    db.prepare("UPDATE enrollment_claims SET state='rejected',reviewed_by=?,reviewed_at=? WHERE device_id=?").run(session.id, new Date().toISOString(), deviceId);
    db.prepare("UPDATE devices SET enrollment_state='rejected',revoked_at=? WHERE id=?").run(new Date().toISOString(), deviceId);
    audit("enrollment.device_rejected", session.id, deviceId, JSON.stringify({ grantId: claim.grant_id }));
    send(res, 200, { ok: true, status: "rejected" }); return;
  }
  const revokeDevice = route.match(/^\/api\/devices\/([A-Fa-f0-9-]{16,64})\/revoke$/);
  if (revokeDevice && req.method === "POST") {
    const result = db.prepare("UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(new Date().toISOString(), revokeDevice[1]);
    if (!result.changes) { send(res, 404, { error: "Device not found or already revoked." }); return; }
    audit("device.revoked", session.id, revokeDevice[1]);
    send(res, 200, { ok: true }); return;
  }
  if (route === "/api/overview" && req.method === "GET") {
    const rows = db.prepare("SELECT last_seen, revoked_at, enrollment_state FROM devices").all();
    const managed = rows.filter((r) => !r.revoked_at && r.enrollment_state === "approved");
    const live = managed.filter((r) => isOnline(r.last_seen)).length;
    const revoked = rows.filter((r) => Boolean(r.revoked_at)).length;
    const series = db.prepare(`SELECT strftime('%Y-%m-%dT%H:00:00Z', recorded_at) AS hour,
      ROUND(AVG(cpu_percent),1) AS cpu, ROUND(AVG(memory_percent),1) AS memory
      FROM metric_samples WHERE recorded_at >= ? GROUP BY hour ORDER BY hour`).all(new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    const latest = db.prepare("SELECT MAX(last_seen) AS last_seen FROM devices WHERE revoked_at IS NULL AND enrollment_state='approved'").get().last_seen;
    const pending = rows.filter((r) => !r.revoked_at && r.enrollment_state === "pending").length;
    send(res, 200, { totalDevices: managed.length, onlineDevices: live, offlineDevices: managed.length - live,
      revokedDevices: revoked, pendingEnrollments: pending, lastCheckIn: latest, performance: series });
    return;
  }
  if (route === "/api/devices" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
    const status = url.searchParams.get("status") || "all";
    const sort = url.searchParams.get("sort") || "name";
    const direction = url.searchParams.get("direction") === "desc" ? "DESC" : "ASC";
    const rawPage = Number(url.searchParams.get("page") || 1);
    const rawPageSize = Number(url.searchParams.get("pageSize") || 25);
    const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(100000, rawPage) : 1;
    const pageSize = Number.isSafeInteger(rawPageSize) && rawPageSize > 0 ? Math.min(100, Math.max(10, rawPageSize)) : 25;
    const sortColumns = { name: "name", os: "operating_system", lastSeen: "last_seen", enrolledAt: "enrolled_at" };
    let rows = db.prepare(`SELECT d.*,
      (SELECT m.cpu_percent FROM metric_samples m WHERE m.device_id=d.id ORDER BY m.recorded_at DESC LIMIT 1) AS cpu_percent,
      (SELECT m.memory_percent FROM metric_samples m WHERE m.device_id=d.id ORDER BY m.recorded_at DESC LIMIT 1) AS memory_percent
      FROM devices d ORDER BY ${sortColumns[sort] || "name"} ${direction}`).all();
    if (q) {
      const needle = q.toLocaleLowerCase();
      rows = rows.filter((row) => [row.name, row.operating_system, row.os_version, row.manufacturer, row.model, row.ip_addresses]
        .some((value) => String(value || "").toLocaleLowerCase().includes(needle)));
    }
    if (status !== "all") rows = rows.filter((row) => deviceView(row).status.toLowerCase() === status.toLowerCase());
    const total = rows.length;
    send(res, 200, { items: rows.slice((page - 1) * pageSize, page * pageSize).map(deviceView), total, page, pageSize });
    return;
  }
  const deviceMatch = route.match(/^\/api\/devices\/([A-Za-z0-9_-]+)$/);
  if (deviceMatch && req.method === "GET") {
    const row = db.prepare("SELECT * FROM devices WHERE id=?").get(deviceMatch[1]);
    if (!row) { send(res, 404, { error: "Device not found." }); return; }
    const software = db.prepare("SELECT name, version, publisher, installed_at AS installedAt FROM software_inventory WHERE device_id=? ORDER BY name COLLATE NOCASE LIMIT 200");
    // The table is introduced with inventory ingestion; until then details return an empty real result.
    let applications = [];
    try { applications = software.all(deviceMatch[1]); } catch { applications = []; }
    send(res, 200, { device: deviceView(row), software: applications });
    return;
  }
  if (route === "/api/audit" && req.method === "GET") {
    const items = db.prepare(`SELECT e.id,e.action,e.target_id AS targetId,e.detail,e.created_at AS createdAt,a.email AS actor
      FROM audit_events e LEFT JOIN administrators a ON a.id=e.actor_id ORDER BY e.id DESC LIMIT 50`).all();
    send(res, 200, { items });
    return;
  }
  send(res, 404, { error: "API route not found." });
}

async function sendStatic(req, res, pathname) {
  if (process.env.RMM_DEV_API_ONLY) { send(res, 404, { error: "Use the Vite development address." }); return; }
  const dist = path.join(root, "dist");
  const candidate = path.resolve(dist, `.${decodeURIComponent(pathname)}`);
  if (!candidate.startsWith(`${dist}${path.sep}`) && candidate !== path.join(dist, "index.html")) { send(res, 400, { error: "Invalid path." }); return; }
  let file = candidate;
  try { if (!(await stat(file)).isFile()) file = path.join(dist, "index.html"); }
  catch { file = path.join(dist, "index.html"); }
  try {
    const content = await readFile(file);
    const ext = path.extname(file);
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable" });
    res.end(content);
  } catch { send(res, 503, { error: "Dashboard build is missing. Run npm run build first." }); }
}

const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (!process.env.RMM_DEV_API_ONLY) {
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  }
  if (req.method === "OPTIONS") { res.writeHead(204, { Allow: "GET, POST, DELETE, PATCH, OPTIONS" }); res.end(); return; }
  let url;
  try { url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`); }
  catch { send(res, 400, { error: "Invalid URL." }); return; }
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else if (req.method === "GET") await sendStatic(req, res, url.pathname);
    else send(res, 404, { error: "Not found." });
  } catch (error) {
    console.error("Request failed:", error?.message || "unknown error");
    if (!res.headersSent) send(res, 500, { error: "The request could not be completed." }); else res.end();
  }
});

server.listen(port, host, () => {
  console.log(`RMM API listening on http://${host}:${port}`);
  if (!process.env.RMM_DEV_API_ONLY && !process.env.RMM_ENV) console.log("Development mode: bind to localhost only.");
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  server.close(() => { db.close(); process.exit(0); });
});
