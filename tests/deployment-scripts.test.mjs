import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const releaseSource = await readFile(path.join(root, "deploy", "deploy-release.sh"), "utf8");
const rollbackSource = await readFile(path.join(root, "deploy", "rollback.sh"), "utf8");
const legacyUpgradeSource = await readFile(path.join(root, "deploy", "upgrade.sh"), "utf8");
const legacyPowerShellSource = await readFile(path.join(root, "scripts", "deploy-public-readiness.ps1"), "utf8");
const posixAvailable = process.platform !== "win32" && spawnSync("sh", ["-c", "true"], { encoding: "utf8" }).status === 0;

if (process.env.REQUIRE_POSIX_DEPLOYMENT_TESTS === "1") {
  assert.ok(posixAvailable, "Required deployment shell integration tests need a working POSIX sh.");
}

test("deployment safety invariants remain present on every platform", async () => {
  assert.match(releaseSource, /failed_dir=\$backup_root\/failed-release-/);
  assert.match(releaseSource, /old-caddy-image-id/);
  assert.match(releaseSource, /database\.sqlite\.sha256/);
  assert.match(releaseSource, /PRAGMA integrity_check/);
  assert.doesNotMatch(releaseSource, /docker builder prune/);
  assert.match(rollbackSource, /sha256sum -c database\.sqlite\.sha256/);
  assert.match(rollbackSource, /PRAGMA integrity_check/);
  assert.doesNotMatch(rollbackSource, /docker cp .*database\.sqlite/);
  assert.match(legacyUpgradeSource, /entry point is disabled/i);
  assert.doesNotMatch(legacyPowerShellSource, /\bscp\b|zipfile -e|Expand-Archive|ExpandToDirectory/i);
  assert.match(legacyPowerShellSource, /intentionally disabled/i);
});

const skipReason = posixAvailable ? false : "POSIX sh is unavailable on this Windows host; these mocked script integration tests run on Linux/macOS CI.";

