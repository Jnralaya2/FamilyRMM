import { createServer } from "node:http";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, scrypt as scryptCallback, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getApplicationCatalog, resolveCatalogApplication, downloadCatalogInstaller } from "./deployment-catalog.mjs";
import { finalizeInstallerBuild } from "./installer-build-lifecycle.mjs";

const scrypt = promisify(scryptCallback);
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const host = process.env.RMM_HOST || "127.0.0.1";
const port = Number(process.env.RMM_PORT || (process.env.RMM_DEV_API_ONLY ? 3001 : 3000));
const secureCookie = process.env.RMM_COOKIE_SECURE === "1" || process.env.RMM_ENV === "production";
const dataPath = path.resolve(root, process.env.RMM_DB_PATH || "data/rmm.sqlite");
const artifactPath = path.resolve(root, process.env.RMM_ARTIFACTS_DIR || ".artifacts");
const supportsSoftwareDeployment = (version) => {
  const match = typeof version === "string" && version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  return parts[0] > 0 || (parts[0] === 0 && (parts[1] > 2 || (parts[1] === 2 && parts[2] >= 4)));
};
await mkdir(path.dirname(dataPath), { recursive: true });

const db = new DatabaseSync(dataPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    license_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    device_limit INTEGER NOT NULL,
    session_limit INTEGER NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','active','revoked')),
    organization_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    redeemed_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS screenconnect_instances (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    base_url TEXT NOT NULL,
    deployment_type TEXT NOT NULL CHECK(deployment_type IN ('cloud','self_hosted')),
    version TEXT,
    credential_env_ref TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    created_by TEXT NOT NULL REFERENCES administrators(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS administrators (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    organization_id TEXT,
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
    software_inventory_at TEXT,
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
    system_managed INTEGER NOT NULL DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS installer_packages (
    id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES enrollment_grants(id),
    agent_version TEXT NOT NULL,
    build_status TEXT NOT NULL,
    signing_status TEXT,
    msi_file TEXT,
    setup_file TEXT,
    msi_sha256 TEXT,
    setup_sha256 TEXT,
    build_error TEXT,
    created_by TEXT NOT NULL REFERENCES administrators(id),
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    generic INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS installer_packages_created_idx ON installer_packages(created_at);
  CREATE TABLE IF NOT EXISTS installer_download_links (
    id TEXT PRIMARY KEY,
    installer_id TEXT NOT NULL REFERENCES installer_packages(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES administrators(id),
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS installer_download_links_package_idx ON installer_download_links(installer_id, created_at);
  CREATE TABLE IF NOT EXISTS installer_build_workers (
    id TEXT PRIMARY KEY CHECK(id='primary'),
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen TEXT,
    disabled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS installer_build_jobs (
    id TEXT PRIMARY KEY,
    installer_id TEXT NOT NULL REFERENCES installer_packages(id) ON DELETE CASCADE,
    grant_id TEXT NOT NULL REFERENCES enrollment_grants(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    claimed_at TEXT,
    generic INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS installer_build_queue_idx ON installer_build_jobs(status, created_at);
  CREATE TABLE IF NOT EXISTS software_packages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    publisher TEXT,
    package_type TEXT NOT NULL CHECK(package_type IN ('msi','exe','powershell')),
    file_name TEXT,
    file_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    install_arguments_json TEXT NOT NULL,
    script_body TEXT,
    created_by TEXT NOT NULL REFERENCES administrators(id),
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS software_packages_created_idx ON software_packages(created_at);
  CREATE TABLE IF NOT EXISTS deployment_jobs (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL REFERENCES software_packages(id),
    action TEXT NOT NULL CHECK(action IN ('install','update','script')),
    timeout_seconds INTEGER NOT NULL DEFAULT 1800,
    created_by TEXT NOT NULL REFERENCES administrators(id),
    created_at TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    cancelled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS deployment_targets (
    job_id TEXT NOT NULL REFERENCES deployment_jobs(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','delivered','running','succeeded','failed','cancelled','expired')),
    assigned_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    exit_code INTEGER,
    output TEXT,
    error TEXT,
    PRIMARY KEY(job_id, device_id)
  );
  CREATE INDEX IF NOT EXISTS deployment_targets_device_state_idx ON deployment_targets(device_id,state,assigned_at);
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

// Move the initial platform-level instance registry to tenant-scoped ownership.
const screenConnectColumns = new Set(db.prepare("PRAGMA table_info(screenconnect_instances)").all().map((item) => item.name));
if (!screenConnectColumns.has("organization_id")) {
  db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE screenconnect_instances RENAME TO screenconnect_instances_legacy;
    CREATE TABLE screenconnect_instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      base_url TEXT NOT NULL,
      deployment_type TEXT NOT NULL CHECK(deployment_type IN ('cloud','self_hosted')),
      version TEXT,
      credential_env_ref TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_by TEXT NOT NULL REFERENCES administrators(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id,base_url)
    );
    INSERT INTO screenconnect_instances(id,name,organization_id,base_url,deployment_type,version,credential_env_ref,enabled,created_by,created_at,updated_at)
      SELECT old.id,old.name,COALESCE(admin.organization_id,(SELECT id FROM organizations ORDER BY created_at LIMIT 1)),old.base_url,old.deployment_type,old.version,old.credential_env_ref,old.enabled,old.created_by,old.created_at,old.updated_at
      FROM screenconnect_instances_legacy old LEFT JOIN administrators admin ON admin.id=old.created_by;
    DROP TABLE screenconnect_instances_legacy;
    COMMIT;`);
} else {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS screenconnect_org_url_idx ON screenconnect_instances(organization_id,base_url)");
}

// Forward-only SQLite migrations keep existing local development databases usable.
const ensureColumn = (table, column, declaration) => {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
};
for (const table of ["administrators", "devices", "audit_events", "enrollment_policies", "enrollment_grants", "installer_packages", "software_packages", "deployment_jobs"]) {
  ensureColumn(table, "organization_id", "TEXT");
}
ensureColumn("installer_packages", "generic", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("installer_build_jobs", "generic", "INTEGER NOT NULL DEFAULT 0");
let defaultOrganization = db.prepare("SELECT id FROM organizations ORDER BY created_at LIMIT 1").get();
if (!defaultOrganization) {
  const id = randomBytes(16).toString("hex");
  db.prepare("INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)").run(id, "Family Systems", new Date().toISOString());
  defaultOrganization = { id };
}
for (const table of ["administrators", "devices", "audit_events", "enrollment_policies", "enrollment_grants", "installer_packages", "software_packages", "deployment_jobs"]) {
  db.prepare(`UPDATE ${table} SET organization_id=? WHERE organization_id IS NULL`).run(defaultOrganization.id);
}
db.prepare("UPDATE administrators SET role='platform_owner' WHERE id=(SELECT id FROM administrators ORDER BY created_at,id LIMIT 1) AND role='owner'").run();
db.exec("CREATE INDEX IF NOT EXISTS devices_org_idx ON devices(organization_id, revoked_at)");
db.exec("CREATE INDEX IF NOT EXISTS licenses_org_status_idx ON licenses(organization_id,status)");
const deviceColumns = new Set(db.prepare("PRAGMA table_info(devices)").all().map((column) => column.name));
ensureColumn("licenses", "session_limit", "INTEGER NOT NULL DEFAULT 3");
ensureColumn("enrollment_policies", "system_managed", "INTEGER NOT NULL DEFAULT 0");
if (!deviceColumns.has("device_public_key")) db.exec("ALTER TABLE devices ADD COLUMN device_public_key TEXT");
if (!deviceColumns.has("enrollment_grant_id")) db.exec("ALTER TABLE devices ADD COLUMN enrollment_grant_id TEXT");
if (!deviceColumns.has("enrollment_state")) db.exec("ALTER TABLE devices ADD COLUMN enrollment_state TEXT NOT NULL DEFAULT 'approved'");
if (!deviceColumns.has("software_inventory_at")) db.exec("ALTER TABLE devices ADD COLUMN software_inventory_at TEXT");
const deploymentJobColumns = new Set(db.prepare("PRAGMA table_info(deployment_jobs)").all().map((column) => column.name));
if (!deploymentJobColumns.has("scheduled_for")) {
  db.exec("ALTER TABLE deployment_jobs ADD COLUMN scheduled_for TEXT");
  db.exec("UPDATE deployment_jobs SET scheduled_for=created_at WHERE scheduled_for IS NULL");
}
ensureColumn("software_packages", "catalog_app_id", "TEXT");
ensureColumn("deployment_jobs", "retry_of_job_id", "TEXT REFERENCES deployment_jobs(id)");
ensureColumn("deployment_targets", "lease_id", "TEXT");
ensureColumn("deployment_targets", "lease_expires_at", "TEXT");
ensureColumn("deployment_targets", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("deployment_targets", "inventory_state", "TEXT NOT NULL DEFAULT 'not_reported'");
ensureColumn("deployment_targets", "inventory_error", "TEXT");
ensureColumn("deployment_targets", "verification_state", "TEXT NOT NULL DEFAULT 'not_requested'");
ensureColumn("deployment_targets", "installed_version", "TEXT");
ensureColumn("deployment_targets", "reboot_required", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("deployment_targets", "retryable", "INTEGER NOT NULL DEFAULT 1");
db.exec("CREATE INDEX IF NOT EXISTS software_packages_catalog_idx ON software_packages(organization_id,catalog_app_id,version,revoked_at)");
db.exec("CREATE INDEX IF NOT EXISTS deployment_target_lease_idx ON deployment_targets(state,lease_expires_at)");
db.exec("CREATE INDEX IF NOT EXISTS software_packages_catalog_hash_idx ON software_packages(organization_id,catalog_app_id,version,sha256,revoked_at)");

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
const signingKeyFile = process.env.RMM_ENROLLMENT_PRIVATE_KEY_FILE;
if (process.env.RMM_ENROLLMENT_PRIVATE_KEY && signingKeyFile) {
  console.error("Configure either RMM_ENROLLMENT_PRIVATE_KEY or RMM_ENROLLMENT_PRIVATE_KEY_FILE, not both.");
  process.exit(1);
}
if (signingKeyFile) {
  try { enrollmentPrivateKey = await readFile(signingKeyFile, "utf8"); }
  catch { console.error("RMM_ENROLLMENT_PRIVATE_KEY_FILE could not be read."); process.exit(1); }
  enrollmentPublicKey = createPublicKey(enrollmentPrivateKey).export({ format: "pem", type: "spki" }).toString();
} else if (process.env.RMM_ENROLLMENT_PRIVATE_KEY) {
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
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    enrollmentPrivateKey = pair.privateKey;
    try { await writeFile(signingPath, enrollmentPrivateKey, { flag: "wx", mode: 0o600 }); }
    catch { enrollmentPrivateKey = await readFile(signingPath, "utf8"); }
  }
  if (createPublicKey(enrollmentPrivateKey).asymmetricKeyType !== "ec") {
    if (db.prepare("SELECT COUNT(*) AS n FROM enrollment_grants").get().n > 0) {
      console.error("The development enrollment key uses a previous algorithm and active grants exist; migrate or revoke them before rotating the key.");
      process.exit(1);
    }
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    enrollmentPrivateKey = pair.privateKey;
    await writeFile(signingPath, enrollmentPrivateKey, { mode: 0o600 });
  }
  enrollmentPublicKey = createPublicKey(enrollmentPrivateKey).export({ format: "pem", type: "spki" }).toString();
}
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
if (createPublicKey(enrollmentPrivateKey).asymmetricKeyType !== "ec") {
  console.error("RMM_ENROLLMENT_PRIVATE_KEY must contain a P-256 ECDSA key.");
  process.exit(1);
}
const signManifest = (manifest) => cryptoSign("sha256", Buffer.from(canonicalJson(manifest)), enrollmentPrivateKey).toString("base64url");
function ensureWorkspaceInstallerGrant(session) {
  const organizationId = session.organization_id;
  let policy = db.prepare("SELECT * FROM enrollment_policies WHERE organization_id=? AND system_managed=1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").get(organizationId);
  const now = new Date();
  const createdAt = now.toISOString();
  if (!policy) {
    const policyId = randomBytes(16).toString("hex");
    db.prepare("INSERT INTO enrollment_policies(id,name,max_devices,expires_in_hours,approval_mode,allowed_os_json,system_managed,created_by,created_at,organization_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(policyId, "Windows device approval", -1, 8760, "approval", JSON.stringify(["Windows"]), 1, session.id, createdAt, organizationId);
    policy = db.prepare("SELECT * FROM enrollment_policies WHERE id=?").get(policyId);
    audit("enrollment.default_installer_policy_created", session.id, policyId);
  }
  const nowIso = now.toISOString();
  let grant = db.prepare("SELECT * FROM enrollment_grants WHERE policy_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1").get(policy.id, nowIso);
  if (!grant) {
    const id = randomBytes(16).toString("hex");
    const expiresAt = new Date(now.getTime() + 8760 * 60 * 60_000).toISOString();
    const maxUses = -1;
    const manifest = { version: 1, grantId: id, policyId: policy.id, organizationId, serverUrl, audience: serverUrl,
      issuedAt: createdAt, expiresAt, maxUses, allowedOperatingSystems: ["Windows"], approvalMode: "approval" };
    const signature = signManifest(manifest);
    db.prepare("INSERT INTO enrollment_grants(id,policy_id,manifest_json,signature,max_uses,expires_at,created_by,created_at,organization_id) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, policy.id, canonicalJson(manifest), signature, maxUses, expiresAt, session.id, createdAt, organizationId);
    grant = db.prepare("SELECT * FROM enrollment_grants WHERE id=?").get(id);
    audit("enrollment.default_installer_grant_created", session.id, id, JSON.stringify({ policyId: policy.id, maxUses, expiresAt }));
  }
  return { policy, grant };
}

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

const insertAudit = db.prepare(`INSERT INTO audit_events(actor_id, action, target_id, detail, organization_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?)`);
function audit(action, actorId = null, targetId = null, detail = null) {
  let organizationId = actorId ? db.prepare("SELECT organization_id FROM administrators WHERE id=?").get(actorId)?.organization_id || null : null;
  if (!organizationId && targetId) {
    organizationId = db.prepare(`SELECT organization_id FROM devices WHERE id=?
      UNION ALL SELECT organization_id FROM enrollment_grants WHERE id=?
      UNION ALL SELECT organization_id FROM installer_packages WHERE id=?
      UNION ALL SELECT organization_id FROM software_packages WHERE id=?
      UNION ALL SELECT organization_id FROM deployment_jobs WHERE id=? LIMIT 1`).get(targetId, targetId, targetId, targetId, targetId)?.organization_id || null;
  }
  insertAudit.run(actorId, action, targetId, detail, organizationId, new Date().toISOString());
}

function recoverExpiredDeploymentLeases(now = new Date().toISOString()) {
  const stale = db.prepare("SELECT job_id AS jobId,device_id AS deviceId FROM deployment_targets WHERE state IN ('delivered','running') AND (lease_expires_at IS NULL OR lease_expires_at<=?)").all(now);
  if (!stale.length) return 0;
  db.prepare(`UPDATE deployment_targets SET state='expired',completed_at=?,retryable=0,
    error='Agent lease expired before a final result was received. Execution outcome is unknown; verify the computer before creating a new deployment.'
    WHERE state IN ('delivered','running') AND (lease_expires_at IS NULL OR lease_expires_at<=?)`).run(now, now);
  for (const target of stale) audit("deployment.lease_expired", null, target.jobId, JSON.stringify({ deviceId: target.deviceId, outcome: "unknown", retryable: false }));
  return stale.length;
}
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
let installerBuildLoopActive = false;
function startLocalInstallerBuildLoop() {
  if (installerBuildLoopActive) return;
  installerBuildLoopActive = true;
  setImmediate(async () => {
    try {
      while (true) {
        const now = new Date().toISOString();
        const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
        const job = db.prepare(`SELECT b.id AS jobId,b.installer_id AS installerId,b.grant_id AS grantId,b.organization_id AS organizationId,b.generic,
            i.agent_version AS agentVersion,i.created_by AS createdBy
          FROM installer_build_jobs b JOIN installer_packages i ON i.id=b.installer_id
          JOIN enrollment_grants g ON g.id=b.grant_id JOIN enrollment_policies p ON p.id=g.policy_id
          WHERE (b.status='queued' OR (b.status='running' AND b.updated_at<?))
            AND (b.generic=1 OR (g.revoked_at IS NULL AND p.revoked_at IS NULL AND g.expires_at>?))
          ORDER BY b.created_at LIMIT 1`).get(staleBefore, now);
        if (!job) break;
        if (!organizationEntitlement(job.organizationId).allowed) {
          const message = "Workspace suspended because its license was revoked; installer build was not started.";
          db.exec("BEGIN IMMEDIATE");
          try {
            const failed = db.prepare(`UPDATE installer_build_jobs SET status='failed',error=?,updated_at=?
              WHERE id=? AND status IN ('queued','running')`).run(message, new Date().toISOString(), job.jobId);
            if (failed.changes) {
              db.prepare("UPDATE installer_packages SET build_status='failed',build_error=? WHERE id=? AND build_status='building'").run(message, job.installerId);
              audit("installer.package_build_suspended", null, job.installerId, JSON.stringify({ jobId: job.jobId, reason: "workspace_suspended" }));
            }
            db.exec("COMMIT");
          } catch (error) {
            try { db.exec("ROLLBACK"); } catch { /* Transaction already closed. */ }
            throw error;
          }
          continue;
        }
        const claimed = db.prepare(`UPDATE installer_build_jobs SET status='running',claimed_at=?,updated_at=?,error=NULL
          WHERE id=? AND (status='queued' OR (status='running' AND updated_at<?))`).run(now, now, job.jobId, staleBefore);
        if (!claimed.changes) continue;

        const outputDir = path.join(artifactPath, "packages", job.installerId);
        const configPath = path.join(outputDir, "package-config.json");
        const buildScript = path.join(root, "scripts", "build-agent-package.mjs");
        try {
          const output = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [buildScript], {
              cwd: root,
              env: { ...process.env, RMM_ENV: "production", RMM_ALLOW_UNSIGNED_INSTALLERS: "1",
                RMM_SIGNTOOL_PATH: "", RMM_SIGN_CERT_THUMBPRINT: "", RMM_PACKAGE_CONFIG_PATH: configPath,
                RMM_PACKAGE_DIR: outputDir, RMM_PACKAGE_VERSION: job.agentVersion },
              detached: process.platform !== "win32",
              stdio: ["ignore", "pipe", "pipe"],
            });
            const chunks = [];
            let size = 0;
            let timeoutMessage = "";
            const collect = (chunk) => {
              if (size < 1_000_000) { chunks.push(chunk); size += chunk.length; }
            };
            child.stdout.on("data", collect);
            child.stderr.on("data", collect);
            const killBuildGroup = (signal) => {
              try {
                if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
                else child.kill(signal);
              } catch { try { child.kill(signal); } catch { /* Process already exited. */ } }
            };
            const timeout = setTimeout(() => {
              timeoutMessage = "Installer build exceeded its 12-minute limit; the build process was stopped.";
              killBuildGroup("SIGTERM");
              forceKill = setTimeout(() => killBuildGroup("SIGKILL"), 5000);
            }, 12 * 60_000);
            let forceKill;
            child.once("error", (error) => { clearTimeout(timeout); clearTimeout(forceKill); reject(error); });
            child.once("close", (code, signal) => {
              clearTimeout(timeout);
              clearTimeout(forceKill);
              const text = Buffer.concat(chunks).toString("utf8");
              if (code === 0 && !timeoutMessage) resolve(text);
              else reject(new Error(text.trim().slice(-5000) || timeoutMessage || `Installer build exited with ${code ?? signal}.`));
            });
          });
          const buildInfo = JSON.parse(await readFile(path.join(outputDir, "build-info.json"), "utf8"));
          if (buildInfo.signingStatus !== "unsigned") throw new Error("Unexpected installer signing state.");
          const published = finalizeInstallerBuild(db, {
            jobId: job.jobId, installerId: job.installerId, organizationId: job.organizationId, buildInfo,
            now: new Date().toISOString(), isOrganizationEntitled: (organizationId) => organizationEntitlement(organizationId).allowed,
            audit: () => audit("installer.package_created", job.createdBy, job.installerId, JSON.stringify({ grantId: job.grantId, signingStatus: buildInfo.signingStatus, generic: Boolean(job.generic), localBuild: true })),
          });
          if (!published) throw new Error("Workspace was suspended or the installer build stopped; package was not made available.");
          console.log(`Windows installer package ${job.installerId} built from agent source (${Buffer.byteLength(output)} bytes of builder output).`);
        } catch (error) {
          const message = String(error?.message || "Windows installer build failed.").slice(0, 1500);
          db.exec("BEGIN IMMEDIATE");
          try {
            const failed = db.prepare("UPDATE installer_build_jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'").run(message, new Date().toISOString(), job.jobId);
            if (failed.changes) {
              db.prepare("UPDATE installer_packages SET build_status='failed',build_error=? WHERE id=? AND build_status='building'").run(message, job.installerId);
              audit("installer.package_build_failed", job.createdBy, job.installerId, JSON.stringify({ grantId: job.grantId, reason: message.slice(0, 400), localBuild: true }));
            }
            db.exec("COMMIT");
          } catch (recordError) {
            try { db.exec("ROLLBACK"); } catch { /* Transaction already closed. */ }
            throw recordError;
          }
          console.error(`Windows installer package ${job.installerId} failed: ${message}`);
        }
      }
    } catch (error) {
      console.error("Installer build queue failed:", error?.message || "unknown error");
    } finally {
      installerBuildLoopActive = false;
      const queued = db.prepare("SELECT 1 FROM installer_build_jobs WHERE status='queued' LIMIT 1").get();
      if (queued) startLocalInstallerBuildLoop();
    }
  });
}
function publicInstallerRecord(token) {
  if (typeof token !== "string") return null;
  if (/^[a-f0-9]{32}$/i.test(token)) return db.prepare(`SELECT i.*,i.organization_id AS entitlement_organization_id,g.expires_at,g.used_count,g.max_uses,g.revoked_at AS grant_revoked,
    p.revoked_at AS policy_revoked FROM installer_packages i JOIN enrollment_grants g ON g.id=i.grant_id
    JOIN enrollment_policies p ON p.id=g.policy_id WHERE i.id=?`).get(token.toLowerCase()) || null;
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  return db.prepare(`SELECT l.id AS linkId,l.revoked_at AS linkRevoked,i.*,i.organization_id AS entitlement_organization_id,g.expires_at,g.used_count,g.max_uses,
    g.revoked_at AS grant_revoked,p.revoked_at AS policy_revoked FROM installer_download_links l JOIN installer_packages i ON i.id=l.installer_id
    JOIN enrollment_grants g ON g.id=i.grant_id JOIN enrollment_policies p ON p.id=g.policy_id WHERE l.token_hash=?`).get(hashToken(token)) || null;
}
function publicInstallerUsable(item) {
  return Boolean(item
    && typeof item.id === "string"
    && /^[a-f0-9]{32}$/i.test(item.id)
    && item.build_status === "ready"
    && item.revoked_at === null
    && (!Object.hasOwn(item, "linkRevoked") || item.linkRevoked === null)
    && organizationEntitlement(item.entitlement_organization_id ?? item.organization_id).allowed);
}
function sendPublicInstallerPage(res, token) {
  const item = publicInstallerRecord(token);
  if (!publicInstallerUsable(item)) {
    const body = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Installer unavailable</title><body><h1>Installer unavailable</h1><p>This installer is not available. Contact the Family RMM administrator.</p></body></html>";
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.end(body); return;
  }
  const body = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"referrer\" content=\"no-referrer\"><title>Download Family RMM Agent</title><style>body{font:16px system-ui,sans-serif;background:#f4f7f8;color:#17252a;margin:0;padding:8vh 20px}.card{max-width:620px;margin:auto;background:#fff;border:1px solid #dce5e7;border-radius:18px;padding:32px;box-shadow:0 8px 30px #132c3510}h1{margin-top:0}p,li{line-height:1.6;color:#52656b}.buttons{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}a{display:inline-block;background:#137b78;color:#fff;padding:13px 20px;border-radius:9px;text-decoration:none;font-weight:650}.note{font-size:14px}</style><main class=\"card\"><h1>Download Family RMM Agent</h1><p>This permanent download link only provides the installer. Installing creates a pending enrollment request; the computer is not manageable until the Family RMM administrator approves it.</p><div class=\"buttons\"><a href=\"/api/public-installers/" + token + "/msi\" rel=\"noreferrer\">Download MSI</a><a href=\"/api/public-installers/" + token + "/exe\" rel=\"noreferrer\">Download EXE</a></div><h2>Install and enroll</h2><ol><li>Download and run the installer, then approve the Windows administrator prompt.</li><li>The Family RMM Agent service starts automatically and submits a pending request.</li><li>The administrator reviews and approves the computer in Family RMM → Enrollment.</li></ol><p class=\"note\">The installer is unsigned and Windows may show an unknown-publisher warning. Keep SmartScreen enabled. The installer never includes an administrator password.</p></main></html>";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end(body);
}
function authenticateInstallerBuildWorker(req) {
  const authorization = String(req.headers.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return false;
  const worker = db.prepare("SELECT token_hash FROM installer_build_workers WHERE id='primary' AND disabled_at IS NULL").get();
  if (!worker) return false;
  const supplied = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(worker.token_hash, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  db.prepare("UPDATE installer_build_workers SET last_seen=? WHERE id='primary'").run(new Date().toISOString());
  return true;
}
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
  , a.organization_id
  FROM sessions s JOIN administrators a ON a.id=s.admin_id WHERE s.token_hash=?`);
function enforceSessionLimit(organizationId, sessionLimit) {
  if (!Number.isInteger(sessionLimit) || sessionLimit < 1) return;
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now);
  const active = db.prepare(`SELECT s.token_hash FROM sessions s JOIN administrators a ON a.id=s.admin_id
    WHERE a.organization_id=? AND s.expires_at>? ORDER BY s.created_at ASC`).all(organizationId, now);
  const evictCount = Math.max(0, active.length - sessionLimit + 1);
  const remove = db.prepare("DELETE FROM sessions WHERE token_hash=?");
  for (const session of active.slice(0, evictCount)) remove.run(session.token_hash);
}

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
const suspendedWorkspaceError = "This workspace is suspended because its license is revoked. Contact the FamilyRMM platform owner.";
function organizationEntitlement(organizationId) {
  const organization = db.prepare(`SELECT o.id,o.license_id,l.id AS matched_license_id,l.organization_id AS license_organization_id,l.status AS license_status
    FROM organizations o LEFT JOIN licenses l ON l.id=o.license_id WHERE o.id=?`).get(organizationId);
  if (!organization) return { allowed: false, status: "unavailable", organizationId };
  // The platform owner's default workspace is deliberately license-free. Do not
  // extend this exception to any other organization, including platform-owner
  // sessions scoped to a customer workspace.
  if (organization.id === defaultOrganization.id && organization.license_id === null)
    return { allowed: true, status: "unlicensed", organizationId, platformWorkspace: true };
  if (!organization.license_id || !organization.matched_license_id || organization.license_organization_id !== organization.id)
    return { allowed: false, status: "unavailable", organizationId };
  return { allowed: organization.license_status === "active", status: organization.license_status, organizationId };
}
function requireOrganizationEntitlement(organizationId, res, { kind = "session", hidden = false } = {}) {
  const entitlement = organizationEntitlement(organizationId);
  if (entitlement.allowed) return true;
  if (hidden) {
    send(res, 404, { error: "Installer package not found." });
    return false;
  }
  if (kind === "agent" || kind === "enrollment") {
    send(res, 403, { error: suspendedWorkspaceError, code: "WORKSPACE_SUSPENDED" });
    return false;
  }
  if (kind === "worker") {
    send(res, 410, { error: "This installer build is no longer available.", code: "WORKSPACE_SUSPENDED" });
    return false;
  }
  send(res, 423, { error: suspendedWorkspaceError, code: "WORKSPACE_SUSPENDED" });
  return false;
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
function authenticateAgentRequest(req, raw, res, allowPending = false) {
  const deviceId = String(req.headers["x-device-id"] || "");
  const timestamp = String(req.headers["x-device-timestamp"] || "");
  const nonce = String(req.headers["x-device-nonce"] || "");
  const signature = String(req.headers["x-device-signature"] || "");
  if (!/^[A-Fa-f0-9-]{16,64}$/.test(deviceId) || !/^\d{10,16}$/.test(timestamp) || !/^[A-Za-z0-9_-]{20,120}$/.test(nonce) || signature.length > 256) {
    send(res, 401, { error: "Invalid agent authentication." }); return null;
  }
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > 60_000) { send(res, 401, { error: "Agent request expired." }); return null; }
  const device = db.prepare(`SELECT d.id,d.device_public_key,d.revoked_at,d.enrollment_state,d.organization_id
    FROM devices d JOIN organizations o ON o.id=d.organization_id LEFT JOIN licenses l ON l.id=o.license_id WHERE d.id=?`).get(deviceId);
  if (!device || device.revoked_at || (!allowPending && device.enrollment_state !== "approved") || !device.device_public_key) { send(res, 403, { error: "This device is not authorized." }); return null; }
  const message = Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), raw]);
  let valid = false;
  try { valid = cryptoVerify("sha256", message, device.device_public_key, Buffer.from(signature, "base64url")); } catch { valid = false; }
  if (!valid) { send(res, 401, { error: "Agent signature is invalid." }); return null; }
  if (!requireOrganizationEntitlement(device.organization_id, res, { kind: "agent" })) return null;
  try { db.prepare("INSERT INTO agent_request_nonces(device_id, nonce, used_at) VALUES(?,?,?)").run(deviceId, nonce, Date.now()); }
  catch { send(res, 409, { error: "Agent request nonce has already been used." }); return null; }
  db.prepare("DELETE FROM agent_request_nonces WHERE used_at < ?").run(Date.now() - 10 * 60_000);
  return device;
}
function requireAdmin(req, res, { allowSuspended = false } = {}) {
  const session = currentSession(req);
  if (!session) { send(res, 401, { error: "Sign in to continue." }); return null; }
  if (!allowSuspended && !requireOrganizationEntitlement(session.organization_id, res)) return null;
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
    softwareInventoryAt: row.software_inventory_at ?? null,
    cpuUsagePercent: row.cpu_percent ?? null,
    memoryUsagePercent: row.memory_percent ?? null,
    lastSeen: row.last_seen,
    enrolledAt: row.enrolled_at,
    status: row.revoked_at ? "Revoked" : row.enrollment_state === "pending" ? "Pending approval" : row.enrollment_state === "rejected" ? "Rejected" : isOnline(row.last_seen) ? "Online" : "Offline",
  };
}

const loginAttempts = new Map();
function clientAddress(req) {
  // The app is only reachable through Caddy in production. Caddy appends the
  // connecting peer to X-Forwarded-For, so use the final value rather than the
  // shared Docker bridge address seen in req.socket.remoteAddress.
  const forwarded = req.headers["x-forwarded-for"];
  const proxiedAddress = typeof forwarded === "string" ? forwarded.split(",").at(-1)?.trim() : "";
  return proxiedAddress || req.socket.remoteAddress || "local";
}
function rateLimited(keys) {
  const now = Date.now();
  const windowMs = 15 * 60_000;
  for (const [key, value] of loginAttempts) if (now - value.start > windowMs) loginAttempts.delete(key);
  const limited = keys.some((key) => (loginAttempts.get(key)?.count || 0) >= 10);
  for (const key of keys) {
    const prior = loginAttempts.get(key);
    if (!prior || now - prior.start > windowMs) loginAttempts.set(key, { start: now, count: 1 });
    else prior.count++;
  }
  // Keep the in-memory limiter bounded if many distinct identifiers are sent.
  while (loginAttempts.size > 10_000) loginAttempts.delete(loginAttempts.keys().next().value);
  return limited;
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
    const purchaseContact = db.prepare("SELECT value FROM platform_settings WHERE key='license_purchase_contact'").get()?.value || "";
    const workspace = session ? db.prepare("SELECT name FROM organizations WHERE id=?").get(session.organization_id) : null;
    const entitlement = session ? organizationEntitlement(session.organization_id) : null;
    send(res, 200, {
      setupRequired: db.prepare("SELECT COUNT(*) AS n FROM administrators").get().n === 0,
      authenticated: Boolean(session),
      purchaseContact,
      administrator: session ? { id: session.id, email: session.email, role: session.role, organizationId: session.organization_id,
        workspaceName: workspace?.name || "Workspace", deviceLimit: null, sessionLimit: null, licenseStatus: entitlement.status,
        suspended: !entitlement.allowed, licenseMessage: entitlement.allowed ? null : suspendedWorkspaceError } : null,
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
    db.prepare("INSERT INTO administrators(id,email,password_salt,password_hash,role,organization_id,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, email, salt, passwordHash, "platform_owner", defaultOrganization.id, new Date().toISOString());
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
  if (route === "/api/auth/register" && req.method === "POST") {
    if (!checkOrigin(req)) { send(res, 403, { error: "Request origin rejected." }); return; }
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid registration request." }); return; }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const workspace = typeof body.workspace === "string" ? body.workspace.trim().slice(0, 100) : "";
    const password = typeof body.password === "string" ? body.password : "";
    const licenseKey = typeof body.licenseKey === "string" ? body.licenseKey.trim().toUpperCase() : "";
    if (rateLimited([`ip:${clientAddress(req)}:register`, `email:${email}:register`])) { send(res, 429, { error: "Too many account attempts. Try again in 15 minutes." }); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !workspace || password.length < 12 || password.length > 256 || !/^FRMM-[A-Z0-9-]{24,64}$/.test(licenseKey)) {
      send(res, 400, { error: "Enter a workspace name, valid email, password of at least 12 characters, and a valid license key." }); return;
    }
    const keyHash = hashToken(licenseKey);
    const license = db.prepare("SELECT * FROM licenses WHERE key_hash=? AND status='available'").get(keyHash);
    if (!license) { send(res, 400, { error: "That license key is invalid, already used, or revoked." }); return; }
    if (db.prepare("SELECT 1 FROM administrators WHERE email=?").get(email)) { send(res, 409, { error: "An account already exists for that email." }); return; }
    const salt = randomBytes(16).toString("hex");
    const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
    const id = randomBytes(16).toString("hex");
    const organizationId = randomBytes(16).toString("hex");
    const createdAt = new Date().toISOString();
    const sessionToken = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const redeemed = db.prepare("UPDATE licenses SET status='active',organization_id=?,redeemed_at=? WHERE id=? AND status='available'").run(organizationId, createdAt, license.id);
      if (redeemed.changes !== 1) { db.exec("ROLLBACK"); send(res, 409, { error: "That license key has already been redeemed." }); return; }
      db.prepare("INSERT INTO organizations(id,name,license_id,created_at) VALUES(?,?,?,?)").run(organizationId, workspace, license.id, createdAt);
      db.prepare("INSERT INTO administrators(id,email,password_salt,password_hash,role,organization_id,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, email, salt, passwordHash, "owner", organizationId, createdAt);
      sessionInsert.run(hashToken(sessionToken), id, csrf, now, now + sessionMaxAge);
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* Transaction already closed. */ }
      send(res, 500, { error: "Account could not be created." }); return;
    }
    audit("license.redeemed", id, license.id, JSON.stringify({ deviceLimit: license.device_limit }));
    setSessionCookie(res, sessionToken);
    send(res, 201, { administrator: { id, email, role: "owner" }, csrfToken: csrf });
    return;
  }
  if (route === "/api/auth/login" && req.method === "POST") {
    if (!checkOrigin(req)) { send(res, 403, { error: "Request origin rejected." }); return; }
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid request." }); return; }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
    const keys = [`ip:${clientAddress(req)}:login`, `email:${email}:login`];
    if (rateLimited(keys)) { send(res, 429, { error: "Too many sign-in attempts. Try again in 15 minutes." }); return; }
    const admin = db.prepare("SELECT * FROM administrators WHERE email=?").get(email);
    let valid = false;
    if (admin && typeof body.password === "string" && body.password.length <= 256) {
      const candidate = await scrypt(body.password, admin.password_salt, 64);
      valid = timingSafeEqual(candidate, Buffer.from(admin.password_hash, "hex"));
    }
    if (!valid) { audit("administrator.login_failed", null, null, email.slice(0, 254)); send(res, 401, { error: "Email or password is incorrect." }); return; }
    const entitlement = organizationEntitlement(admin.organization_id);
    if (!entitlement.allowed) {
      send(res, 423, { error: suspendedWorkspaceError, code: "WORKSPACE_SUSPENDED" });
      return;
    }
    for (const key of keys) loginAttempts.delete(key);
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
    send(res, 200, { algorithm: "ECDSA-P256-SHA256", publicKey: enrollmentPublicKey, serverUrl });
    return;
  }
  if (route === "/api/agent/enroll/status" && req.method === "POST") {
    let raw;
    try { raw = await readRawBody(req, 1024); } catch { send(res, 413, { error: "Request is too large." }); return; }
    if (raw.length && raw.toString("utf8") !== "{}") { send(res, 400, { error: "Invalid enrollment status request." }); return; }
    const device = authenticateAgentRequest(req, raw, res, true);
    if (!device) return;
    send(res, 200, { status: device.enrollment_state }); return;
  }
  if (route === "/api/agent/enroll" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid enrollment request." }); return; }
    const grant = body.enrollmentGrant;
    const manifest = grant?.manifest;
    const signature = typeof grant?.signature === "string" ? grant.signature : "";
    if (!manifest) {
      const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const os = typeof body.operatingSystem === "string" ? body.operatingSystem.trim() : "";
      const publicKeyPem = typeof body.devicePublicKey === "string" ? body.devicePublicKey : "";
      const nonce = typeof body.clientNonce === "string" ? body.clientNonce : "";
      const timestamp = Number(body.timestamp);
      let publicKey;
      try { publicKey = createPublicKey(publicKeyPem); } catch { publicKey = null; }
      if (!/^[A-Fa-f0-9-]{16,64}$/.test(deviceId) || !name || name.length > 200 || !os || os.length > 120 ||
          !publicKey || publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" || publicKeyPem.length > 4096 ||
          !/^[A-Za-z0-9_-]{20,120}$/.test(nonce) || !Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60_000) {
        send(res, 400, { error: "Device identity or installation details are invalid." }); return;
      }
      let proofValid = false;
      try { proofValid = cryptoVerify("sha256", Buffer.from(`${deviceId}\n${timestamp}\n${nonce}`), publicKey, Buffer.from(String(body.proofSignature || ""), "base64url")); } catch { proofValid = false; }
      if (!proofValid) { send(res, 401, { error: "Device key proof is invalid." }); return; }
      if (!requireOrganizationEntitlement(defaultOrganization.id, res, { kind: "enrollment" })) return;
      if (process.env.RMM_ENV === "production") {
        send(res, 403, { error: "A signed workspace enrollment grant is required.", code: "ENROLLMENT_GRANT_REQUIRED" }); return;
      }
      const existing = db.prepare("SELECT id,organization_id,device_public_key,enrollment_state,revoked_at FROM devices WHERE id=?").get(deviceId);
      if (existing) {
        if (existing.organization_id !== defaultOrganization.id || existing.device_public_key !== publicKeyPem || existing.revoked_at || existing.enrollment_state === "rejected") {
          send(res, 403, { error: "This device identity is already registered or has been denied." }); return;
        }
        send(res, existing.enrollment_state === "pending" ? 202 : 200, { deviceId, status: existing.enrollment_state, checkInAllowed: existing.enrollment_state === "approved", idempotent: true }); return;
      }
      const now = new Date().toISOString();
      try {
        db.prepare(`INSERT INTO devices(id,name,operating_system,os_version,architecture,ip_addresses,agent_version,last_seen,enrolled_at,device_public_key,enrollment_grant_id,enrollment_state,organization_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'pending',?)`).run(deviceId, name, os, String(body.osVersion || "").slice(0,120),
          String(body.architecture || "").slice(0,64), "[]", String(body.agentVersion || "").slice(0,80), null, now, publicKeyPem, defaultOrganization.id);
      } catch {
        send(res, 409, { error: "Enrollment request could not be recorded." }); return;
      }
      audit("agent.enrollment_pending", null, deviceId, JSON.stringify({ authorization: "administrator_approval_required" }));
      send(res, 202, { deviceId, status: "pending", checkInAllowed: false }); return;
    }
    if (!manifest || typeof manifest !== "object" || signature.length > 256) { send(res, 400, { error: "A signed enrollment grant is required." }); return; }
    let signatureValid = false;
    try { signatureValid = cryptoVerify("sha256", Buffer.from(canonicalJson(manifest)), enrollmentPublicKey, Buffer.from(signature, "base64url")); } catch { signatureValid = false; }
    if (!signatureValid) { send(res, 403, { error: "Enrollment grant signature is invalid." }); return; }
    if (manifest.version !== 1 || manifest.serverUrl !== serverUrl || manifest.audience !== serverUrl || typeof manifest.grantId !== "string" || typeof manifest.policyId !== "string" || (manifest.organizationId !== undefined && typeof manifest.organizationId !== "string")) {
      send(res, 403, { error: "Enrollment grant is for a different server or policy." }); return;
    }
    const grantRow = db.prepare("SELECT * FROM enrollment_grants WHERE id=?").get(manifest.grantId);
    const manifestOrganizationId = manifest.organizationId || (grantRow?.organization_id === defaultOrganization.id ? defaultOrganization.id : null);
    const policy = manifestOrganizationId ? db.prepare("SELECT * FROM enrollment_policies WHERE id=? AND organization_id=?").get(manifest.policyId, manifestOrganizationId) : null;
    const organization = manifestOrganizationId ? db.prepare("SELECT o.id,o.license_id,l.status FROM organizations o LEFT JOIN licenses l ON l.id=o.license_id WHERE o.id=?").get(manifestOrganizationId) : null;
    if (grantRow && grantRow.organization_id !== manifestOrganizationId) { send(res, 403, { error: "Enrollment grant belongs to another workspace." }); return; }
    if (!grantRow || !policy || !organization || grantRow.policy_id !== policy.id || grantRow.revoked_at || policy.revoked_at) { send(res, 403, { error: "Enrollment grant or policy is inactive." }); return; }
    if (!requireOrganizationEntitlement(organization.id, res, { kind: "enrollment" })) return;
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
    if (!/^[A-Fa-f0-9-]{16,64}$/.test(deviceId) || !name || name.length > 200 || !os || os.length > 120 || !publicKey || publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" || publicKeyPem.length > 4096 || !/^[A-Za-z0-9_-]{20,120}$/.test(clientNonce) || !Number.isSafeInteger(clientTimestamp) || Math.abs(Date.now() - clientTimestamp) > 5 * 60_000) {
      send(res, 400, { error: "Device identity or installation details are invalid." }); return;
    }
    const allowedOS = JSON.parse(policy.allowed_os_json);
    if (allowedOS.length && !allowedOS.some((allowed) => os.toLowerCase().includes(allowed.toLowerCase()))) { send(res, 403, { error: "This operating system is not allowed by the enrollment policy." }); return; }
    const proofMessage = Buffer.from(`${manifest.grantId}\n${deviceId}\n${clientTimestamp}\n${clientNonce}`);
    let proofValid = false;
    try { proofValid = cryptoVerify("sha256", proofMessage, publicKey, Buffer.from(proof, "base64url")); } catch { proofValid = false; }
    if (!proofValid) { send(res, 401, { error: "Device key proof is invalid." }); return; }

    const existing = db.prepare("SELECT * FROM devices WHERE id=?").get(deviceId);
    if (existing) {
      if (existing.enrollment_grant_id === grantRow.id && existing.organization_id === organization.id && existing.device_public_key === publicKeyPem && !existing.revoked_at) {
        send(res, existing.enrollment_state === "pending" ? 202 : 200, { deviceId, status: existing.enrollment_state, checkInAllowed: existing.enrollment_state === "approved", idempotent: true }); return;
      }
      // Older public installers could create an unscoped, approval-only
      // pending row before signed workspace grants were embedded in generic
      // packages. Allow that same device key to claim it with a valid scoped
      // grant, then keep the normal approval gate before any check-in/job.
      if (existing.enrollment_grant_id == null && existing.enrollment_state === "pending" &&
          existing.device_public_key === publicKeyPem && !existing.revoked_at) {
        const state = policy.approval_mode === "approval" ? "pending" : "approved";
        const now = new Date().toISOString();
        try {
          db.exec("BEGIN IMMEDIATE");
          const reserved = db.prepare("UPDATE enrollment_grants SET used_count=used_count+1 WHERE id=? AND revoked_at IS NULL").run(grantRow.id);
          if (reserved.changes !== 1) { db.exec("ROLLBACK"); send(res, 409, { error: "Enrollment grant is no longer active." }); return; }
          const attached = db.prepare(`UPDATE devices SET enrollment_grant_id=?,enrollment_state=?,organization_id=?
            WHERE id=? AND enrollment_grant_id IS NULL AND enrollment_state='pending' AND revoked_at IS NULL AND device_public_key=?`)
            .run(grantRow.id, state, organization.id, deviceId, publicKeyPem);
          if (attached.changes !== 1) { db.exec("ROLLBACK"); send(res, 409, { error: "This pending device has already been claimed." }); return; }
          db.prepare("INSERT INTO enrollment_claims(device_id,grant_id,client_nonce,state,created_at) VALUES(?,?,?,?,?)")
            .run(deviceId, grantRow.id, clientNonce, state, now);
          audit("agent.legacy_pending_claimed", null, deviceId, JSON.stringify({ grantId: grantRow.id, policyId: policy.id }));
          db.exec("COMMIT");
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
          console.error("Legacy pending enrollment claim failed:", error?.message || "unknown error");
          send(res, 409, { error: "This pending enrollment could not be claimed." }); return;
        }
        send(res, state === "pending" ? 202 : 201, { deviceId, status: state, checkInAllowed: state === "approved" }); return;
      }
      if (existing.organization_id !== organization.id) { send(res, 403, { error: "This computer is already registered to another workspace." }); return; }
      send(res, 409, { error: "This device identity has already been used." }); return;
    }
    const mode = policy.approval_mode;
    const state = mode === "approval" ? "pending" : "approved";
    const now = new Date().toISOString();
    const insertDevice = db.prepare(`INSERT INTO devices(id,name,operating_system,os_version,architecture,ip_addresses,agent_version,last_seen,enrolled_at,device_public_key,enrollment_grant_id,enrollment_state,organization_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const createClaim = db.prepare("INSERT INTO enrollment_claims(device_id,grant_id,client_nonce,state,created_at) VALUES(?,?,?,?,?)");
    const reserveGrant = db.prepare("UPDATE enrollment_grants SET used_count=used_count+1 WHERE id=? AND revoked_at IS NULL");
    try {
      db.exec("BEGIN IMMEDIATE");
      const reserved = reserveGrant.run(grantRow.id);
      if (reserved.changes !== 1) { db.exec("ROLLBACK"); send(res, 409, { error: "Enrollment grant is no longer active." }); return; }
      insertDevice.run(deviceId, name, os, String(body.osVersion || "").slice(0, 120), String(body.architecture || "").slice(0, 64), "[]", String(body.agentVersion || "").slice(0, 80), null, now, publicKeyPem, grantRow.id, state, organization.id);
      createClaim.run(deviceId, grantRow.id, clientNonce, state, now);
      audit(state === "approved" ? "agent.enrollment_approved" : "agent.enrollment_pending", null, deviceId, JSON.stringify({ grantId: grantRow.id, policyId: policy.id }));
      db.exec("COMMIT");
    } catch (error) {
      console.error("Enrollment transaction failed:", error?.message || "unknown error");
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
      const inventoryAt = new Date().toISOString();
      db.prepare("UPDATE devices SET last_seen=?,software_inventory_at=? WHERE id=?").run(inventoryAt, inventoryAt, device.id);
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
      send(res, 500, { error: "Software inventory could not be saved." }); return;
    }
    send(res, 200, { ok: true, applications: apps.length });
    return;
  }

  if (route === "/api/agent/deployments/claim" && req.method === "POST") {
    let raw;
    try { raw = await readRawBody(req, 1024); } catch { send(res, 413, { error: "Request is too large." }); return; }
    if (raw.length && raw.toString("utf8") !== "{}") { send(res, 400, { error: "Invalid deployment claim." }); return; }
    const device = authenticateAgentRequest(req, raw, res);
    if (!device) return;
    const nowDate = new Date();
    const now = nowDate.toISOString();
    let pending;
    let leaseId;
    let leaseExpiresAt;
    try {
      db.exec("BEGIN IMMEDIATE");
      recoverExpiredDeploymentLeases(now);
      const version = db.prepare("SELECT agent_version AS version FROM devices WHERE id=? AND organization_id=? AND revoked_at IS NULL AND enrollment_state='approved'").get(device.id, device.organization_id)?.version;
      if (!supportsSoftwareDeployment(version)) {
        db.exec("COMMIT");
        send(res, 409, { error: "Update Family RMM Agent to 0.2.4 or newer before receiving software deployment jobs." }); return;
      }
      pending = db.prepare(`SELECT t.job_id AS jobId,j.action,j.timeout_seconds AS timeoutSeconds,p.id AS packageId,p.name,p.version,p.publisher,p.package_type AS packageType,
      p.catalog_app_id AS catalogAppId,
      p.file_name AS fileName,p.file_size AS fileSize,p.sha256,p.install_arguments_json AS installArgumentsJson,p.script_body AS scriptBody
      FROM deployment_targets t JOIN deployment_jobs j ON j.id=t.job_id JOIN software_packages p ON p.id=j.package_id
      WHERE t.device_id=? AND t.state='queued' AND j.cancelled_at IS NULL AND p.revoked_at IS NULL
        AND COALESCE(j.scheduled_for,j.created_at)<=? ORDER BY COALESCE(j.scheduled_for,j.created_at),t.assigned_at LIMIT 1`).get(device.id, now);
      if (!pending) { db.exec("COMMIT"); send(res, 200, { task: null }); return; }
      leaseId = randomBytes(16).toString("hex");
      leaseExpiresAt = new Date(nowDate.getTime() + 180_000).toISOString();
      const changed = db.prepare(`UPDATE deployment_targets SET state='delivered',lease_id=?,lease_expires_at=?,attempt_count=attempt_count+1
        WHERE job_id=? AND device_id=? AND state='queued'`).run(leaseId, leaseExpiresAt, pending.jobId, device.id);
      if (!changed.changes) { db.exec("ROLLBACK"); send(res, 409, { error: "Deployment task was already claimed." }); return; }
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* Transaction may have already closed. */ }
      send(res, 500, { error: "Deployment task could not be claimed." }); return;
    }
    const payload = {
      jobId: pending.jobId,
      leaseId,
      leaseExpiresAt,
      action: pending.action,
      timeoutSeconds: pending.timeoutSeconds,
      packageId: pending.packageId,
      catalogAppId: pending.catalogAppId,
      name: pending.name,
      version: pending.version,
      publisher: pending.publisher,
      packageType: pending.packageType,
      fileName: pending.fileName,
      fileSize: pending.fileSize,
      sha256: pending.sha256,
      installArguments: JSON.parse(pending.installArgumentsJson),
      scriptBody: pending.scriptBody,
      issuedAt: now,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    const signature = cryptoSign("sha256", Buffer.from(canonicalJson(payload)), enrollmentPrivateKey).toString("base64url");
    audit("deployment.task_delivered", null, pending.jobId, JSON.stringify({ deviceId: device.id, packageId: pending.packageId }));
    send(res, 200, { task: { payload, signature } });
    return;
  }
  if (route === "/api/agent/deployments/lease" && req.method === "POST") {
    let raw;
    try { raw = await readRawBody(req, 4096); } catch { send(res, 413, { error: "Lease request is too large." }); return; }
    const body = parseRawJson(raw);
    if (!body || !/^[a-f0-9]{32}$/.test(body.jobId || "") || !/^[a-f0-9]{32}$/.test(body.leaseId || "")) { send(res, 400, { error: "Invalid deployment lease." }); return; }
    const device = authenticateAgentRequest(req, raw, res);
    if (!device) return;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 180_000).toISOString();
    const renewed = db.prepare(`UPDATE deployment_targets SET lease_expires_at=? WHERE job_id=? AND device_id=? AND lease_id=?
      AND state IN ('delivered','running') AND lease_expires_at>?`).run(expiresAt, body.jobId, device.id, body.leaseId, now.toISOString());
    if (!renewed.changes) { send(res, 409, { error: "Deployment lease was lost or expired." }); return; }
    send(res, 200, { leaseExpiresAt: expiresAt }); return;
  }
  const deploymentDownload = route.match(/^\/api\/agent\/deployments\/([a-f0-9]{32})\/download$/);
  if (deploymentDownload && req.method === "GET") {
    let raw;
    try { raw = await readRawBody(req, 0); } catch { send(res, 413, { error: "Request is too large." }); return; }
    const device = authenticateAgentRequest(req, raw, res);
    if (!device) return;
    const leaseId = new URL(req.url, "http://localhost").searchParams.get("leaseId") || "";
    if (!/^[a-f0-9]{32}$/.test(leaseId)) { send(res, 400, { error: "A valid deployment lease is required." }); return; }
    const item = db.prepare(`SELECT p.id AS packageId,p.file_name AS fileName,p.sha256,p.file_size AS fileSize,t.state
      FROM deployment_targets t JOIN deployment_jobs j ON j.id=t.job_id JOIN software_packages p ON p.id=j.package_id
      WHERE t.job_id=? AND t.device_id=? AND t.lease_id=? AND t.lease_expires_at>? AND p.package_type IN ('msi','exe') AND p.revoked_at IS NULL AND t.state IN ('delivered','running')`).get(deploymentDownload[1], device.id, leaseId, new Date().toISOString());
    if (!item) { send(res, 404, { error: "Authorized deployment package not found." }); return; }
    const filePath = path.join(artifactPath, "software-packages", item.packageId, item.fileName);
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size !== item.fileSize) { send(res, 503, { error: "Deployment package integrity check failed." }); return; }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path.join(artifactPath, "software-packages", item.packageId, item.fileName))) hash.update(chunk);
      const digest = hash.digest("hex");
      if (digest !== item.sha256) { send(res, 503, { error: "Deployment package integrity check failed." }); return; }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": item.fileSize, "X-Content-SHA256": item.sha256, "Cache-Control": "no-store" });
      createReadStream(path.join(artifactPath, "software-packages", item.packageId, item.fileName)).pipe(res);
    } catch { send(res, 404, { error: "Deployment package is missing." }); }
    return;
  }
  if (route === "/api/agent/deployments/result" && req.method === "POST") {
    let raw;
    try { raw = await readRawBody(req, 96 * 1024); } catch { send(res, 413, { error: "Deployment result is too large." }); return; }
    const body = parseRawJson(raw);
    if (!body || !/^[a-f0-9]{32}$/.test(body.jobId || "") || !/^[a-f0-9]{32}$/.test(body.leaseId || "") || !["running","succeeded","failed"].includes(body.state)) { send(res, 400, { error: "Invalid deployment result." }); return; }
    const device = authenticateAgentRequest(req, raw, res);
    if (!device) return;
    const now = new Date().toISOString();
    const output = typeof body.output === "string" ? body.output.slice(0, 32_000) : null;
    const error = typeof body.error === "string" ? body.error.slice(0, 2_000) : null;
    const exitCode = Number.isInteger(body.exitCode) && body.exitCode >= -1 && body.exitCode <= 65_535 ? body.exitCode : null;
    const rebootRequired = body.rebootRequired === true;
    const inventoryState = ["pending", "succeeded", "failed"].includes(body.inventoryState) ? body.inventoryState : body.state === "succeeded" ? "pending" : "not_reported";
    const verificationState = ["pending", "verified", "not_found", "unavailable"].includes(body.verificationState) ? body.verificationState : body.state === "succeeded" ? "pending" : "not_requested";
    const installedVersion = typeof body.installedVersion === "string" ? body.installedVersion.slice(0, 120) : null;
    const result = body.state === "running"
      ? db.prepare(`UPDATE deployment_targets SET state='running',started_at=COALESCE(started_at,?) WHERE job_id=? AND device_id=? AND lease_id=? AND state='delivered' AND lease_expires_at>?`).run(now, body.jobId, device.id, body.leaseId, now)
      : db.prepare(`UPDATE deployment_targets SET state=?,completed_at=?,exit_code=?,output=?,error=?,inventory_state=?,verification_state=?,installed_version=?,reboot_required=?,retryable=?,lease_expires_at=NULL
        WHERE job_id=? AND device_id=? AND lease_id=? AND state IN ('delivered','running') AND lease_expires_at>?`).run(
        body.state, now, exitCode, output, error, inventoryState, verificationState, installedVersion, rebootRequired ? 1 : 0, body.state === "failed" && body.retryable !== false ? 1 : 0,
        body.jobId, device.id, body.leaseId, now);
    if (!result.changes) {
      const prior = db.prepare("SELECT state,lease_id FROM deployment_targets WHERE job_id=? AND device_id=?").get(body.jobId, device.id);
      if (prior?.lease_id === body.leaseId && prior.state === body.state) { send(res, 200, { ok: true, idempotent: true }); return; }
      send(res, 409, { error: "Deployment lease is no longer active for this device." }); return;
    }
    audit(`deployment.${body.state}`, null, body.jobId, JSON.stringify({ deviceId: device.id, exitCode }));
    send(res, 200, { ok: true });
    return;
  }
  if (route === "/api/agent/deployments/inventory-result" && req.method === "POST") {
    let raw;
    try { raw = await readRawBody(req, 8192); } catch { send(res, 413, { error: "Inventory result is too large." }); return; }
    const body = parseRawJson(raw);
    if (!body || !/^[a-f0-9]{32}$/.test(body.jobId || "") || !/^[a-f0-9]{32}$/.test(body.leaseId || "") || !["succeeded", "failed"].includes(body.inventoryState) || !["verified", "not_found", "unavailable"].includes(body.verificationState)) {
      send(res, 400, { error: "Invalid installation inventory result." }); return;
    }
    const device = authenticateAgentRequest(req, raw, res);
    if (!device) return;
    const changed = db.prepare(`UPDATE deployment_targets SET inventory_state=?,inventory_error=?,verification_state=?,installed_version=?
      WHERE job_id=? AND device_id=? AND lease_id=? AND state='succeeded'`).run(body.inventoryState,
      typeof body.error === "string" ? body.error.slice(0, 2000) : null, body.verificationState,
      typeof body.installedVersion === "string" ? body.installedVersion.slice(0, 120) : null, body.jobId, device.id, body.leaseId);
    if (!changed.changes) { send(res, 409, { error: "Successful deployment record was not found for this device." }); return; }
    audit("deployment.inventory_reported", null, body.jobId, JSON.stringify({ deviceId: device.id, inventoryState: body.inventoryState, verificationState: body.verificationState, installedVersion: typeof body.installedVersion === "string" ? body.installedVersion.slice(0, 120) : null }));
    send(res, 200, { ok: true }); return;
  }

  const installerWorkerManagementRoute = route === "/api/installer-build-worker/status" || route === "/api/installer-build-worker/pair";
  if (route.startsWith("/api/installer-build-worker/") && !installerWorkerManagementRoute) {
    if (!authenticateInstallerBuildWorker(req)) { send(res, 401, { error: "Installer build worker is not paired." }); return; }
    if (route === "/api/installer-build-worker/claim" && req.method === "POST") {
      send(res, 410, { error: "Installer builds are handled directly by the Family RMM server." }); return;
    }
    const upload = route.match(/^\/api\/installer-build-worker\/jobs\/([a-f0-9]{32})\/(msi|exe)$/);
    if (upload && req.method === "PUT") {
      const job = db.prepare(`SELECT b.id,b.installer_id AS installerId,b.grant_id AS grantId,b.organization_id AS organizationId,b.status,b.generic,
          i.agent_version AS agentVersion,g.revoked_at AS grantRevoked,p.revoked_at AS policyRevoked,g.expires_at AS expiresAt,g.used_count AS usedCount,g.max_uses AS maxUses
        FROM installer_build_jobs b JOIN installer_packages i ON i.id=b.installer_id JOIN enrollment_grants g ON g.id=b.grant_id
        JOIN enrollment_policies p ON p.id=g.policy_id WHERE b.id=?`).get(upload[1]);
      if (!job) { send(res, 404, { error: "Active installer build job not found." }); return; }
      if (!organizationEntitlement(job.organizationId).allowed) { requireOrganizationEntitlement(job.organizationId, res, { kind: "worker" }); return; }
      if (job.status !== "running") { send(res, 410, { error: "This installer build is no longer active." }); return; }
      if (!job.generic && (job.grantRevoked || job.policyRevoked || Date.parse(job.expiresAt) <= Date.now())) {
        send(res, 410, { error: "This enrollment authorization is no longer active." }); return;
      }
      let bytes;
      try { bytes = await readRawBody(req, 250 * 1024 * 1024); } catch { send(res, 413, { error: "Installer files are limited to 250 MiB each." }); return; }
      const currentJob = db.prepare("SELECT organization_id AS organizationId,status FROM installer_build_jobs WHERE id=?").get(upload[1]);
      if (!currentJob || currentJob.status !== "running") { send(res, 410, { error: "This installer build is no longer active.", code: "WORKSPACE_SUSPENDED" }); return; }
      if (!requireOrganizationEntitlement(currentJob.organizationId, res, { kind: "worker" })) return;
      const extension = upload[2];
      const magicOk = extension === "msi" ? [0xd0, 0xcf, 0x11, 0xe0].every((value, index) => bytes[index] === value) : bytes[0] === 0x4d && bytes[1] === 0x5a;
      if (!magicOk || bytes.length < 4096) { send(res, 400, { error: `The uploaded ${extension.toUpperCase()} is empty or has an invalid file signature.` }); return; }
      const installerDir = path.join(artifactPath, "packages", job.installerId);
      await mkdir(installerDir, { recursive: true });
      const beforeStore = db.prepare("SELECT organization_id AS organizationId,status FROM installer_build_jobs WHERE id=?").get(upload[1]);
      if (!beforeStore || beforeStore.status !== "running") { send(res, 410, { error: "This installer build is no longer active.", code: "WORKSPACE_SUSPENDED" }); return; }
      if (!requireOrganizationEntitlement(beforeStore.organizationId, res, { kind: "worker" })) return;
      const fileName = extension === "msi" ? `FamilyRmmAgent-${job.agentVersion}.msi` : `FamilyRmmAgentSetup-${job.agentVersion}.exe`;
      await writeFile(path.join(installerDir, fileName), bytes, { flag: "w", mode: 0o640 });
      const finalJob = db.prepare("SELECT organization_id AS organizationId,status FROM installer_build_jobs WHERE id=?").get(upload[1]);
      if (!finalJob || finalJob.status !== "running") { send(res, 410, { error: "This installer build is no longer active.", code: "WORKSPACE_SUSPENDED" }); return; }
      if (!requireOrganizationEntitlement(finalJob.organizationId, res, { kind: "worker" })) return;
      const digest = createHash("sha256").update(bytes).digest("hex");
      const fields = extension === "msi" ? "msi_file=?,msi_sha256=?" : "setup_file=?,setup_sha256=?";
      db.exec("BEGIN IMMEDIATE");
      let ready = false;
      try {
        const commitJob = db.prepare("SELECT organization_id AS organizationId,status FROM installer_build_jobs WHERE id=?").get(upload[1]);
        if (!commitJob || commitJob.status !== "running" || !organizationEntitlement(commitJob.organizationId).allowed) {
          db.exec("ROLLBACK");
          requireOrganizationEntitlement(commitJob?.organizationId || finalJob.organizationId, res, { kind: "worker" });
          if (!res.headersSent) send(res, 410, { error: "This installer build is no longer active.", code: "WORKSPACE_SUSPENDED" });
          return;
        }
        db.prepare(`UPDATE installer_packages SET ${fields},signing_status='unsigned' WHERE id=? AND build_status='building'`).run(fileName, digest, job.installerId);
        const complete = db.prepare("SELECT msi_file,setup_file,msi_sha256,setup_sha256 FROM installer_packages WHERE id=?").get(job.installerId);
        ready = Boolean(complete.msi_file && complete.setup_file && complete.msi_sha256 && complete.setup_sha256);
        if (ready) {
          db.prepare("UPDATE installer_packages SET build_status='ready' WHERE id=? AND build_status='building'").run(job.installerId);
          const completed = db.prepare("UPDATE installer_build_jobs SET status='ready',updated_at=? WHERE id=? AND status='running'").run(new Date().toISOString(), job.id);
          if (completed.changes !== 1) throw new Error("Installer build is no longer active.");
          audit("installer.package_created", null, job.installerId, JSON.stringify({ grantId: job.grantId, signingStatus: "unsigned", uploadedByWorker: true }));
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* Transaction already closed. */ }
        throw error;
      }
      send(res, 200, { ok: true, format: extension, sha256: digest, bytes: bytes.length, ready }); return;
    }
    const failed = route.match(/^\/api\/installer-build-worker\/jobs\/([a-f0-9]{32})\/failed$/);
    if (failed && req.method === "POST") {
      let body;
      try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid build failure report." }); return; }
      const message = typeof body.error === "string" ? body.error.slice(0, 1500) : "Windows package build failed.";
      const job = db.prepare("SELECT installer_id AS installerId,organization_id AS organizationId,status FROM installer_build_jobs WHERE id=?").get(failed[1]);
      if (!job) { send(res, 404, { error: "Active installer build job not found." }); return; }
      if (!requireOrganizationEntitlement(job.organizationId, res, { kind: "worker" })) return;
      if (job.status !== "running") { send(res, 410, { error: "This installer build is no longer active." }); return; }
      const now = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db.prepare("SELECT organization_id AS organizationId,status FROM installer_build_jobs WHERE id=?").get(failed[1]);
        if (!current || current.status !== "running" || !organizationEntitlement(current.organizationId).allowed) {
          db.exec("ROLLBACK");
          requireOrganizationEntitlement(current?.organizationId || job.organizationId, res, { kind: "worker" });
          if (!res.headersSent) send(res, 410, { error: "This installer build is no longer active." });
          return;
        }
        db.prepare("UPDATE installer_build_jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'").run(message, now, failed[1]);
        db.prepare("UPDATE installer_packages SET build_status='failed',build_error=? WHERE id=? AND build_status='building'").run(message, job.installerId);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* Transaction already closed. */ }
        throw error;
      }
      send(res, 200, { ok: true }); return;
    }
    send(res, 404, { error: "Installer worker route not found." }); return;
  }

  const publicInstallerDownload = route.match(/^\/api\/public-installers\/([A-Za-z0-9_-]{32,50})\/(msi|exe)$/);
  if (publicInstallerDownload && req.method === "GET") {
    const item = publicInstallerRecord(publicInstallerDownload[1]);
    if (!publicInstallerUsable(item)) { send(res, 404, { error: "Installer package not found." }); return; }
    const format = publicInstallerDownload[2];
    const fileName = format === "msi" ? item.msi_file : item.setup_file;
    const expectedPrefix = path.resolve(artifactPath, "packages", item.id) + path.sep;
    const filePath = path.resolve(artifactPath, "packages", item.id, fileName || "");
    if (!fileName || !filePath.startsWith(expectedPrefix)) { send(res, 404, { error: "Installer artifact is missing." }); return; }
    try {
      const artifact = await readFile(filePath);
      const digest = createHash("sha256").update(artifact).digest("hex");
      const expectedDigest = format === "msi" ? item.msi_sha256 : item.setup_sha256;
      if (digest !== expectedDigest) { send(res, 503, { error: "Installer integrity check failed." }); return; }
      if (!publicInstallerUsable(item)) { send(res, 404, { error: "Installer package not found." }); return; }
      audit("installer.public_downloaded", null, item.id, JSON.stringify({ format, sha256: digest }));
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": artifact.length, "Content-Disposition": "attachment; filename=\"" + path.basename(fileName) + "\"", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      res.end(artifact);
    } catch { send(res, 404, { error: "Installer artifact is missing." }); }
    return;
  }

  const session = requireAdmin(req, res, { allowSuspended: route === "/api/auth/logout" });
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
  const hasManagementRights = session.role === "platform_owner" || session.role === "owner" || session.role === "administrator";
  if (route === "/api/installer-build-worker/status" && req.method === "GET") {
    if (session.role !== "platform_owner") { send(res, 403, { error: "Only the platform owner can manage the Windows installer worker." }); return; }
    const worker = db.prepare("SELECT last_seen AS lastSeen,disabled_at AS disabledAt FROM installer_build_workers WHERE id='primary'").get();
    send(res, 200, { paired: Boolean(worker && !worker.disabledAt), lastSeen: worker?.lastSeen || null }); return;
  }
  if (route === "/api/installer-build-worker/pair" && req.method === "POST") {
    if (session.role !== "platform_owner") { send(res, 403, { error: "Only the platform owner can pair the Windows installer worker." }); return; }
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO installer_build_workers(id,token_hash,created_at,last_seen,disabled_at) VALUES('primary',?,?,NULL,NULL)
      ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at,last_seen=NULL,disabled_at=NULL`).run(hashToken(token), now);
    db.prepare("UPDATE installer_build_jobs SET status='queued',claimed_at=NULL,updated_at=? WHERE status='running'").run(now);
    audit("installer.worker_paired", session.id, "primary");
    send(res, 201, { config: { serverUrl, workerToken: token }, fileName: "family-rmm-installer-worker.json" }); return;
  }
  if (route === "/api/installer-build-worker/pair" && req.method === "DELETE") {
    if (session.role !== "platform_owner") { send(res, 403, { error: "Only the platform owner can unpair the Windows installer worker." }); return; }
    db.prepare("UPDATE installer_build_workers SET disabled_at=? WHERE id='primary'").run(new Date().toISOString());
    db.prepare("UPDATE installer_build_jobs SET status='queued',claimed_at=NULL,updated_at=? WHERE status='running'").run(new Date().toISOString());
    audit("installer.worker_unpaired", session.id, "primary");
    send(res, 200, { ok: true }); return;
  }
  if (route === "/api/screenconnect/instances" && req.method === "GET") {
    const items = db.prepare(`SELECT id,name,base_url AS baseUrl,deployment_type AS deploymentType,version,
      credential_env_ref AS credentialReference,enabled,created_at AS createdAt,updated_at AS updatedAt
      FROM screenconnect_instances WHERE organization_id=? ORDER BY created_at DESC`).all(session.organization_id).map((item) => ({
        ...item, enabled: Boolean(item.enabled), credentialConfigured: Boolean(item.credentialReference && process.env[item.credentialReference]),
        integrationStatus: "awaiting_adapter", capabilities: [],
      }));
    send(res, 200, { items, adapterStatus: "configuration_only", message: "Session sync and remote launch require an approved ScreenConnect integration adapter for the instance version." }); return;
  }
  if (route === "/api/screenconnect/instances" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid ScreenConnect instance configuration." }); return; }
    if (!requireOrganizationEntitlement(session.organization_id, res)) return;
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
    let parsed;
    try { parsed = new URL(typeof body.baseUrl === "string" ? body.baseUrl.trim() : ""); } catch { parsed = null; }
    const deploymentType = body.deploymentType;
    const version = typeof body.version === "string" ? body.version.trim().slice(0, 80) : "";
    if (!name || !parsed || parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (deploymentType !== "cloud" && deploymentType !== "self_hosted")) {
      send(res, 400, { error: "Provide a name, canonical HTTPS instance URL, and cloud or self-hosted type." }); return;
    }
    const baseUrl = parsed.toString().replace(/\/$/, "");
    const id = randomBytes(16).toString("hex");
    const now = new Date().toISOString();
    try {
      db.prepare(`INSERT INTO screenconnect_instances(id,name,organization_id,base_url,deployment_type,version,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, name, session.organization_id, baseUrl, deploymentType, version || null, session.id, now, now);
    } catch (error) {
      if (String(error).includes("UNIQUE")) { send(res, 409, { error: "That ScreenConnect URL is already configured in this workspace." }); return; }
      throw error;
    }
    audit("screenconnect.instance_configured", session.id, id, JSON.stringify({ name, baseUrl, deploymentType, version: version || null }));
    send(res, 201, { id, name, baseUrl, deploymentType, version: version || null, enabled: true, credentialConfigured: false, integrationStatus: "awaiting_adapter", capabilities: [] }); return;
  }
  const screenConnectInstanceRoute = route.match(/^\/api\/screenconnect\/instances\/([a-f0-9]{32})$/);
  if (screenConnectInstanceRoute && req.method === "DELETE") {
    const result = db.prepare("DELETE FROM screenconnect_instances WHERE id=? AND organization_id=?").run(screenConnectInstanceRoute[1], session.organization_id);
    if (!result.changes) { send(res, 404, { error: "ScreenConnect instance not found." }); return; }
    audit("screenconnect.instance_removed", session.id, screenConnectInstanceRoute[1]);
    send(res, 200, { ok: true }); return;
  }
  if (route === "/api/licenses" && session.role !== "platform_owner") {
    send(res, 403, { error: "Only the platform owner can manage customer licenses." }); return;
  }
  if (route === "/api/licenses" && req.method === "GET") {
    const items = db.prepare(`SELECT l.id,l.label,l.device_limit AS deviceLimit,l.session_limit AS sessionLimit,l.status,l.created_at AS createdAt,l.redeemed_at AS redeemedAt,
      o.name AS workspaceName,(SELECT COUNT(*) FROM devices d WHERE d.organization_id=l.organization_id AND d.revoked_at IS NULL) AS activeDevices
      FROM licenses l LEFT JOIN organizations o ON o.id=l.organization_id ORDER BY l.created_at DESC LIMIT 500`).all();
    send(res, 200, { items }); return;
  }
  if (route === "/api/licenses" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid license request." }); return; }
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 100) : "";
    const deviceLimit = -1;
    const sessionLimit = -1;
    if (!label) { send(res, 400, { error: "Enter a license label." }); return; }
    const key = `FRMM-${randomBytes(18).toString("hex").toUpperCase()}`;
    const id = randomBytes(16).toString("hex");
    const createdAt = new Date().toISOString();
    db.prepare("INSERT INTO licenses(id,key_hash,label,device_limit,session_limit,status,created_by,created_at) VALUES(?,?,?,?,?,'available',?,?)")
      .run(id, hashToken(key), label, deviceLimit, sessionLimit, session.id, createdAt);
    audit("license.created", session.id, id, JSON.stringify({ label, deviceLimit, sessionLimit }));
    send(res, 201, { id, key, label, deviceLimit, sessionLimit, status: "available", createdAt }); return;
  }
  if (route === "/api/platform-settings/purchase-contact" && req.method === "POST") {
    if (session.role !== "platform_owner") { send(res, 403, { error: "Only the platform owner can change purchase contact details." }); return; }
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid purchase-contact setting." }); return; }
    const contact = typeof body.url === "string" ? body.url.trim() : "";
    if (contact.length > 500) { send(res, 400, { error: "The purchase contact link must be 500 characters or fewer." }); return; }
    if (contact) {
      let parsed;
      try { parsed = new URL(contact); } catch { parsed = null; }
      const validHttps = parsed?.protocol === "https:" && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
      const validEmail = parsed?.protocol === "mailto:" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.pathname);
      const validPhone = parsed?.protocol === "tel:" && /^\+?[0-9(). -]{7,32}$/.test(parsed.pathname);
      if (!validHttps && !validEmail && !validPhone) {
        send(res, 400, { error: "Use a secure https link, an email address (mailto:), or a phone number (tel:)." }); return;
      }
      db.prepare(`INSERT INTO platform_settings(key,value,updated_at) VALUES('license_purchase_contact',?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(contact, new Date().toISOString());
    } else {
      db.prepare("DELETE FROM platform_settings WHERE key='license_purchase_contact'").run();
    }
    audit("license.purchase_contact_updated", session.id, null, JSON.stringify({ configured: Boolean(contact) }));
    send(res, 200, { purchaseContact: contact }); return;
  }
  const revokeLicense = route.match(/^\/api\/licenses\/([a-f0-9]{32})\/revoke$/);
  if (revokeLicense && req.method === "POST" && session.role === "platform_owner") {
    const now = new Date().toISOString();
    let license;
    try {
      db.exec("BEGIN IMMEDIATE");
      license = db.prepare("SELECT organization_id FROM licenses WHERE id=? AND status!='revoked'").get(revokeLicense[1]);
      if (!license) { db.exec("ROLLBACK"); send(res, 404, { error: "Active license not found." }); return; }
      const revoked = db.prepare("UPDATE licenses SET status='revoked',revoked_at=? WHERE id=? AND status!='revoked'").run(now, revokeLicense[1]);
      if (revoked.changes !== 1) { db.exec("ROLLBACK"); send(res, 404, { error: "Active license not found." }); return; }
      if (license.organization_id) {
        const suspendedBuilds = db.prepare(`SELECT id AS jobId,installer_id AS installerId FROM installer_build_jobs
          WHERE organization_id=? AND status IN ('queued','running')`).all(license.organization_id);
        db.prepare(`UPDATE installer_build_jobs SET status='failed',error='Workspace suspended because its license was revoked.',updated_at=?
          WHERE organization_id=? AND status IN ('queued','running')`).run(now, license.organization_id);
        db.prepare(`UPDATE installer_packages SET build_status='failed',build_error='Workspace suspended because its license was revoked.'
          WHERE organization_id=? AND build_status='building'`).run(license.organization_id);
        for (const build of suspendedBuilds) {
          audit("installer.package_build_suspended", session.id, build.installerId, JSON.stringify({ jobId: build.jobId, reason: "workspace_suspended" }));
        }
      }
      audit("license.revoked", session.id, revokeLicense[1]);
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* Transaction already closed. */ }
      send(res, 500, { error: "License could not be revoked." }); return;
    }
    send(res, 200, { ok: true }); return;
  }
  const reactivateLicense = route.match(/^\/api\/licenses\/([a-f0-9]{32})\/reactivate$/);
  if (reactivateLicense && req.method === "POST") {
    if (session.role !== "platform_owner") { send(res, 403, { error: "Only the platform owner can reactivate customer licenses." }); return; }
    const now = new Date().toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      const license = db.prepare(`SELECT l.organization_id FROM licenses l
        JOIN organizations o ON o.id=l.organization_id AND o.license_id=l.id
        WHERE l.id=? AND l.status='revoked'`).get(reactivateLicense[1]);
      if (!license) { db.exec("ROLLBACK"); send(res, 404, { error: "Revoked customer license not found." }); return; }
      const restored = db.prepare("UPDATE licenses SET status='active',revoked_at=NULL WHERE id=? AND status='revoked'").run(reactivateLicense[1]);
      if (restored.changes !== 1) { db.exec("ROLLBACK"); send(res, 404, { error: "Revoked customer license not found." }); return; }
      audit("license.reactivated", session.id, reactivateLicense[1], JSON.stringify({ organizationId: license.organization_id, restoredAt: now }));
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* Transaction already closed. */ }
      send(res, 500, { error: "License could not be reactivated." }); return;
    }
    send(res, 200, { ok: true }); return;
  }
  if ((route.startsWith("/api/enrollment/") || route.startsWith("/api/installer-packages") || route.startsWith("/api/devices/") || route.startsWith("/api/deployment")) && !hasManagementRights) {
    send(res, 403, { error: "Your role cannot manage enrollment or devices." }); return;
  }
  if (route === "/api/deployment/catalog" && req.method === "GET") {
    const items = await getApplicationCatalog();
    send(res, 200, { items: items.map(({ id, name, publisher, version, description, packageType, available, deliveryNote, installerMode }) => ({ id, name, publisher, version, description, packageType: packageType || null, available, deliveryNote: deliveryNote || null, installerMode: installerMode || "direct" })) });
    return;
  }
  const catalogDeploy = route.match(/^\/api\/deployment\/catalog\/([a-z0-9-]+)\/deploy$/);
  if (catalogDeploy && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid catalog deployment request." }); return; }
    if (!requireOrganizationEntitlement(session.organization_id, res)) return;
    const deviceIds = Array.isArray(body.deviceIds) ? [...new Set(body.deviceIds)] : [];
    if (deviceIds.length < 1 || deviceIds.length > 500 || deviceIds.some((id) => typeof id !== "string" || !/^[A-Fa-f0-9-]{16,64}$/.test(id))) {
      send(res, 400, { error: "Choose 1–500 valid target computers." }); return;
    }
    const placeholders = deviceIds.map(() => "?").join(",");
    const devices = db.prepare(`SELECT id,agent_version AS version FROM devices WHERE organization_id=? AND revoked_at IS NULL AND enrollment_state='approved' AND id IN (${placeholders})`).all(session.organization_id, ...deviceIds);
    if (devices.length !== deviceIds.length) { send(res, 400, { error: "Every target must be an approved, non-revoked computer in your organization." }); return; }
    if (devices.some((device) => !supportsSoftwareDeployment(device.version))) { send(res, 409, { error: "Every target needs Family RMM Agent 0.2.4 or newer." }); return; }

    let application;
    const scheduledFor = body.scheduledFor === undefined || body.scheduledFor === null || body.scheduledFor === "" ? new Date() : new Date(body.scheduledFor);
    if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() < Date.now() - 60_000 || scheduledFor.getTime() > Date.now() + 365 * 24 * 60 * 60_000) {
      send(res, 400, { error: "Schedule catalog installs from now through the next 365 days." }); return;
    }
    try { application = await resolveCatalogApplication(catalogDeploy[1]); }
    catch (error) { send(res, 502, { error: `Could not resolve the current vendor package: ${String(error.message || "Catalog unavailable.").slice(0, 250)}` }); return; }
    if (!requireOrganizationEntitlement(session.organization_id, res)) return;
    let pkg = db.prepare(`SELECT id FROM software_packages WHERE organization_id=? AND catalog_app_id=? AND version=? AND sha256=? AND revoked_at IS NULL`).get(session.organization_id, application.id, application.version, application.expectedSha256);
    if (!pkg) {
      let downloaded;
      try { downloaded = await downloadCatalogInstaller(application); }
      catch (error) { send(res, 502, { error: `Vendor package validation failed: ${String(error.message || "Download failed.").slice(0, 250)}` }); return; }
      if (!requireOrganizationEntitlement(session.organization_id, res)) return;
      const id = randomBytes(16).toString("hex");
      const createdAt = new Date().toISOString();
      const fileName = `${id}.${application.packageType}`;
      const folder = path.join(artifactPath, "software-packages", id);
      let createdArtifact = false;
      try {
        pkg = db.prepare(`SELECT id FROM software_packages WHERE organization_id=? AND catalog_app_id=? AND version=? AND sha256=? AND revoked_at IS NULL`).get(session.organization_id, application.id, application.version, downloaded.sha256);
        if (!pkg) {
          await mkdir(folder, { recursive: true });
          if (!requireOrganizationEntitlement(session.organization_id, res)) { await rm(folder, { recursive: true, force: true }); return; }
          await writeFile(path.join(folder, fileName), downloaded.bytes, { flag: "wx", mode: 0o640 });
          createdArtifact = true;
          if (!requireOrganizationEntitlement(session.organization_id, res)) { await rm(folder, { recursive: true, force: true }); return; }
          db.exec("BEGIN IMMEDIATE");
          if (!organizationEntitlement(session.organization_id).allowed) throw Object.assign(new Error("Workspace suspended."), { workspaceSuspended: true });
          pkg = db.prepare(`SELECT id FROM software_packages WHERE organization_id=? AND catalog_app_id=? AND version=? AND sha256=? AND revoked_at IS NULL`).get(session.organization_id, application.id, application.version, downloaded.sha256);
          if (pkg) {
            db.exec("COMMIT");
            await rm(folder, { recursive: true, force: true });
          } else {
          db.prepare(`INSERT INTO software_packages(id,name,version,publisher,package_type,file_name,file_size,sha256,install_arguments_json,created_by,created_at,organization_id,catalog_app_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, application.name, application.version, application.publisher, application.packageType, fileName,
            downloaded.bytes.length, downloaded.sha256, JSON.stringify(application.installArguments), session.id, createdAt, session.organization_id, application.id);
          pkg = { id };
          audit("deployment.catalog_package_cached", session.id, id, JSON.stringify({ catalogAppId: application.id, version: application.version, sha256: downloaded.sha256 }));
          db.exec("COMMIT");
          }
        }
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
        if (createdArtifact) try { await rm(path.join(folder, fileName), { force: true }); } catch { /* Remove only this incomplete artifact. */ }
        if (error?.workspaceSuspended) { send(res, 423, { error: suspendedWorkspaceError, code: "WORKSPACE_SUSPENDED" }); return; }
        send(res, 500, { error: "Validated vendor package could not be stored." }); return;
      }
    }
    const jobId = randomBytes(16).toString("hex");
    const now = new Date().toISOString();
    const scheduledForIso = scheduledFor.toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      if (!organizationEntitlement(session.organization_id).allowed) { db.exec("ROLLBACK"); send(res, 423, { error: suspendedWorkspaceError, code: "WORKSPACE_SUSPENDED" }); return; }
      db.prepare("INSERT INTO deployment_jobs(id,package_id,action,timeout_seconds,created_by,created_at,scheduled_for,organization_id) VALUES(?,?,'install',1800,?,?,?,?)")
        .run(jobId, pkg.id, session.id, now, scheduledForIso, session.organization_id);
      const insertTarget = db.prepare("INSERT INTO deployment_targets(job_id,device_id,state,assigned_at) VALUES(?,?,'queued',?)");
      for (const id of deviceIds) insertTarget.run(jobId, id, now);
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
      send(res, 500, { error: "Catalog deployment could not be queued." }); return;
    }
    audit("deployment.job_created", session.id, jobId, JSON.stringify({ packageId: pkg.id, catalogAppId: application.id, deviceIds, action: "install", scheduledFor: scheduledForIso }));
    send(res, 201, { id: jobId, packageId: pkg.id, packageName: application.name, packageVersion: application.version, action: "install", status: "queued", targetCount: deviceIds.length, createdAt: now, scheduledFor: scheduledForIso });
    return;
  }
  if (route === "/api/deployment/packages" && req.method === "GET") {
    const items = db.prepare(`SELECT p.id,p.name,p.version,p.publisher,p.package_type AS packageType,p.file_size AS fileSize,p.sha256,
      p.install_arguments_json AS installArgumentsJson,p.created_at AS createdAt,p.revoked_at AS revokedAt,
      (SELECT COUNT(*) FROM deployment_jobs j WHERE j.package_id=p.id) AS deploymentCount
      FROM software_packages p WHERE p.organization_id=? ORDER BY p.created_at DESC LIMIT 200`).all(session.organization_id).map((item) => ({ ...item, installArguments: JSON.parse(item.installArgumentsJson) }));
    send(res, 200, { items }); return;
  }
  if (route === "/api/deployment/packages" && req.method === "POST") {
    const rawMetadata = String(req.headers["x-package-metadata"] || "");
    let metadata;
    try { metadata = JSON.parse(rawMetadata); } catch { send(res, 400, { error: "Package metadata must be valid JSON." }); return; }
    const name = typeof metadata?.name === "string" ? metadata.name.trim() : "";
    const version = typeof metadata?.version === "string" ? metadata.version.trim() : "";
    const publisher = typeof metadata?.publisher === "string" ? metadata.publisher.trim().slice(0, 200) : null;
    const packageType = metadata?.packageType;
    const args = metadata?.installArguments;
    if (!name || name.length > 200 || !version || version.length > 100 || !publisher || !["msi","exe"].includes(packageType) ||
      !Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== "string" || arg.length > 500 || /[\r\n\0]/.test(arg))) {
      send(res, 400, { error: "Provide a name, version, MSI or EXE type and up to 64 safe installer arguments." }); return;
    }
    if (packageType === "exe" && args.length === 0) {
      send(res, 400, { error: "EXE packages must include vendor-documented silent installation arguments so deployments do not open an interactive installer." }); return;
    }
    let bytes;
    try { bytes = await readRawBody(req, 250 * 1024 * 1024); } catch { send(res, 413, { error: "Software installers are limited to 250 MiB." }); return; }
    if (!requireOrganizationEntitlement(session.organization_id, res)) return;
    if (!bytes.length) { send(res, 400, { error: "Choose a non-empty installer package." }); return; }
    const expectedMagic = packageType === "msi" ? [0xd0,0xcf,0x11,0xe0] : [0x4d,0x5a];
    if (!expectedMagic.every((value, index) => bytes[index] === value)) { send(res, 400, { error: `The selected file is not a valid ${packageType.toUpperCase()} container.` }); return; }
    const id = randomBytes(16).toString("hex");
    const fileName = `${id}.${packageType}`;
    const folder = path.join(artifactPath, "software-packages", id);
    try {
      await mkdir(folder, { recursive: true });
      if (!requireOrganizationEntitlement(session.organization_id, res)) { await rm(folder, { recursive: true, force: true }); return; }
      await writeFile(path.join(folder, fileName), bytes, { flag: "wx" });
      if (!requireOrganizationEntitlement(session.organization_id, res)) { await rm(folder, { recursive: true, force: true }); return; }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const createdAt = new Date().toISOString();
      db.prepare(`INSERT INTO software_packages(id,name,version,publisher,package_type,file_name,file_size,sha256,install_arguments_json,created_by,created_at,organization_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, name, version, publisher, packageType, fileName, bytes.length, sha256, JSON.stringify(args), session.id, createdAt, session.organization_id);
      audit("deployment.package_uploaded", session.id, id, JSON.stringify({ name, version, packageType, fileSize: bytes.length, sha256 }));
      send(res, 201, { id, name, version, packageType, fileSize: bytes.length, sha256, createdAt });
    } catch {
      send(res, 500, { error: "Software package could not be stored." });
    }
    return;
  }
  if (route === "/api/deployment/scripts" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid script request." }); return; }
    if (!requireOrganizationEntitlement(session.organization_id, res)) return;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const version = typeof body.version === "string" ? body.version.trim() : "1";
    const scriptBody = typeof body.script === "string" ? body.script : "";
    if (!name || name.length > 200 || !version || version.length > 100 || !scriptBody.trim() || Buffer.byteLength(scriptBody) > 32 * 1024 || scriptBody.includes("\0")) {
      send(res, 400, { error: "Scripts require a name, version and 1–32 KiB of PowerShell source." }); return;
    }
    const id = randomBytes(16).toString("hex");
    const createdAt = new Date().toISOString();
    const sha256 = createHash("sha256").update(scriptBody).digest("hex");
    db.prepare(`INSERT INTO software_packages(id,name,version,package_type,file_size,sha256,install_arguments_json,script_body,created_by,created_at,organization_id)
      VALUES(?,?,?,'powershell',?,?,'[]',?,?,?,?)`).run(id, name, version, Buffer.byteLength(scriptBody), sha256, scriptBody, session.id, createdAt, session.organization_id);
    audit("deployment.script_created", session.id, id, JSON.stringify({ name, version, sha256 }));
    send(res, 201, { id, name, version, packageType: "powershell", fileSize: Buffer.byteLength(scriptBody), sha256, createdAt });
    return;
  }
  if (route === "/api/deployments" && req.method === "GET") {
    recoverExpiredDeploymentLeases();
    const jobs = db.prepare(`SELECT j.id,j.package_id AS packageId,j.retry_of_job_id AS retryOfJobId,j.action,j.timeout_seconds AS timeoutSeconds,j.created_at AS createdAt,
      COALESCE(j.scheduled_for,j.created_at) AS scheduledFor,j.cancelled_at AS cancelledAt,
      p.name AS packageName,p.version AS packageVersion,p.package_type AS packageType,
      COUNT(t.device_id) AS targetCount,SUM(CASE WHEN t.state='succeeded' THEN 1 ELSE 0 END) AS succeededCount,
      SUM(CASE WHEN t.state='failed' THEN 1 ELSE 0 END) AS failedCount,
      SUM(CASE WHEN t.state IN ('queued','delivered','running') THEN 1 ELSE 0 END) AS pendingCount
      FROM deployment_jobs j JOIN software_packages p ON p.id=j.package_id LEFT JOIN deployment_targets t ON t.job_id=j.id
      WHERE j.organization_id=? GROUP BY j.id ORDER BY j.created_at DESC LIMIT 100`).all(session.organization_id);
    const targets = db.prepare(`SELECT t.job_id AS jobId,t.device_id AS deviceId,d.name AS deviceName,t.state,t.assigned_at AS assignedAt,
      t.started_at AS startedAt,t.completed_at AS completedAt,t.exit_code AS exitCode,t.output,t.error,t.inventory_state AS inventoryState,
      t.inventory_error AS inventoryError,t.verification_state AS verificationState,t.installed_version AS installedVersion,t.reboot_required AS rebootRequired
      FROM deployment_targets t JOIN devices d ON d.id=t.device_id WHERE t.job_id=? ORDER BY d.name`);
    send(res, 200, { items: jobs.map((job) => ({ ...job, targets: targets.all(job.id) })) }); return;
  }
  if (route === "/api/deployments" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid deployment request." }); return; }
    if (!requireOrganizationEntitlement(session.organization_id, res)) return;
    const packageId = typeof body.packageId === "string" ? body.packageId : "";
    const deviceIds = Array.isArray(body.deviceIds) ? [...new Set(body.deviceIds)] : [];
    const action = body.action === "update" ? "update" : body.action === "script" ? "script" : "install";
    const timeoutSeconds = Number.isInteger(body.timeoutSeconds) ? Math.max(30, Math.min(3600, body.timeoutSeconds)) : 1800;
    const scheduledFor = body.scheduledFor === undefined || body.scheduledFor === null || body.scheduledFor === "" ? new Date() : new Date(body.scheduledFor);
    if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() < Date.now() - 60_000 || scheduledFor.getTime() > Date.now() + 365 * 24 * 60 * 60_000) {
      send(res, 400, { error: "Schedule deployments from now through the next 365 days." }); return;
    }
    const softwarePackage = db.prepare("SELECT id,name,version,package_type AS packageType,revoked_at AS revokedAt FROM software_packages WHERE id=? AND organization_id=?").get(packageId, session.organization_id);
    if (!softwarePackage || softwarePackage.revokedAt || !/^[a-f0-9]{32}$/.test(packageId) || deviceIds.length < 1 || deviceIds.length > 500 || deviceIds.some((id) => typeof id !== "string" || !/^[A-Fa-f0-9-]{16,64}$/.test(id))) {
      send(res, 400, { error: "Choose an active package and 1–500 valid target devices." }); return;
    }
    if ((softwarePackage.packageType === "powershell") !== (action === "script")) { send(res, 400, { error: "Choose the action that matches this package type." }); return; }
    const placeholders = deviceIds.map(() => "?").join(",");
    const devices = db.prepare(`SELECT id FROM devices WHERE organization_id=? AND revoked_at IS NULL AND enrollment_state='approved' AND id IN (${placeholders})`).all(session.organization_id, ...deviceIds);
    if (devices.length !== deviceIds.length) { send(res, 400, { error: "Every target must be an approved, non-revoked device." }); return; }
    const versions = db.prepare(`SELECT agent_version AS version FROM devices WHERE organization_id=? AND id IN (${placeholders})`).all(session.organization_id, ...deviceIds);
    if (versions.some((device) => !supportsSoftwareDeployment(device.version))) { send(res, 409, { error: "Every target needs Family RMM Agent 0.2.4 or newer. Update older agents before queuing deployments." }); return; }
    if (action === "update") {
      if (!["msi","exe"].includes(softwarePackage.packageType)) { send(res, 400, { error: "Only MSI and EXE packages can update installed applications." }); return; }
      const installed = new Set(db.prepare(`SELECT DISTINCT device_id AS deviceId FROM software_inventory WHERE name=? COLLATE NOCASE AND device_id IN (${placeholders})`).all(softwarePackage.name, ...deviceIds).map((row) => row.deviceId));
      const missing = deviceIds.filter((id) => !installed.has(id));
      if (missing.length) { send(res, 409, { error: `Update requires ${softwarePackage.name} to appear in software inventory on every selected computer.` }); return; }
    }
    const jobId = randomBytes(16).toString("hex");
    const now = new Date().toISOString();
    const scheduledForIso = scheduledFor.toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      if (!organizationEntitlement(session.organization_id).allowed) { db.exec("ROLLBACK"); send(res, 423, { error: suspendedWorkspaceError, code: "WORKSPACE_SUSPENDED" }); return; }
      db.prepare("INSERT INTO deployment_jobs(id,package_id,action,timeout_seconds,created_by,created_at,scheduled_for,organization_id) VALUES(?,?,?,?,?,?,?,?)").run(jobId, packageId, action, timeoutSeconds, session.id, now, scheduledForIso, session.organization_id);
      const insertTarget = db.prepare("INSERT INTO deployment_targets(job_id,device_id,state,assigned_at) VALUES(?,?,'queued',?)");
      for (const id of deviceIds) insertTarget.run(jobId, id, now);
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
      send(res, 500, { error: "Deployment could not be queued." }); return;
    }
    audit("deployment.job_created", session.id, jobId, JSON.stringify({ packageId, deviceIds, action, scheduledFor: scheduledForIso }));
    send(res, 201, { id: jobId, packageId, action, status: "queued", targetCount: deviceIds.length, createdAt: now, scheduledFor: scheduledForIso });
    return;
  }
  const retryDeployment = route.match(/^\/api\/deployments\/([a-f0-9]{32})\/retry$/);
  if (retryDeployment && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid deployment retry request." }); return; }
    if (!requireOrganizationEntitlement(session.organization_id, res)) return;
    const source = db.prepare(`SELECT j.id,j.package_id AS packageId,j.action,j.timeout_seconds AS timeoutSeconds,p.revoked_at AS packageRevoked
      FROM deployment_jobs j JOIN software_packages p ON p.id=j.package_id WHERE j.id=? AND j.organization_id=?`).get(retryDeployment[1], session.organization_id);
    if (!source) { send(res, 404, { error: "Deployment job not found." }); return; }
    if (source.packageRevoked) { send(res, 409, { error: "This package has been revoked and cannot be retried." }); return; }
    const failedTargets = db.prepare("SELECT device_id AS deviceId FROM deployment_targets WHERE job_id=? AND state='failed' AND retryable=1").all(source.id).map((item) => item.deviceId);
    const requestedIds = body.targetDeviceIds === undefined ? failedTargets : Array.isArray(body.targetDeviceIds) ? [...new Set(body.targetDeviceIds)] : null;
    if (!requestedIds || requestedIds.length === 0 || requestedIds.some((id) => typeof id !== "string" || !failedTargets.includes(id))) {
      send(res, 400, { error: "Retry can target only failed computers from this deployment." }); return;
    }
    const placeholders = requestedIds.map(() => "?").join(",");
    const devices = db.prepare(`SELECT id,agent_version AS version FROM devices WHERE organization_id=? AND revoked_at IS NULL AND enrollment_state='approved' AND id IN (${placeholders})`).all(session.organization_id, ...requestedIds);
    if (devices.length !== requestedIds.length) { send(res, 409, { error: "A failed target is no longer approved in this organization." }); return; }
    if (devices.some((device) => !supportsSoftwareDeployment(device.version))) { send(res, 409, { error: "Every retry target needs Family RMM Agent 0.2.4 or newer." }); return; }
    const id = randomBytes(16).toString("hex"), now = new Date().toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      if (!organizationEntitlement(session.organization_id).allowed) { db.exec("ROLLBACK"); send(res, 423, { error: suspendedWorkspaceError, code: "WORKSPACE_SUSPENDED" }); return; }
      db.prepare("INSERT INTO deployment_jobs(id,package_id,action,timeout_seconds,created_by,created_at,scheduled_for,organization_id,retry_of_job_id) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id, source.packageId, source.action, source.timeoutSeconds, session.id, now, now, session.organization_id, source.id);
      const insertTarget = db.prepare("INSERT INTO deployment_targets(job_id,device_id,state,assigned_at) VALUES(?,?,'queued',?)");
      for (const deviceId of requestedIds) insertTarget.run(id, deviceId, now);
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
      send(res, 500, { error: "Failed targets could not be retried." }); return;
    }
    audit("deployment.job_retried", session.id, id, JSON.stringify({ retryOfJobId: source.id, deviceIds: requestedIds }));
    send(res, 201, { id, retryOfJobId: source.id, status: "queued", targetCount: requestedIds.length, createdAt: now, scheduledFor: now });
    return;
  }
  const cancelDeployment = route.match(/^\/api\/deployments\/([a-f0-9]{32})\/cancel$/);
  if (cancelDeployment && req.method === "POST") {
    const now = new Date().toISOString();
    const job = db.prepare("SELECT id FROM deployment_jobs WHERE id=? AND organization_id=?").get(cancelDeployment[1], session.organization_id);
    if (!job) { send(res, 404, { error: "Deployment job not found." }); return; }
    const changed = db.prepare("UPDATE deployment_targets SET state='cancelled',completed_at=?,error='Cancelled by an administrator before the agent started execution.' WHERE job_id=? AND state='queued'").run(now, job.id);
    if (!changed.changes) { send(res, 409, { error: "No queued targets remain to cancel. Delivered or running work is not interrupted." }); return; }
    const active = db.prepare("SELECT COUNT(*) AS count FROM deployment_targets WHERE job_id=? AND state IN ('queued','delivered','running')").get(job.id).count;
    if (active === 0) db.prepare("UPDATE deployment_jobs SET cancelled_at=? WHERE id=?").run(now, job.id);
    audit("deployment.job_cancelled", session.id, job.id, JSON.stringify({ cancelledTargets: changed.changes, activeTargets: active }));
    send(res, 200, { ok: true, cancelledTargets: changed.changes, activeTargets: active });
    return;
  }
  const revokeSoftware = route.match(/^\/api\/deployment\/packages\/([a-f0-9]{32})\/revoke$/);
  if (revokeSoftware && req.method === "POST") {
    const now = new Date().toISOString();
    const changed = db.prepare("UPDATE software_packages SET revoked_at=? WHERE id=? AND organization_id=? AND revoked_at IS NULL").run(now, revokeSoftware[1], session.organization_id);
    if (!changed.changes) { send(res, 404, { error: "Active software package not found." }); return; }
    db.prepare("UPDATE deployment_targets SET state='cancelled',completed_at=?,error='Package revoked before execution.' WHERE job_id IN (SELECT id FROM deployment_jobs WHERE package_id=?) AND state='queued'").run(now, revokeSoftware[1]);
    audit("deployment.package_revoked", session.id, revokeSoftware[1]);
    send(res, 200, { ok: true }); return;
  }
  if (route === "/api/enrollment/policies" && req.method === "GET") {
    const policies = db.prepare(`SELECT p.id,p.name,p.max_devices AS maxDevices,p.expires_in_hours AS expiresInHours,p.approval_mode AS approvalMode,
      p.allowed_os_json AS allowedOperatingSystems,p.created_at AS createdAt,p.revoked_at AS revokedAt,
      (SELECT COUNT(*) FROM enrollment_grants g WHERE g.policy_id=p.id AND g.revoked_at IS NULL AND g.expires_at>?) AS activeGrants
      FROM enrollment_policies p WHERE p.organization_id=? ORDER BY p.created_at DESC`).all(new Date().toISOString(), session.organization_id).map((p) => ({ ...p, allowedOperatingSystems: JSON.parse(p.allowedOperatingSystems) }));
    send(res, 200, { items: policies }); return;
  }
  if (route === "/api/enrollment/policies" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid policy request." }); return; }
    if (!requireOrganizationEntitlement(session.organization_id, res)) return;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const expiresInHours = Number(body.expiresInHours);
    const approvalMode = body.approvalMode === "approval" ? "approval" : body.approvalMode === "automatic" ? "automatic" : "";
    const operatingSystems = Array.isArray(body.allowedOperatingSystems) ? body.allowedOperatingSystems : ["Windows"];
    const maxDevices = -1;
    if (!name || name.length > 100 || !Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 8760 || !approvalMode || operatingSystems.length > 10 || operatingSystems.some((os) => typeof os !== "string" || os.trim().length < 2 || os.trim().length > 32)) {
      send(res, 400, { error: "Enter a name, expiry from 1 to 8,760 hours, an approval mode and up to ten allowed OS values." }); return;
    }
    const id = randomBytes(16).toString("hex");
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO enrollment_policies(id,name,max_devices,expires_in_hours,approval_mode,allowed_os_json,created_by,created_at,organization_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, name, maxDevices, expiresInHours, approvalMode, JSON.stringify(operatingSystems.map((os) => os.trim())), session.id, now, session.organization_id);
    audit("enrollment.policy_created", session.id, id, JSON.stringify({ maxDevices, expiresInHours, approvalMode }));
    send(res, 201, { id, name, maxDevices, expiresInHours, approvalMode, allowedOperatingSystems: operatingSystems, createdAt: now }); return;
  }
  const policyRevoke = route.match(/^\/api\/enrollment\/policies\/([a-f0-9]{32})\/revoke$/);
  if (policyRevoke && req.method === "POST") {
    const result = db.prepare("UPDATE enrollment_policies SET revoked_at=? WHERE id=? AND organization_id=? AND revoked_at IS NULL").run(new Date().toISOString(), policyRevoke[1], session.organization_id);
    if (!result.changes) { send(res, 404, { error: "Policy not found or already revoked." }); return; }
    db.prepare("UPDATE enrollment_grants SET revoked_at=? WHERE policy_id=? AND organization_id=? AND revoked_at IS NULL").run(new Date().toISOString(), policyRevoke[1], session.organization_id);
    audit("enrollment.policy_revoked", session.id, policyRevoke[1]);
    send(res, 200, { ok: true }); return;
  }
  const grantCollection = route === "/api/enrollment/grants";
  if (grantCollection && req.method === "GET") {
    const items = db.prepare(`SELECT g.id,g.policy_id AS policyId,p.name AS policyName,g.max_uses AS maxUses,g.used_count AS usedCount,
      g.expires_at AS expiresAt,g.created_at AS createdAt,g.revoked_at AS revokedAt FROM enrollment_grants g
      JOIN enrollment_policies p ON p.id=g.policy_id WHERE p.organization_id=? ORDER BY g.created_at DESC`).all(session.organization_id);
    send(res, 200, { items }); return;
  }
  const issueGrant = route.match(/^\/api\/enrollment\/policies\/([a-f0-9]{32})\/grants$/);
  if (issueGrant && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid grant request." }); return; }
    if (!requireOrganizationEntitlement(session.organization_id, res)) return;
    let issued;
    try {
      db.exec("BEGIN IMMEDIATE");
      const policy = db.prepare("SELECT * FROM enrollment_policies WHERE id=? AND organization_id=? AND revoked_at IS NULL").get(issueGrant[1], session.organization_id);
      if (!policy) { db.exec("ROLLBACK"); send(res, 404, { error: "Active enrollment policy not found." }); return; }
      const nowIso = new Date().toISOString();
      const maxUses = -1;
      const hours = body.expiresInHours === undefined ? policy.expires_in_hours : Number(body.expiresInHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > policy.expires_in_hours) {
        db.exec("ROLLBACK"); send(res, 400, { error: "Enrollment authorization expiry must fit the policy." }); return;
      }
      const id = randomBytes(16).toString("hex");
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + hours * 60 * 60_000).toISOString();
      const manifest = { version: 1, grantId: id, policyId: policy.id, organizationId: session.organization_id, serverUrl, audience: serverUrl, issuedAt: createdAt, expiresAt,
        maxUses, allowedOperatingSystems: JSON.parse(policy.allowed_os_json), approvalMode: policy.approval_mode };
      const signature = signManifest(manifest);
      db.prepare(`INSERT INTO enrollment_grants(id,policy_id,manifest_json,signature,max_uses,expires_at,created_by,created_at,organization_id)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, policy.id, canonicalJson(manifest), signature, maxUses, expiresAt, session.id, createdAt, session.organization_id);
      audit("enrollment.grant_created", session.id, id, JSON.stringify({ policyId: policy.id, maxUses, expiresAt }));
      db.exec("COMMIT");
      issued = { id, policyId: policy.id, createdAt, expiresAt, maxUses, usedCount: 0, enrollmentGrant: { manifest, signature } };
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
      send(res, 500, { error: "Enrollment authorization could not be issued." }); return;
    }
    send(res, 201, issued); return;
  }
  const localInstallerConfig = route.match(/^\/api\/enrollment\/grants\/([a-f0-9]{32})\/installer-config$/);
  if (localInstallerConfig && req.method === "GET") {
    const grant = db.prepare(`SELECT g.*,p.revoked_at AS policy_revoked_at FROM enrollment_grants g
      JOIN enrollment_policies p ON p.id=g.policy_id WHERE g.id=? AND g.organization_id=?`).get(localInstallerConfig[1], session.organization_id);
    if (!grant || grant.revoked_at || grant.policy_revoked_at || Date.parse(grant.expires_at) <= Date.now()) {
      send(res, 404, { error: "Active enrollment authorization not found." }); return;
    }
    audit("enrollment.local_installer_config_downloaded", session.id, grant.id, JSON.stringify({ policyId: grant.policy_id }));
    send(res, 200, { serverUrl, agentVersion: "0.2.4", taskSigningPublicKey: enrollmentPublicKey,
      enrollmentGrant: { manifest: JSON.parse(grant.manifest_json), signature: grant.signature } }); return;
  }
  const grantRevoke = route.match(/^\/api\/enrollment\/grants\/([a-f0-9]{32})\/revoke$/);
  if (grantRevoke && req.method === "POST") {
    const result = db.prepare("UPDATE enrollment_grants SET revoked_at=? WHERE id=? AND organization_id=? AND revoked_at IS NULL").run(new Date().toISOString(), grantRevoke[1], session.organization_id);
    if (!result.changes) { send(res, 404, { error: "Grant not found or already revoked." }); return; }
    audit("enrollment.grant_revoked", session.id, grantRevoke[1]);
    send(res, 200, { ok: true }); return;
  }
  if (route === "/api/enrollment/pending" && req.method === "GET") {
    const items = db.prepare(`SELECT d.id,d.name,d.operating_system AS operatingSystem,d.os_version AS osVersion,d.enrolled_at AS requestedAt,
      COALESCE(p.name,'Windows agent authorization') AS policyName,c.grant_id AS grantId FROM devices d
      LEFT JOIN enrollment_claims c ON c.device_id=d.id LEFT JOIN enrollment_grants g ON g.id=c.grant_id
      LEFT JOIN enrollment_policies p ON p.id=g.policy_id WHERE d.enrollment_state='pending' AND d.organization_id=? ORDER BY d.enrolled_at`).all(session.organization_id);
    send(res, 200, { items }); return;
  }
  const reviewClaim = route.match(/^\/api\/enrollment\/pending\/([A-Fa-f0-9-]{16,64})\/(approve|reject)$/);
  if (reviewClaim && req.method === "POST") {
    const [, deviceId, action] = reviewClaim;
    const claim = db.prepare("SELECT c.* FROM devices d LEFT JOIN enrollment_claims c ON c.device_id=d.id WHERE d.id=? AND d.enrollment_state='pending' AND d.organization_id=?").get(deviceId, session.organization_id);
    if (!claim) { send(res, 404, { error: "Pending enrollment request not found." }); return; }
    if (action === "approve") {
      if (claim.grant_id) db.prepare("UPDATE enrollment_claims SET state='approved',reviewed_by=?,reviewed_at=? WHERE device_id=?").run(session.id, new Date().toISOString(), deviceId);
      db.prepare("UPDATE devices SET enrollment_state='approved' WHERE id=? AND organization_id=? AND revoked_at IS NULL").run(deviceId, session.organization_id);
      audit("enrollment.device_approved", session.id, deviceId, JSON.stringify({ grantId: claim.grant_id }));
      send(res, 200, { ok: true, status: "approved" }); return;
    }
    if (claim.grant_id) db.prepare("UPDATE enrollment_claims SET state='rejected',reviewed_by=?,reviewed_at=? WHERE device_id=?").run(session.id, new Date().toISOString(), deviceId);
    db.prepare("UPDATE devices SET enrollment_state='rejected',revoked_at=? WHERE id=? AND organization_id=?").run(new Date().toISOString(), deviceId, session.organization_id);
    audit("enrollment.device_rejected", session.id, deviceId, JSON.stringify({ grantId: claim.grant_id }));
    send(res, 200, { ok: true, status: "rejected" }); return;
  }
  const revokeDevice = route.match(/^\/api\/devices\/([A-Fa-f0-9-]{16,64})\/revoke$/);
  if (revokeDevice && req.method === "POST") {
    const result = db.prepare("UPDATE devices SET revoked_at=? WHERE id=? AND organization_id=? AND revoked_at IS NULL").run(new Date().toISOString(), revokeDevice[1], session.organization_id);
    if (!result.changes) { send(res, 404, { error: "Device not found or already revoked." }); return; }
    audit("device.revoked", session.id, revokeDevice[1]);
    send(res, 200, { ok: true }); return;
  }
  if (route === "/api/installer-packages" && req.method === "GET") {
    const now = new Date().toISOString();
    const items = db.prepare(`SELECT i.id,i.grant_id AS grantId,i.agent_version AS agentVersion,i.build_status AS buildStatus,i.generic,
      i.msi_file AS msiFile,i.setup_file AS setupFile,i.signing_status AS signingStatus,i.msi_sha256 AS msiSha256,i.setup_sha256 AS setupSha256,i.build_error AS buildError,i.created_at AS createdAt,i.revoked_at AS revokedAt,
      g.max_uses AS maxUses,g.used_count AS usedCount,g.expires_at AS expiresAt,g.revoked_at AS grantRevokedAt,p.name AS policyName
      FROM installer_packages i JOIN enrollment_grants g ON g.id=i.grant_id JOIN enrollment_policies p ON p.id=g.policy_id
      WHERE p.organization_id=? ORDER BY i.created_at DESC LIMIT 100`).all(session.organization_id);
    const withSizes = await Promise.all(items.map(async (item) => {
      const directory = path.join(artifactPath, "packages", item.id);
      const [msi, exe] = await Promise.all([item.msiFile, item.setupFile].map(async (name) => {
        if (!name) return null;
        try { return (await stat(path.join(directory, name))).size; } catch { return null; }
      }));
      return { ...item, msiSizeBytes: msi, exeSizeBytes: exe,
        status: item.buildStatus, downloads: { page: `/install/${item.id}`, msi: `/api/public-installers/${item.id}/msi`, exe: `/api/public-installers/${item.id}/exe` } };
    }));
    if (!requireOrganizationEntitlement(session.organization_id, res)) return;
    send(res, 200, { items: withSizes });
    return;
  }
  const shareInstaller = route.match(/^\/api\/installer-packages\/([a-f0-9]{32})\/share$/);
  if (shareInstaller && req.method === "POST") {
    const item = db.prepare("SELECT id,organization_id AS entitlement_organization_id,build_status,revoked_at FROM installer_packages WHERE id=? AND organization_id=?").get(shareInstaller[1], session.organization_id);
    if (!publicInstallerUsable(item)) { send(res, 409, { error: "Build the Windows installer first." }); return; }
    audit("installer.share_link_copied", session.id, item.id);
    send(res, 200, { url: serverUrl + "/install/" + item.id, downloads: { msi: `/api/public-installers/${item.id}/msi`, exe: `/api/public-installers/${item.id}/exe` } });
    return;
  }
  if (route === "/api/installer-packages" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { send(res, 400, { error: "Invalid installer request." }); return; }
    if (!requireOrganizationEntitlement(session.organization_id, res)) return;
    const generic = body.generic === true;
    const grantId = generic ? ensureWorkspaceInstallerGrant(session).grant.id : typeof body.grantId === "string" ? body.grantId : "";
    if (!/^[a-f0-9]{32}$/.test(grantId)) { send(res, 400, { error: "A valid installer configuration is required." }); return; }
    const grant = db.prepare(`SELECT g.*,p.name AS policy_name,p.revoked_at AS policy_revoked_at
      FROM enrollment_grants g JOIN enrollment_policies p ON p.id=g.policy_id WHERE g.id=? AND g.organization_id=?`).get(grantId, session.organization_id);
    if (!grant || (!generic && (grant.revoked_at || grant.policy_revoked_at || Date.parse(grant.expires_at) <= Date.now()))) {
      send(res, 409, { error: "This enrollment authorization is expired, revoked, or has no remaining device slots." }); return;
    }
    const id = randomBytes(16).toString("hex");
    const agentVersion = process.env.RMM_AGENT_VERSION || "0.2.4";
    const createdAt = new Date().toISOString();
    const outputDir = path.join(artifactPath, "packages", id);
    const configPath = path.join(outputDir, "package-config.json");
    await mkdir(outputDir, { recursive: true });
    if (!requireOrganizationEntitlement(session.organization_id, res)) { await rm(outputDir, { recursive: true, force: true }); return; }
    // Generic downloads still need a signed, workspace-scoped authorization.
    // The grant only permits a pending enrollment request; administrator
    // approval is still required before the agent can check in or run jobs.
    // Omitting it made the agent use the legacy unscoped request path, which
    // attached every install to the default organization instead of the
    // workspace that generated the installer.
    const packageConfig = {
      serverUrl,
      agentVersion,
      taskSigningPublicKey: enrollmentPublicKey,
      enrollmentGrant: { manifest: JSON.parse(grant.manifest_json), signature: grant.signature },
    };
    await writeFile(configPath, JSON.stringify(packageConfig, null, 2), { flag: "wx" });
    if (!requireOrganizationEntitlement(session.organization_id, res)) { await rm(outputDir, { recursive: true, force: true }); return; }
    db.prepare(`INSERT INTO installer_packages(id,grant_id,agent_version,build_status,created_by,created_at,organization_id,generic) VALUES(?,?,?,'building',?,?,?,?)`)
      .run(id, grantId, agentVersion, session.id, createdAt, session.organization_id, generic ? 1 : 0);
    if (process.env.RMM_ENV === "production") {
      const jobId = randomBytes(16).toString("hex");
      db.prepare(`INSERT INTO installer_build_jobs(id,installer_id,grant_id,organization_id,status,created_at,updated_at,generic)
        VALUES(?,?,?,?, 'queued', ?, ?, ?)`).run(jobId, id, grantId, session.organization_id, createdAt, createdAt, generic ? 1 : 0);
      audit("installer.package_queued", session.id, id, JSON.stringify({ grantId, agentVersion, signingStatus: "unsigned", jobId, generic, localBuild: true }));
      send(res, 202, { id, grantId, agentVersion, status: "building", signingStatus: "unsigned", jobId, createdAt });
      startLocalInstallerBuildLoop();
      return;
    }
    try {
      execFileSync(process.execPath, [path.join(root, "scripts", "build-agent-package.mjs")], {
        cwd: root,
        env: { ...process.env, RMM_PACKAGE_CONFIG_PATH: configPath, RMM_PACKAGE_DIR: outputDir, RMM_PACKAGE_VERSION: agentVersion },
        encoding: "utf8", windowsHide: true, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024,
      });
      const buildInfo = JSON.parse(await readFile(path.join(outputDir, "build-info.json"), "utf8"));
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!organizationEntitlement(session.organization_id).allowed) {
          db.exec("ROLLBACK");
          await rm(outputDir, { recursive: true, force: true });
          send(res, 423, { error: suspendedWorkspaceError, code: "WORKSPACE_SUSPENDED" });
          return;
        }
        const published = db.prepare(`UPDATE installer_packages SET build_status='ready',signing_status=?,msi_file=?,setup_file=?,msi_sha256=?,setup_sha256=?
          WHERE id=? AND organization_id=? AND build_status='building'`)
          .run(buildInfo.signingStatus, buildInfo.installer.file, buildInfo.setup.file, buildInfo.installer.sha256, buildInfo.setup.sha256, id, session.organization_id);
        if (published.changes !== 1) throw new Error("Installer package is no longer building.");
        audit("installer.package_created", session.id, id, JSON.stringify({ grantId, agentVersion, signingStatus: buildInfo.signingStatus }));
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* Transaction already closed. */ }
        throw error;
      }
      send(res, 201, { id, grantId, agentVersion, status: "ready", signingStatus: buildInfo.signingStatus, createdAt, generic,
        msiSha256: buildInfo.installer.sha256, setupSha256: buildInfo.setup.sha256,
        downloads: { msi: `/api/installer-packages/${id}/msi`, exe: `/api/installer-packages/${id}/exe` } });
    } catch (error) {
      const message = String(error?.message || "Installer build failed.").slice(0, 1500);
      const failed = db.prepare("UPDATE installer_packages SET build_status='failed',build_error=? WHERE id=? AND build_status='building'").run(message, id);
      if (failed.changes) audit("installer.package_build_failed", session.id, id, JSON.stringify({ grantId, reason: message.slice(0, 400) }));
      send(res, 500, { error: "Windows installer build failed. Review the package status and server build log." });
    }
    return;
  }
  const packageDownload = route.match(/^\/api\/installer-packages\/([a-f0-9]{32})\/(msi|exe)$/);
  if (packageDownload && req.method === "GET") {
    const item = db.prepare(`SELECT i.*,g.expires_at,g.used_count,g.max_uses,g.revoked_at AS grant_revoked,p.revoked_at AS policy_revoked
      FROM installer_packages i JOIN enrollment_grants g ON g.id=i.grant_id JOIN enrollment_policies p ON p.id=g.policy_id WHERE i.id=? AND p.organization_id=?`).get(packageDownload[1], session.organization_id);
    if (!publicInstallerUsable(item)) { send(res, 404, { error: "Installer package is not available." }); return; }
    const fileName = packageDownload[2] === "msi" ? item.msi_file : item.setup_file;
    const expectedPrefix = path.resolve(artifactPath, "packages", item.id) + path.sep;
    const filePath = path.resolve(artifactPath, "packages", item.id, fileName || "");
    if (!filePath.startsWith(expectedPrefix) || !fileName) { send(res, 404, { error: "Installer artifact is missing." }); return; }
    try {
      const artifact = await readFile(filePath);
      const digest = createHash("sha256").update(artifact).digest("hex");
      const expectedDigest = packageDownload[2] === "msi" ? item.msi_sha256 : item.setup_sha256;
      if (digest !== expectedDigest) { send(res, 503, { error: "Installer integrity check failed." }); return; }
      if (!requireOrganizationEntitlement(session.organization_id, res)) return;
      audit("installer.package_downloaded", session.id, item.id, JSON.stringify({ format: packageDownload[2], sha256: digest }));
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": artifact.length, "Content-Disposition": `attachment; filename="${path.basename(fileName)}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(artifact);
    } catch { send(res, 404, { error: "Installer artifact is missing." }); }
    return;
  }
  const revokePackage = route.match(/^\/api\/installer-packages\/([a-f0-9]{32})\/revoke$/);
  if (revokePackage && req.method === "POST") {
    const item = db.prepare("SELECT grant_id FROM installer_packages WHERE id=? AND organization_id=? AND revoked_at IS NULL").get(revokePackage[1], session.organization_id);
    if (!item) { send(res, 404, { error: "Active installer package not found." }); return; }
    const now = new Date().toISOString();
    db.prepare("UPDATE enrollment_grants SET revoked_at=? WHERE id=? AND organization_id=? AND revoked_at IS NULL").run(now, item.grant_id, session.organization_id);
    db.prepare("UPDATE installer_packages SET revoked_at=? WHERE grant_id=? AND organization_id=? AND revoked_at IS NULL").run(now, item.grant_id, session.organization_id);
    audit("installer.package_revoked", session.id, revokePackage[1], JSON.stringify({ grantId: item.grant_id }));
    send(res, 200, { ok: true }); return;
  }
  if (route === "/api/overview" && req.method === "GET") {
    const rows = db.prepare("SELECT last_seen, revoked_at, enrollment_state FROM devices WHERE organization_id=?").all(session.organization_id);
    const managed = rows.filter((r) => !r.revoked_at && r.enrollment_state === "approved");
    const live = managed.filter((r) => isOnline(r.last_seen)).length;
    const revoked = rows.filter((r) => Boolean(r.revoked_at)).length;
    const series = db.prepare(`SELECT strftime('%Y-%m-%dT%H:00:00Z', recorded_at) AS hour,
      ROUND(AVG(cpu_percent),1) AS cpu, ROUND(AVG(memory_percent),1) AS memory
      FROM metric_samples m JOIN devices d ON d.id=m.device_id WHERE m.recorded_at >= ? AND d.organization_id=? GROUP BY hour ORDER BY hour`).all(new Date(Date.now() - 24 * 60 * 60_000).toISOString(), session.organization_id);
    const latest = db.prepare("SELECT MAX(last_seen) AS last_seen FROM devices WHERE revoked_at IS NULL AND enrollment_state='approved' AND organization_id=?").get(session.organization_id).last_seen;
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
      FROM devices d WHERE d.organization_id=? ORDER BY ${sortColumns[sort] || "name"} ${direction}`).all(session.organization_id);
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
    const row = db.prepare("SELECT * FROM devices WHERE id=? AND organization_id=?").get(deviceMatch[1], session.organization_id);
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
      FROM audit_events e LEFT JOIN administrators a ON a.id=e.actor_id WHERE e.organization_id=? ORDER BY e.id DESC LIMIT 50`).all(session.organization_id);
    send(res, 200, { items });
    return;
  }
  send(res, 404, { error: "API route not found." });
}

async function sendStatic(req, res, pathname) {
  if (process.env.RMM_DEV_API_ONLY) { send(res, 404, { error: "Use the Vite development address." }); return; }
  const dist = path.join(root, "dist");
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); }
  catch { send(res, 400, { error: "Invalid path." }); return; }
  const relativePath = decodedPath.replace(/^\/+/, "") || "index.html";
  const candidate = path.resolve(dist, relativePath);
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
    else if (req.method === "GET" && /^\/install\/(?:[a-f0-9]{32}|[A-Za-z0-9_-]{40,50})$/i.test(url.pathname)) sendPublicInstallerPage(res, url.pathname.slice("/install/".length));
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
  if (process.env.RMM_ENV === "production") {
    db.prepare("UPDATE installer_build_jobs SET status='queued',claimed_at=NULL,updated_at=? WHERE status='running'").run(new Date().toISOString());
    startLocalInstallerBuildLoop();
  }
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  server.close(() => { db.close(); process.exit(0); });
});
