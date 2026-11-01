import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { finalizeInstallerBuild } from "../src/server/installer-build-lifecycle.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE installer_packages (id TEXT PRIMARY KEY, build_status TEXT, signing_status TEXT, msi_file TEXT, setup_file TEXT, msi_sha256 TEXT, setup_sha256 TEXT, build_error TEXT);
    CREATE TABLE installer_build_jobs (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT, error TEXT);
    INSERT INTO installer_packages(id,build_status) VALUES('package','building');
    INSERT INTO installer_build_jobs(id,status) VALUES('job','running');
  `);
  return db;
}

const buildInfo = {
  signingStatus: "unsigned",
  installer: { file: "agent.msi", sha256: "a".repeat(64) },
  setup: { file: "agent.exe", sha256: "b".repeat(64) },
};

test("an entitled in-flight installer build can finalize atomically", () => {
  const db = fixture();
  let audits = 0;
  const completed = finalizeInstallerBuild(db, {
    jobId: "job", installerId: "package", organizationId: "org", buildInfo, now: "2026-11-01T00:00:00.000Z",
    isOrganizationEntitled: () => true, audit: () => { audits++; },
  });
  assert.equal(completed, true);
  assert.deepEqual({ ...db.prepare("SELECT status FROM installer_build_jobs WHERE id='job'").get() }, { status: "ready" });
  assert.deepEqual({ ...db.prepare("SELECT build_status,msi_file,setup_file FROM installer_packages WHERE id='package'").get() }, { build_status: "ready", msi_file: "agent.msi", setup_file: "agent.exe" });
  assert.equal(audits, 1);
  db.close();
});

test("revocation between build and finalization preserves failed state and never publishes", () => {
  const db = fixture();
  let licenseStatus = "active";
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE installer_build_jobs SET status='failed',error='workspace suspended' WHERE id='job'").run();
  db.prepare("UPDATE installer_packages SET build_status='failed',build_error='workspace suspended' WHERE id='package'").run();
  licenseStatus = "revoked";
  db.exec("COMMIT");

  let audits = 0;
  const completed = finalizeInstallerBuild(db, {
    jobId: "job", installerId: "package", organizationId: "org", buildInfo, now: "2026-11-01T00:00:01.000Z",
    isOrganizationEntitled: () => licenseStatus === "active", audit: () => { audits++; },
  });
  assert.equal(completed, false);
  assert.deepEqual({ ...db.prepare("SELECT status,error FROM installer_build_jobs WHERE id='job'").get() }, { status: "failed", error: "workspace suspended" });
  assert.deepEqual({ ...db.prepare("SELECT build_status,build_error,msi_file,setup_file FROM installer_packages WHERE id='package'").get() }, { build_status: "failed", build_error: "workspace suspended", msi_file: null, setup_file: null });
  assert.equal(audits, 0, "a suspended build is not audited as successfully published");
  db.close();
});