async function fixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "familyrmm-deploy-script-test-"));
  const appDir = path.join(temp, "app");
  const backupRoot = path.join(temp, "backups");
  const volumeRoot = path.join(temp, "volume");
  const mockRoot = path.join(temp, "mock");
  const binDir = path.join(temp, "bin");
  await Promise.all([appDir, backupRoot, volumeRoot, mockRoot, binDir].map((dir) => mkdir(dir, { recursive: true })));
  await mkdir(path.join(appDir, "deploy"), { recursive: true });
  await mkdir(path.join(appDir, "secrets"), { recursive: true });
  await writeFile(path.join(appDir, "docker-compose.yml"), "services:\n  app: {}\n  caddy: {}\n");
  await writeFile(path.join(appDir, ".env"), "RMM_PUBLIC_HOST=familyrmm.invalid\nRMM_SETUP_TOKEN=fixture-only\n");
  await writeFile(path.join(appDir, "deploy", "Caddyfile"), "{$RMM_PUBLIC_HOST} { reverse_proxy app:3000 }\n");
  await writeFile(path.join(appDir, "secrets", "enrollment-private-key.pem"), "MOCK-ONLY-NOT-A-KEY\n");
  await writeFile(path.join(appDir, "release-marker.txt"), "old-source\n");
  const bundleSource = path.join(temp, "bundle-source");
  await mkdir(path.join(bundleSource, "dist", "assets"), { recursive: true });
  await mkdir(path.join(bundleSource, "deploy"), { recursive: true });
  await writeFile(path.join(bundleSource, "dist", "index.html"), '<script src="/assets/release-test.js"></script>');
  await writeFile(path.join(bundleSource, "dist", "assets", "release-test.js"), "Download Windows MSI Download Windows EXE");
  await writeFile(path.join(bundleSource, "deploy", "Caddyfile"), "{$RMM_PUBLIC_HOST} { reverse_proxy app:3000 }\n");
  await writeFile(path.join(bundleSource, "docker-compose.yml"), "services:\n  app: {}\n  caddy: {}\n");
  const bundlePath = path.join(temp, "release.zip");
  execFileSync("python3", ["-c", "import os,sys,zipfile; root,out=sys.argv[1:]; z=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED); [(z.write(os.path.join(dp,f),os.path.relpath(os.path.join(dp,f),root))) for dp,_,fs in os.walk(root) for f in fs]; z.close()", bundleSource, bundlePath]);

  const mockJsPath = path.join(mockRoot, "docker-mock.mjs");
  const mockJs = String.raw`import fs from "node:fs";
import path from "node:path";
const a=process.argv.slice(2), root=process.env.MOCK_ROOT, statePath=path.join(root,"state.json"), logPath=path.join(root,"docker.jsonl");
const oldApp="sha256:"+"a".repeat(64), oldCaddy="sha256:"+"c".repeat(64), newApp="sha256:"+"b".repeat(64);
let s=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,"utf8")):{app:"old",caddy:"old",up:0,health:0,validations:0,tags:[]};
const save=()=>fs.writeFileSync(statePath,JSON.stringify(s));
const log=(record)=>fs.appendFileSync(logPath,JSON.stringify(record)+"\n");
log(a);
const print=(x)=>{if(x!==undefined&&x!=="") process.stdout.write(String(x)+"\n")};
const fail=(m)=>{process.stderr.write(m+"\n");process.exit(1)};
if(a[0]==="compose"&&a[1]==="ps"){
 const all=a.includes("-a"), service=a.at(-1);
 if(service==="app") print(s.app==="down"&&!all?"":s.app==="old"?"app-old":s.app==="new"?(all||s.app!=="exited"?"app-new":""):s.app==="exited"?(all?"app-new":""):"");
 else if(service==="caddy") print(s.caddy==="old"?"caddy-old":s.caddy==="new"?"caddy-new":"");
 process.exit(0);
}
if(a[0]==="compose"&&a[1]==="build") { if(process.env.MOCK_BUILD_FAILURE==="1") fail("mock image build failed"); process.exit(0); }
if(a[0]==="compose"&&a[1]==="up"){
 s.up++;
 if(s.rollbackTagSet&&process.env.MOCK_ROLLBACK_FAILURE==="compose-up") fail("mock rollback compose failure");
 if(s.rollbackTagSet){s.app="old";s.caddy="old";}else{s.app="new";s.caddy="new";}
 save(); process.exit(0);
}
if(a[0]==="inspect"&&a[1]==="-f"){
 const fmt=a[2], id=a[3];
 if(fmt.includes(".Mounts")){print("volume familyrmm_rmm_data");process.exit(0);}
 if(fmt.includes("RMM_DB_PATH")){print("/var/lib/family-rmm/rmm.sqlite");process.exit(0);}
 if(fmt.includes("RMM_ARTIFACTS_DIR")){print("/var/lib/family-rmm/artifacts");process.exit(0);}
 if(fmt==="{{.Image}}") {print(id==="app-old"?oldApp:id==="app-new"?newApp:id==="caddy-old"?oldCaddy:id);process.exit(0);}
 if(fmt==="{{.Config.Image}}") {print(id.startsWith("app-")?"familyrmm-app:latest":"caddy:2.10-alpine");process.exit(0);}
 if(fmt.includes(".State.Health")){
   if(id==="app-old"){print("healthy");process.exit(0);}
   s.health++; save();
   if(process.env.MOCK_NEW_HEALTH_FAILURE==="1"&&s.health>1){s.app="exited";save();print("exited");process.exit(0);}
   print("healthy");process.exit(0);
 }
 fail("unknown inspect format");
}
if(a[0]==="image"&&a[1]==="inspect"){
 const id=a[2]; if(process.env.MOCK_MISSING_IMAGE===id) fail("mock image missing");
 if(id.startsWith("sha256:")||s.tags.includes(id)) process.exit(0); fail("mock image not found");
}
if(a[0]==="image"&&a[1]==="tag"){
 const from=a[2],to=a[3];
 if(process.env.MOCK_ROLLBACK_FAILURE==="tag"&&to==="familyrmm-app:latest"&&from===oldApp) fail("mock rollback image tag failed");
 if(to.includes("familyrmm-rollback-")&&s.tags.includes(to)) fail("mock refuses overwrite of image tag");
 s.tags.push(to); if(to==="familyrmm-app:latest"&&from===oldApp)s.rollbackTagSet=true; save(); process.exit(0);
}
if(a[0]==="exec"){
 const code=a.join(" ");
 if(code.includes("process.env.RMM_DB_PATH")){print("/var/lib/family-rmm/rmm.sqlite");process.exit(0);}
 if(code.includes("process.env.RMM_ARTIFACTS_DIR")){print("/var/lib/family-rmm/artifacts");process.exit(0);}
 const vacuum=code.match(/VACUUM INTO '([^']+)'/);
 if(vacuum){const p=vacuum[1];fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,"mock sqlite snapshot");process.exit(0);}
 if(a[2]==="test"&&a[3]==="-s"){
   if(process.env.MOCK_DB_SOURCE_MISSING==="1") fail("mock snapshot missing");
   process.exit(0);
 }
 if(code.includes("caddy validate")){
   s.validations++;save();
   const shouldFail=process.env.MOCK_CADDY_VALIDATION_FAILURE==="1"&&s.validations===1;
   const rollbackFail=process.env.MOCK_ROLLBACK_FAILURE==="caddy"&&s.rollbackTagSet;
   if(shouldFail||rollbackFail) fail("mock Caddy validation failed"); process.exit(0);
 }
 process.exit(0);
}
if(a[0]==="cp"){
 const source=a[1], dest=a[2];
 if(source.startsWith("probe:")){
   fs.mkdirSync(path.dirname(dest),{recursive:true});
   if(source.endsWith("index.html"))fs.writeFileSync(dest,'<script src="/assets/release-test.js"></script>');
   else fs.writeFileSync(dest,"Download Windows MSI Download Windows EXE");
   process.exit(0);
 }
 if(source.includes("/backups/")){
   if(process.env.MOCK_DB_COPY==="missing")process.exit(0);
   fs.mkdirSync(path.dirname(dest),{recursive:true});
   fs.writeFileSync(dest,process.env.MOCK_DB_COPY==="empty"?"":"mock sqlite snapshot");process.exit(0);
 }
 fail("unexpected docker cp");
}
if(a[0]==="create"){print("probe");process.exit(0);}
if(a[0]==="rm"){process.exit(0);}
if(a[0]==="run"){
 const caddy=a.includes("caddy"), sqlite=a.includes("node");
 if(caddy){s.validations++;save();if(process.env.MOCK_CADDY_VALIDATION_FAILURE==="1"&&s.validations===1)fail("mock previous Caddy validation failed");process.exit(0);}
 if(sqlite&&process.env.MOCK_DB_INTEGRITY==="invalid")fail("mock SQLite integrity failure");
 process.exit(0);
}
fail("unhandled docker mock command: "+a.join(" "));
`;
  await writeFile(mockJsPath, mockJs);
  const dockerPath = path.join(binDir, "docker");
  await writeFile(dockerPath, `#!/bin/sh\nexec '${process.execPath}' '${mockJsPath}' "$@"\n`);
  await chmod(dockerPath, 0o755);
  const sleepPath = path.join(binDir, "sleep");
  await writeFile(sleepPath, "#!/bin/sh\nexit 0\n");
  await chmod(sleepPath, 0o755);
  const realTar = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
  const tarPath = path.join(binDir, "tar");
  await writeFile(tarPath, `#!/bin/sh\nif [ "${"$"}1" = "-czf" ] && [ "${"$"}MOCK_TAR_CREATE" = "missing" ]; then exit 0; fi\nexec '${realTar}' "${"$"}@"\n`);
  await chmod(tarPath, 0o755);
  const deployScript = path.join(temp, "deploy-release.sh");
  const rollbackScript = path.join(temp, "rollback.sh");
  const releaseTestSource = releaseSource
    .replace("app_dir=/opt/family-rmm", `app_dir=${appDir}`)
    .replace("backup_root=/var/backups/family-rmm", `backup_root=${backupRoot}`)
    .replace("db_backup_in_volume=/var/lib/family-rmm/backups/rmm-$stamp.sqlite", `db_backup_in_volume=${volumeRoot}/backups/rmm-$stamp.sqlite`);
  const rollbackTestSource = rollbackSource
    .replace("app_dir=/opt/family-rmm", `app_dir=${appDir}`)
    .replace("backup_root=/var/backups/family-rmm", `backup_root=${backupRoot}`);
  await writeFile(deployScript, releaseTestSource);
  await writeFile(rollbackScript, rollbackTestSource);
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, MOCK_ROOT: mockRoot, MOCK_VOLUME_ROOT: volumeRoot, MOCK_DOCKER_JS: mockJsPath };
  const run = (script, args = [], extraEnv = {}) => spawnSync("sh", [script, ...args], { cwd: appDir, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60_000 });
  const readState = async () => JSON.parse(await readFile(path.join(mockRoot, "state.json"), "utf8"));
  const readDockerLog = async () => (await readFile(path.join(mockRoot, "docker.jsonl"), "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const backupDir = async () => (await (await import("node:fs/promises")).readdir(backupRoot)).map((name) => path.join(backupRoot, name)).find((name) => name.includes("deploy-"));
  return { temp, appDir, backupRoot, volumeRoot, mockRoot, deployScript, rollbackScript, bundlePath, env, run, readState, readDockerLog, backupDir };
}

async function removeFixture(f) { await rm(f.temp, { recursive: true, force: true }); }
function testRelease(name, env = {}, assertResult) {
  test(name, { skip: skipReason }, async () => {
    const f = await fixture();
    try { const result = f.run(f.deployScript, [f.bundlePath, "familyrmm.invalid"], env); await assertResult(f, result); }
    finally { await removeFixture(f); }
  });
}

testRelease("release accepts a complete, checksummed, integrity-checked backup", {}, async (f, result) => {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const backup = await f.backupDir();
  assert.ok(backup);
  for (const name of ["project.tar.gz", "database.sqlite", "database.sqlite.sha256", "old-image-id", "old-caddy-image-id", "compose-image", "caddy-compose-image", "rollback-image", "rollback-caddy-image", "data-volume", "backup-format-version"]) {
    const stat = await (await import("node:fs/promises")).stat(path.join(backup, name)); assert.ok(stat.size > 0, `${name} must exist and be nonempty`);
  }
  assert.match(result.stdout, /DEPLOYMENT_OK/);
});

testRelease("release stops when the database snapshot is empty", { MOCK_DB_COPY: "empty" }, async (f, result) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /snapshot is missing or empty/i);
  assert.equal((await f.readState()).up, 0, "application containers are not recreated before backup validation");
});

