import { createServer } from "node:http";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, readFile, stat } from "node:fs/promises";
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
`);

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
    status: row.revoked_at ? "Revoked" : isOnline(row.last_seen) ? "Online" : "Offline",
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
  if (route === "/api/overview" && req.method === "GET") {
    const rows = db.prepare("SELECT last_seen, revoked_at FROM devices").all();
    const live = rows.filter((r) => !r.revoked_at && isOnline(r.last_seen)).length;
    const revoked = rows.filter((r) => Boolean(r.revoked_at)).length;
    const series = db.prepare(`SELECT strftime('%Y-%m-%dT%H:00:00Z', recorded_at) AS hour,
      ROUND(AVG(cpu_percent),1) AS cpu, ROUND(AVG(memory_percent),1) AS memory
      FROM metric_samples WHERE recorded_at >= ? GROUP BY hour ORDER BY hour`).all(new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    const latest = db.prepare("SELECT MAX(last_seen) AS last_seen FROM devices WHERE revoked_at IS NULL").get().last_seen;
    send(res, 200, { totalDevices: rows.length - revoked, onlineDevices: live, offlineDevices: rows.length - revoked - live,
      revokedDevices: revoked, lastCheckIn: latest, performance: series });
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
