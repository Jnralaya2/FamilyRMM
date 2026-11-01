export function finalizeInstallerBuild(db, { jobId, installerId, organizationId, buildInfo, now, isOrganizationEntitled, audit }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const currentJob = db.prepare("SELECT status FROM installer_build_jobs WHERE id=?").get(jobId);
    if (!isOrganizationEntitled(organizationId) || currentJob?.status !== "running") {
      db.exec("ROLLBACK");
      return false;
    }
    const packageUpdate = db.prepare(`UPDATE installer_packages SET build_status='ready',signing_status=?,msi_file=?,setup_file=?,msi_sha256=?,setup_sha256=?,build_error=NULL
      WHERE id=? AND build_status='building'`).run(buildInfo.signingStatus, buildInfo.installer.file, buildInfo.setup.file,
      buildInfo.installer.sha256, buildInfo.setup.sha256, installerId);
    if (packageUpdate.changes !== 1) throw new Error("Installer package is no longer building.");
    const jobUpdate = db.prepare("UPDATE installer_build_jobs SET status='ready',updated_at=?,error=NULL WHERE id=? AND status='running'").run(now, jobId);
    if (jobUpdate.changes !== 1) throw new Error("Installer build is no longer active.");
    audit();
    db.exec("COMMIT");
    return true;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Transaction already closed. */ }
    throw error;
  }
}
