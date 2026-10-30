import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const project = path.join(root, "agent", "FamilyRmm.Agent", "FamilyRmm.Agent.csproj");
const bootstrapper = path.join(root, "agent", "FamilyRmm.Bootstrapper", "FamilyRmm.Bootstrapper.csproj");
const wixSource = path.join(root, "agent", "packaging", "FamilyRmmAgent.wxs");
const configPath = process.env.RMM_PACKAGE_CONFIG_PATH;
const output = path.resolve(root, process.env.RMM_PACKAGE_DIR || "");
const version = process.env.RMM_PACKAGE_VERSION || "0.1.0";
if (!configPath || !process.env.RMM_PACKAGE_DIR || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error("Package config, output directory and a numeric version are required.");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (!/^https:\/\//i.test(config.serverUrl || "") && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(config.serverUrl || "")) throw new Error("Agent package server URL must use HTTPS outside local development.");
if (!config.enrollmentGrant?.manifest || !config.enrollmentGrant?.signature) throw new Error("A signed enrollment authorization is required.");
await mkdir(output, { recursive: true });
const agentPublish = path.join(output, "agent-publish");
const agentExe = path.join(agentPublish, "FamilyRmm.Agent.exe");
const msiPath = path.join(output, `FamilyRmmAgent-${version}.msi`);
const bootstrapPublish = path.join(output, "bootstrapper-publish");
const setupExe = path.join(output, `FamilyRmmAgentSetup-${version}.exe`);

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, DOTNET_CLI_HOME: path.join(root, ".dotnet-cli"), NUGET_PACKAGES: path.join(root, ".nuget", "packages") }, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60_000 });
  if (result.error || result.status !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim().slice(-5000)}`);
  return result.stdout;
}

const signTool = process.env.RMM_SIGNTOOL_PATH;
const certThumbprint = process.env.RMM_SIGN_CERT_THUMBPRINT;
const signingEnabled = Boolean(signTool && certThumbprint);
if ((process.env.RMM_ENV === "production" || process.env.RMM_REQUIRE_CODESIGN === "1") && !signingEnabled) throw new Error("Production installer creation requires Authenticode signing configuration.");
function sign(file) {
  if (!signingEnabled) return;
  run(signTool, ["sign", "/fd", "SHA256", "/sha1", certThumbprint, "/tr", process.env.RMM_TIMESTAMP_URL || "http://timestamp.digicert.com", "/td", "SHA256", file], `Authenticode signing ${path.basename(file)}`);
  run(signTool, ["verify", "/pa", "/all", file], `Authenticode verification ${path.basename(file)}`);
}

const enableTestHarness = process.env.RMM_ENV !== "production";
const publishArgs = ["publish", project, "-c", "Release", "-p:AgentConfigPath=" + path.resolve(configPath), "-p:Version=" + version,
  "-p:EnableAgentTestHarness=" + enableTestHarness, "-o", agentPublish];
run("dotnet", publishArgs, "Publishing the Windows service agent");
sign(agentExe);

const wix = process.env.RMM_WIX_PATH || "wix";
run(wix, ["build", wixSource, "-arch", "x64", "-d", `ProductVersion=${version}`, "-d", `AgentExe=${agentExe}`, "-d", `AgentConfig=${path.resolve(configPath)}`, "-o", msiPath], "Building the Windows MSI");
sign(msiPath);

run("dotnet", ["publish", bootstrapper, "-c", "Release", "-p:MsiPath=" + msiPath, "-p:Version=" + version, "-o", bootstrapPublish], "Building the graphical EXE installer");
await rename(path.join(bootstrapPublish, "FamilyRmmAgentSetup.exe"), setupExe);
sign(setupExe);

const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const buildInfo = { version, createdAt: new Date().toISOString(), signingStatus: signingEnabled ? "signed" : "unsigned", installer: { file: path.basename(msiPath), sha256: await hash(msiPath) }, setup: { file: path.basename(setupExe), sha256: await hash(setupExe) } };
await writeFile(path.join(output, "build-info.json"), JSON.stringify(buildInfo, null, 2) + "\n", { flag: "w" });
process.stdout.write(JSON.stringify(buildInfo));