testRelease("release stops when the database snapshot is missing", { MOCK_DB_COPY: "missing" }, async (f, result) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /snapshot is missing or empty/i);
  assert.equal((await f.readState()).up, 0);
});

testRelease("release stops when SQLite integrity validation fails", { MOCK_DB_INTEGRITY: "invalid" }, async (f, result) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /integrity validation failed/i);
  assert.equal((await f.readState()).up, 0);
});

testRelease("release stops when the source archive is missing", { MOCK_TAR_CREATE: "missing" }, async (f, result) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source archive is missing or empty/i);
  assert.equal((await f.readState()).up, 0);
});

testRelease("image build failure restores source and the still-running previous app", { MOCK_BUILD_FAILURE: "1" }, async (f, result) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Rollback completed/);
  assert.equal((await f.readState()).app, "old");
  assert.equal(await readFile(path.join(f.appDir, "release-marker.txt"), "utf8"), "old-source\n");
});

testRelease("new application health failure restores the old application", { MOCK_NEW_HEALTH_FAILURE: "1" }, async (f, result) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Rollback completed/);
  assert.equal((await f.readState()).app, "old");
});

testRelease("Caddy validation failure restores the old application and proxy", { MOCK_CADDY_VALIDATION_FAILURE: "1" }, async (f, result) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Rollback completed/);
  const state = await f.readState(); assert.equal(state.app, "old"); assert.equal(state.caddy, "old");
});

