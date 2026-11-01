import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const project = path.join(root, "agent", "FamilyRmm.Agent", "FamilyRmm.Agent.csproj");
const bootstrapper = path.join(root, "agent", "FamilyRmm.Bootstrapper", "FamilyRmm.Bootstrapper.csproj");
const wixSource = path.join(root, "agent", "packaging", process.platform === "win32" ? "FamilyRmmAgent.wxs" : "FamilyRmmAgent.wixl.wxs");
const configPath = process.env.RMM_PACKAGE_CONFIG_PATH;
const output = path.resolve(root, process.env.RMM_PACKAGE_DIR || "");
const version = process.env.RMM_PACKAGE_VERSION || "0.2.4";
if (!configPath || !process.env.RMM_PACKAGE_DIR || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error("Package config, output directory and a numeric version are required.");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (!/^https:\/\//i.test(config.serverUrl || "") && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(config.serverUrl || "")) throw new Error("Agent package server URL must use HTTPS outside local development.");
if (!config.taskSigningPublicKey) throw new Error("A pinned Family RMM signing public key is required.");
if (config.enrollmentGrant && (!config.enrollmentGrant.manifest || !config.enrollmentGrant.signature)) throw new Error("The optional enrollment authorization is invalid.");
await mkdir(output, { recursive: true });
// Build and inspect MSI files on the container's local filesystem. The
// persistent artifact volume is used only for completed downloads; this keeps
// msitools from validating a partially written volume-backed MSI and avoids
// accumulating intermediate .NET publish trees for every package.
const buildRoot = await mkdtemp(path.join(tmpdir(), "family-rmm-agent-"));
const buildConfigPath = path.join(buildRoot, "package-config.json");
await writeFile(buildConfigPath, JSON.stringify(config, null, 2), { flag: "wx" });
process.once("exit", () => { try { rmSync(buildRoot, { recursive: true, force: true }); } catch { /* Temporary build files only. */ } });
const agentPublish = path.join(buildRoot, "agent-publish");
const agentExe = path.join(agentPublish, "FamilyRmm.Agent.exe");
const msiFileName = `FamilyRmmAgent-${version}.msi`;
const setupFileName = `FamilyRmmAgentSetup-${version}.exe`;
const msiPath = path.join(buildRoot, msiFileName);
const bootstrapPublish = path.join(buildRoot, "bootstrapper-publish");
const setupExe = path.join(buildRoot, setupFileName);

async function requireMsiOutput(stage) {
  let info;
  try { info = await stat(msiPath); }
  catch (error) { throw new Error(`${stage} did not create an accessible MSI at ${msiPath} (${error.code || error.message}).`); }
  if (!info.isFile() || info.size < 1024) throw new Error(`${stage} produced an invalid MSI (${info.size} bytes).`);
}

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, DOTNET_CLI_HOME: process.env.DOTNET_CLI_HOME || path.join(root, ".dotnet-cli"), NUGET_PACKAGES: process.env.NUGET_PACKAGES || path.join(root, ".nuget", "packages") }, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60_000 });
  if (result.error || result.status !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim().slice(-5000)}`);
  return result.stdout;
}

const signTool = process.env.RMM_SIGNTOOL_PATH;
const certThumbprint = process.env.RMM_SIGN_CERT_THUMBPRINT;
const signingEnabled = Boolean(signTool && certThumbprint);
const unsignedPilotAllowed = process.env.RMM_ALLOW_UNSIGNED_INSTALLERS === "1";
if ((process.env.RMM_ENV === "production" || process.env.RMM_REQUIRE_CODESIGN === "1") && !signingEnabled && !unsignedPilotAllowed) throw new Error("Production installer creation requires Authenticode signing configuration. Unsigned pilot builds must be created locally with scripts/build-unsigned-agent-package.mjs.");
function sign(file) {
  if (!signingEnabled) return;
  run(signTool, ["sign", "/fd", "SHA256", "/sha1", certThumbprint, "/tr", process.env.RMM_TIMESTAMP_URL || "http://timestamp.digicert.com", "/td", "SHA256", file], `Authenticode signing ${path.basename(file)}`);
  run(signTool, ["verify", "/pa", "/all", file], `Authenticode verification ${path.basename(file)}`);
}

const enableTestHarness = process.env.RMM_ENV !== "production";
const publishArgs = ["publish", project, "-c", "Release", "--no-restore", "-p:AgentConfigPath=" + buildConfigPath, "-p:Version=" + version,
  "-p:EnableAgentTestHarness=" + enableTestHarness, "-p:EnableWindowsTargeting=true", "-o", agentPublish];
run("dotnet", publishArgs, "Publishing the Windows service agent");
sign(agentExe);

if (process.platform === "win32") {
  const wix = process.env.RMM_WIX_PATH || "wix";
  run(wix, ["build", wixSource, "-arch", "x64", "-d", `ProductVersion=${version}`, "-d", `AgentExe=${agentExe}`, "-d", `AgentConfig=${buildConfigPath}`, "-o", msiPath], "Building the Windows MSI");
} else {
  const wixl = process.env.RMM_WIXL_PATH || "wixl";
  run(wixl, ["--arch", "x64", "-D", `ProductVersion=${version}`, "-D", `AgentExe=${agentExe}`, "-D", `AgentConfig=${buildConfigPath}`, "-o", msiPath, wixSource], "Building the Windows MSI");
  await requireMsiOutput("wixl");
  const removeFileIdt = path.join(buildRoot, "RemoveFile.idt");
  const removeFileTable = [
    "FileKey\tComponent_\tFileName\tDirProperty\tInstallMode",
    "s72\ts72\tl255\ts72\ti2",
    "RemoveFile\tFileKey",
    "RemoveDeviceIdentity\tAgentStateComponent\tdevice-identity.json\tRmmProgramData\t2",
    "RemoveAgentStatus\tAgentStateComponent\tstatus.json\tRmmProgramData\t2",
    "RemoveIdentityTemp\tAgentStateComponent\tdevice-identity.json.tmp\tRmmProgramData\t2",
    "RemoveStateFolder\tAgentStateComponent\t\tRmmProgramData\t2",
  ].join("\r\n") + "\r\n";
  await writeFile(removeFileIdt, removeFileTable, "utf8");
  try { run("msibuild", [msiPath, "-i", removeFileIdt], "Adding MSI uninstall cleanup rules"); }
  finally { await rm(removeFileIdt, { force: true }); }
  await requireMsiOutput("msibuild");
  const tables = run("msiinfo", ["tables", msiPath], "Validating the Windows MSI");
  for (const requiredTable of ["File", "ServiceInstall", "ServiceControl", "RemoveFile"]) {
    if (!tables.split(/\s+/).includes(requiredTable)) throw new Error(`The MSI is missing its ${requiredTable} table.`);
  }
  const serviceRows = run("msiinfo", ["export", msiPath, "ServiceInstall"], "Validating the Windows service entry");
  if (!serviceRows.includes("FamilyRmmAgent")) throw new Error("The MSI does not contain the FamilyRmmAgent Windows service.");
  const cleanupRows = run("msiinfo", ["export", msiPath, "RemoveFile"], "Validating MSI uninstall cleanup");
  for (const cleanupEntry of ["device-identity.json", "status.json", "device-identity.json.tmp", "RemoveStateFolder"]) {
    if (!cleanupRows.includes(cleanupEntry)) throw new Error(`The MSI uninstall cleanup is missing ${cleanupEntry}.`);
  }
}
sign(msiPath);

run("dotnet", ["publish", bootstrapper, "-c", "Release", "--no-restore", "-p:MsiPath=" + msiPath, "-p:Version=" + version, "-p:EnableWindowsTargeting=true", "-o", bootstrapPublish], "Building the graphical EXE installer");
await rename(path.join(bootstrapPublish, "FamilyRmmAgentSetup.exe"), setupExe);
sign(setupExe);

const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const buildInfo = { version, createdAt: new Date().toISOString(), signingStatus: signingEnabled ? "signed" : "unsigned", installer: { file: msiFileName, sha256: await hash(msiPath) }, setup: { file: setupFileName, sha256: await hash(setupExe) } };
const buildInfoPath = path.join(buildRoot, "build-info.json");
await writeFile(buildInfoPath, JSON.stringify(buildInfo, null, 2) + "\n", { flag: "wx" });
for (const [source, fileName] of [[msiPath, msiFileName], [setupExe, setupFileName], [buildInfoPath, "build-info.json"]]) {
  const destination = path.join(output, fileName);
  const stagedDestination = path.join(output, `.${fileName}.${process.pid}.tmp`);
  await copyFile(source, stagedDestination);
  await rm(destination, { force: true });
  await rename(stagedDestination, destination);
}
// Keep a testable copy of the exact agent executable alongside local
// development packages. Production artifacts expose only the installers.
if (process.env.RMM_ENV !== "production") await cp(agentPublish, path.join(output, "agent-publish"), { recursive: true });
process.stdout.write(JSON.stringify(buildInfo));
