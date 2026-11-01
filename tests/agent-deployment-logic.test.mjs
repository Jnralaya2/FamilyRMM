import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

test("Windows agent deployment policy logic fails closed and validates bounded transfer outcomes", () => {
  const project = path.join(process.cwd(), "agent", "FamilyRmm.Agent", "FamilyRmm.Agent.csproj");
  const linuxSelfTest = process.platform === "linux";
  const buildProperties = linuxSelfTest
    ? ["-p:TargetFramework=net10.0", "-p:RuntimeIdentifier=linux-x64", "-p:SelfContained=false", "-p:UseAppHost=false", "-p:PublishSingleFile=false",
      "-p:EnableWindowsTargeting=true", "-p:EnableAgentTestHarness=true",
      `-p:BaseIntermediateOutputPath=${path.join(process.cwd(), "agent", "FamilyRmm.Agent", "obj")}${path.sep}`,
      `-p:MSBuildProjectExtensionsPath=${path.join(process.cwd(), "agent", "FamilyRmm.Agent", "obj", "linux-policy-self-test")}${path.sep}`]
    : ["-p:EnableWindowsTargeting=true", "-p:EnableAgentTestHarness=true"];
  execFileSync("dotnet", ["build", project, "-c", "Release", ...buildProperties, "--no-restore"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 180_000,
    env: { ...process.env, DOTNET_CLI_HOME: path.join(process.cwd(), ".dotnet-cli"), NUGET_PACKAGES: path.join(process.cwd(), ".nuget", "packages") },
  });
  const agent = path.join(process.cwd(), "agent", "FamilyRmm.Agent", "bin", "Release", ...(linuxSelfTest ? ["net10.0", "linux-x64"] : ["net10.0-windows", "win-x64"]), "FamilyRmm.Agent.dll");
  const output = execFileSync("dotnet", [agent, "--deployment-logic-self-test"], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
  assert.match(output, /Deployment logic checks passed/);
});