testRelease("failed rollback reports a diagnostic and preserves the database", { MOCK_BUILD_FAILURE: "1", MOCK_ROLLBACK_FAILURE: "tag" }, async (f, result) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AUTOMATIC ROLLBACK FAILED/);
  assert.match(result.stderr, /database was not restored/);
  const log = await f.readDockerLog();
  assert.equal(log.filter((args) => args[0] === "cp" && String(args[1]).includes("/backups/")).length, 1, "only the pre-release backup is copied; rollback does not restore the database");
});

async function manualFixture() {
  const f = await fixture();
  const backup = path.join(f.backupRoot, "deploy-manual-test");
  await mkdir(backup, { recursive: true });
  const source = path.join(f.temp, "old-source");
  await mkdir(path.join(source, "deploy"), { recursive: true });
  await mkdir(path.join(source, "secrets"), { recursive: true });
  await writeFile(path.join(source, "docker-compose.yml"), "services:\n  app: {}\n  caddy: {}\n");
  await writeFile(path.join(source, ".env"), "RMM_PUBLIC_HOST=familyrmm.invalid\n");
  await writeFile(path.join(source, "secrets", "enrollment-private-key.pem"), "MOCK-ONLY-NOT-A-KEY\n");
  await writeFile(path.join(source, "deploy", "Caddyfile"), "{$RMM_PUBLIC_HOST} { reverse_proxy app:3000 }\n");
  await writeFile(path.join(source, "release-marker.txt"), "backup-source\n");
  const tar = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
  execFileSync(tar, ["-czf", path.join(backup, "project.tar.gz"), "-C", source, "."]);
  const dbBytes = Buffer.from("mock sqlite snapshot");
  await writeFile(path.join(backup, "database.sqlite"), dbBytes);
  await writeFile(path.join(backup, "database.sqlite.sha256"), `${createHash("sha256").update(dbBytes).digest("hex")}  database.sqlite\n`);
  for (const [name, value] of Object.entries({
    "old-image-id": `sha256:${"a".repeat(64)}\n`,
    "old-caddy-image-id": `sha256:${"c".repeat(64)}\n`,
    "compose-image": "familyrmm-app:latest\n",
    "caddy-compose-image": "caddy:2.10-alpine\n",
    "data-volume": "volume familyrmm_rmm_data\n",
    "backup-format-version": "2\n",
  })) await writeFile(path.join(backup, name), value);
  await writeFile(path.join(f.backupRoot, "LATEST"), backup + "\n");
  await writeFile(path.join(f.appDir, "release-marker.txt"), "current-source\n");
  return { ...f, backup };
}

