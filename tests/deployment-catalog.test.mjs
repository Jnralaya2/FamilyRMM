import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { APPLICATION_CATALOG, downloadCatalogInstaller, resolveCatalogApplication } from "../src/server/deployment-catalog.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifestFor = (id, version, url = "https://dl.google.com/chrome/enterprise.msi", sha = "a".repeat(64)) =>
  `PackageIdentifier: ${id}\nPackageVersion: ${version}\nInstallers:\n  - Architecture: x64\n    InstallerType: msi\n    InstallerUrl: ${url}\n    InstallerSha256: ${sha}\n`;
function wingetFetcher({ versions = ["123.4"], manifest = null, locale = "ShortDescription: Secure browser\n" } = {}) {
  const blobs = new Map([["installer-sha", Buffer.from(manifest || manifestFor("Google.Chrome", versions.at(-1))).toString("base64")], ["locale-sha", Buffer.from(locale).toString("base64")]]);
  return async (input) => {
    const url = String(input);
    if (url.includes("/contents/manifests/g/Google/Chrome?")) return Response.json(versions.map((name) => ({ type: "dir", name })));
    if (url.includes("/contents/manifests/g/Google/Chrome/")) return Response.json([
      { type: "file", name: "Google.Chrome.installer.yaml", sha: "installer-sha" },
      { type: "file", name: "Google.Chrome.locale.en-US.yaml", sha: "locale-sha" },
    ]);
    if (url.endsWith("/git/blobs/installer-sha")) return Response.json({ encoding: "base64", content: blobs.get("installer-sha") });
    if (url.endsWith("/git/blobs/locale-sha")) return Response.json({ encoding: "base64", content: blobs.get("locale-sha") });
    throw new Error(`Unexpected request ${url}`);
  };
}

test("curated catalog contains the eight approved applications and publishers", () => {
  assert.equal(APPLICATION_CATALOG.length, 8);
  assert.ok(APPLICATION_CATALOG.every((app) => app.name && app.publisher && app.hosts.length));
});

test("catalog resolves the highest manifest version independent of unrelated commits", async () => {
  const resolved = await resolveCatalogApplication("chrome", wingetFetcher({ versions: ["123.4", "124.1", "9999.1-preview"] }));
  assert.equal(resolved.version, "9999.1-preview");
  assert.equal(resolved.packageType, "msi");
  assert.equal(resolved.expectedSha256, "a".repeat(64));
  assert.equal(resolved.description, "Secure browser");
});

test("catalog rejects mismatched manifest identity and non-vendor URLs", async () => {
  await assert.rejects(resolveCatalogApplication("chrome", wingetFetcher({ manifest: manifestFor("Other.App", "123.4") })), /identity or version/);
  await assert.rejects(resolveCatalogApplication("chrome", wingetFetcher({ manifest: manifestFor("Google.Chrome", "123.4", "https://evil.example/setup.msi") })), /outside the approved vendor download hosts/);
});

test("Notepad++ requires the official project release path", async () => {
  const sha = "a".repeat(64);
  const app = { id: "notepad-plus-plus", installerUrl: "https://github.com/other/project/releases/download/v1/setup.exe", allowedHosts: APPLICATION_CATALOG.find((item) => item.id === "notepad-plus-plus").hosts, packageType: "exe", expectedSha256: sha };
  await assert.rejects(downloadCatalogInstaller(app, async () => new Response(Buffer.from("MZ"))), /official project release path/);
});

test("Teams catalog labels its bootstrapper and does not claim second-stage MSIX hash coverage", async () => {
  const manifest = `PackageIdentifier: Microsoft.Teams\nPackageVersion: 250.1\nInstallerSwitches:\n  Silent: /s\nInstallers:\n  - Architecture: x64\n    InstallerType: exe\n    InstallerUrl: https://go.microsoft.com/fwlink/?linkid=teams\n    InstallerSha256: ${"b".repeat(64)}\n`;
  const installerBlob = Buffer.from(manifest).toString("base64");
  const fetcher = async (input) => {
    const url = String(input);
    if (url.includes("/contents/manifests/m/Microsoft/Teams?")) return Response.json([{ type: "dir", name: "250.1" }]);
    if (url.includes("/contents/manifests/m/Microsoft/Teams/")) return Response.json([{ type: "file", name: "Microsoft.Teams.installer.yaml", sha: "teams-installer" }]);
    if (url.endsWith("/git/blobs/teams-installer")) return Response.json({ encoding: "base64", content: installerBlob });
    throw new Error(`Unexpected request ${url}`);
  };
  const result = await resolveCatalogApplication("teams", fetcher);
  assert.equal(result.installerMode, "bootstrapper");
  assert.match(result.deliveryNote, /does not pin or hash the second-stage MSIX/);
});

test("vendor installer download verifies HTTPS host, format and manifest SHA-256", async () => {
  const bytes = Buffer.from([0x4d, 0x5a, 1, 2, 3]);
  const application = { installerUrl: "https://zoom.us/client.exe", allowedHosts: ["zoom.us"], packageType: "exe", expectedSha256: hash(bytes), id: "zoom", version: "1.0" };
  const downloaded = await downloadCatalogInstaller(application, async () => new Response(bytes));
  assert.deepEqual(downloaded.bytes, bytes);
  assert.equal(downloaded.sha256, hash(bytes));
  await assert.rejects(downloadCatalogInstaller({ ...application, expectedSha256: "0".repeat(64) }, async () => new Response(bytes)), /SHA-256/);
  await assert.rejects(downloadCatalogInstaller({ ...application, installerUrl: "http://zoom.us/client.exe" }, async () => new Response(bytes)), /approved vendor download hosts/);
  await assert.rejects(downloadCatalogInstaller({ ...application, installerUrl: "https://zoom.us:444/client.exe" }, async () => new Response(bytes)), /approved vendor download hosts/);
});

test("vendor downloads enforce size while streaming and honor body timeouts", async () => {
  const application = { installerUrl: "https://zoom.us/client.exe", allowedHosts: ["zoom.us"], packageType: "exe", expectedSha256: "a".repeat(64), id: "zoom" };
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(8)); controller.close(); } });
  await assert.rejects(downloadCatalogInstaller(application, async () => new Response(oversized), { maxBytes: 8 }), /250 MiB package limit/);
  const stalledFetcher = async (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  await assert.rejects(downloadCatalogInstaller(application, stalledFetcher, { timeoutMs: 10 }), /abort|timed out/i);
  const stalledBodyFetcher = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener("abort", () => controller.error(signal.reason), { once: true }); },
  }));
  await assert.rejects(downloadCatalogInstaller(application, stalledBodyFetcher, { timeoutMs: 10 }), /abort|timed out/i);
});

test("vendor redirects are manually constrained to approved vendor hosts", async () => {
  const application = { installerUrl: "https://www.7-zip.org/setup.exe", allowedHosts: ["www.7-zip.org"], packageType: "exe", expectedSha256: "a".repeat(64) };
  await assert.rejects(downloadCatalogInstaller(application, async () => new Response(null, { status: 302, headers: { location: "https://evil.example/setup.exe" } })), /outside the approved vendor download hosts/);
});