function testManual(name, extraEnv, assertResult, prepare = async () => {}) {
  test(name, { skip: skipReason }, async () => {
    const f = await manualFixture();
    try { await prepare(f); const result = f.run(f.rollbackScript, [], extraEnv); await assertResult(f, result); }
    finally { await removeFixture(f); }
  });
}

testManual("manual rollback refuses to modify files when the previous app image is missing", { MOCK_MISSING_IMAGE: `sha256:${"a".repeat(64)}` }, async (f, result) => {
  assert.notEqual(result.status, 0); assert.match(result.stderr, /previous application image is unavailable/i);
  assert.equal(await readFile(path.join(f.appDir, "release-marker.txt"), "utf8"), "current-source\n");
  assert.equal((await f.readState()).up, 0);
});

testManual("manual rollback refuses an invalid database checksum before modifying files", {}, async (f, result) => {
  assert.notEqual(result.status, 0); assert.match(result.stderr, /checksum does not match/i);
  assert.equal(await readFile(path.join(f.appDir, "release-marker.txt"), "utf8"), "current-source\n");
  assert.equal((await f.readState()).up, 0);
}, async (f) => writeFile(path.join(f.backup, "database.sqlite.sha256"), `${"0".repeat(64)}  database.sqlite\n`));

testManual("ordinary manual rollback preserves the live database and validates backup materials", {}, async (f, result) => {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await readFile(path.join(f.appDir, "release-marker.txt"), "utf8"), "backup-source\n");
  assert.match(result.stdout, /live database was not changed/i);
  const log = await f.readDockerLog();
  assert.equal(log.some((args) => args[0] === "cp" || (args[0] === "exec" && args.some((arg) => /VACUUM|\.sqlite/.test(String(arg))))), false, "ordinary rollback has no database restore/copy operation");
});
