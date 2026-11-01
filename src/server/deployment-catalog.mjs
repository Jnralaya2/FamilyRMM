const WINGET_API = "https://api.github.com/repos/microsoft/winget-pkgs";
const MAX_PACKAGE_BYTES = 250 * 1024 * 1024;

export const APPLICATION_CATALOG = [
  { id: "chrome", name: "Google Chrome", publisher: "Google LLC", manifest: "Google.Chrome", directory: "manifests/g/Google/Chrome", hosts: ["dl.google.com"] },
  { id: "firefox", name: "Mozilla Firefox", publisher: "Mozilla Corporation", manifest: "Mozilla.Firefox", directory: "manifests/m/Mozilla/Firefox", hosts: ["download.mozilla.org", "download-installer.cdn.mozilla.net"] },
  { id: "7zip", name: "7-Zip", publisher: "Igor Pavlov", manifest: "7zip.7zip", directory: "manifests/7/7zip/7zip", hosts: ["www.7-zip.org"] },
  { id: "vlc", name: "VLC media player", publisher: "VideoLAN", manifest: "VideoLAN.VLC", directory: "manifests/v/VideoLAN/VLC", hosts: ["get.videolan.org", "downloads.videolan.org"] },
  { id: "acrobat-reader", name: "Adobe Acrobat Reader", publisher: "Adobe Inc.", manifest: "Adobe.Acrobat.Reader.64-bit", directory: "manifests/a/Adobe/Acrobat/Reader/64-bit", hosts: ["ardownload2.adobe.com", "ardownload3.adobe.com"] },
  { id: "zoom", name: "Zoom Workplace", publisher: "Zoom Video Communications, Inc.", manifest: "Zoom.Zoom", directory: "manifests/z/Zoom/Zoom", hosts: ["zoom.us", "www.zoom.us"] },
  { id: "teams", name: "Microsoft Teams", publisher: "Microsoft Corporation", manifest: "Microsoft.Teams", directory: "manifests/m/Microsoft/Teams", hosts: ["go.microsoft.com", "statics.teams.cdn.office.net", "officecdn.microsoft.com"] },
  { id: "notepad-plus-plus", name: "Notepad++", publisher: "Notepad++", manifest: "Notepad++.Notepad++", directory: "manifests/n/Notepad++/Notepad++", hosts: ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"] },
];

const safeHttpsUrl = (value, hosts) => {
  let url;
  try { url = new URL(value); } catch { throw new Error("The catalog supplied an invalid installer URL."); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || !hosts.includes(url.hostname.toLowerCase()))
    throw new Error("The installer URL is outside the approved vendor download hosts.");
  return url;
};

async function checkedFetch(fetcher, url, headers = {}) {
  const response = await fetcher(url, { headers: { "User-Agent": "FamilyRMM-DeploymentCatalog/1.0", ...headers }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Catalog source returned HTTP ${response.status}.`);
  return response;
}

function latestVersion(value) {
  return String(value).split(/[.+_-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part.toLowerCase());
}
function compareVersions(a, b) {
  const left = latestVersion(a), right = latestVersion(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0, y = right[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
  }
  return 0;
}
function parseYamlScalar(yaml, key) {
  const match = yaml.match(new RegExp(`^\\s*${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\r\\n#]*))`, "m"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() : "";
}
function parseInstallerBlock(yaml) {
  const start = yaml.indexOf("Installers:");
  if (start < 0) throw new Error("The catalog manifest has no installer entries.");
  const section = yaml.slice(start + "Installers:".length);
  const blocks = section.split(/(?=^\s*-\s+Architecture:)/m).filter((block) => /^\s*-\s+Architecture:/m.test(block));
  const block = blocks.find((candidate) => /^\s*-\s+Architecture:\s*x64\s*$/im.test(candidate));
  if (!block) throw new Error("The catalog has no x64 installer for this application.");
  const field = (key) => parseYamlScalar(block, key);
  const installerUrl = field("InstallerUrl");
  const sha256 = field("InstallerSha256").toLowerCase();
  const rawType = field("InstallerType").toLowerCase() || parseYamlScalar(yaml.slice(0, start), "InstallerType").toLowerCase();
  const extension = new URL(installerUrl).pathname.toLowerCase().split(".").at(-1);
  const packageType = extension === "msi" || rawType === "msi" || rawType === "wix" ? "msi" : extension === "exe" || rawType === "exe" ? "exe" : "";
  if (!/^[a-f0-9]{64}$/.test(sha256) || !packageType) throw new Error("The catalog installer type or SHA-256 is unsupported.");

  const switchMatch = (block + "\n" + yaml.slice(0, start)).match(/^\s*Silent:\s*(?:"([^"]*)"|'([^']*)'|([^\r\n#]*))\s*$/m);
  const silent = (switchMatch?.[1] ?? switchMatch?.[2] ?? switchMatch?.[3] ?? "").trim();
  const installArguments = silent ? (silent.match(/"[^\"]*"|'[^']*'|\S+/g) || []).map((argument) => argument.replace(/^["']|["']$/g, "")) : [];
  if (packageType === "exe" && installArguments.length === 0) throw new Error("The catalog has no vendor-documented silent installation switches.");
  return { installerUrl, sha256, packageType, installArguments };
}

export async function resolveCatalogApplication(appId, fetcher = fetch) {
  const app = APPLICATION_CATALOG.find((item) => item.id === appId);
  if (!app) throw new Error("Catalog application not found.");
  const apiHeaders = { Accept: "application/vnd.github+json" };
  const versionRows = await (await checkedFetch(fetcher, `${WINGET_API}/contents/${app.directory}?ref=master`, apiHeaders)).json();
  const versions = Array.isArray(versionRows) ? versionRows.filter((row) => row.type === "dir" && /^\d[\w.+-]{0,63}$/.test(row.name)).map((row) => row.name) : [];
  const version = versions.sort(compareVersions).at(-1);
  if (!version) throw new Error("No current package manifest is available.");
  const files = await (await checkedFetch(fetcher, `${WINGET_API}/contents/${app.directory}/${encodeURIComponent(version)}?ref=master`, apiHeaders)).json();
  const installerRow = Array.isArray(files) ? files.find((row) => row.type === "file" && row.name === `${app.manifest}.installer.yaml`) : null;
  const localeRow = Array.isArray(files) ? files.find((row) => row.type === "file" && row.name === `${app.manifest}.locale.en-US.yaml`) : null;
  if (!installerRow?.sha) throw new Error("The selected version has no installer manifest.");
  const readBlob = async (sha) => {
    const blob = await (await checkedFetch(fetcher, `${WINGET_API}/git/blobs/${sha}`, apiHeaders)).json();
    if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error("The package manifest blob is invalid.");
    return Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8");
  };
  const installerYaml = await readBlob(installerRow.sha);
  const localeYaml = localeRow?.sha ? await readBlob(localeRow.sha).catch(() => "") : "";
  if (parseYamlScalar(installerYaml, "PackageIdentifier") !== app.manifest || parseYamlScalar(installerYaml, "PackageVersion") !== version)
    throw new Error("The selected manifest identity or version does not match the catalog.");
  const installer = parseInstallerBlock(installerYaml);
  const source = safeHttpsUrl(installer.installerUrl, app.hosts);
  if (app.id === "notepad-plus-plus" && !(source.hostname === "github.com" && source.pathname.startsWith("/notepad-plus-plus/notepad-plus-plus/releases/download/")))
    throw new Error("Notepad++ packages must use the official project release path.");
  return {
    id: app.id, name: app.name, publisher: app.publisher, version,
    description: parseYamlScalar(localeYaml, "ShortDescription") || `Deploy the current vendor release of ${app.name}.`,
    installerUrl: source.href, expectedSha256: installer.sha256, packageType: installer.packageType,
    installArguments: installer.installArguments, allowedHosts: app.hosts,
    installerMode: app.id === "teams" ? "bootstrapper" : "direct",
    deliveryNote: app.id === "teams" ? "Microsoft Teams uses a bootstrapper that downloads and installs a second-stage MSIX package. FamilyRMM verifies the bootstrapper only; it does not pin or hash the second-stage MSIX." : null,
  };
}

export async function downloadCatalogInstaller(application, fetcher = fetch, { timeoutMs = 60_000, maxBytes = MAX_PACKAGE_BYTES } = {}) {
  let current = safeHttpsUrl(application.installerUrl, application.allowedHosts);
  if (application.id === "notepad-plus-plus" && !(current.hostname === "github.com" && current.pathname.startsWith("/notepad-plus-plus/notepad-plus-plus/releases/download/")))
    throw new Error("Notepad++ packages must use the official project release path.");
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetcher(current.href, { redirect: "manual", headers: { "User-Agent": "FamilyRMM-DeploymentCatalog/1.0" }, signal: AbortSignal.timeout(timeoutMs) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 5) throw new Error("The vendor installer URL redirected too many times.");
      current = safeHttpsUrl(new URL(location, current).href, application.allowedHosts);
      continue;
    }
    if (!response.ok) throw new Error(`Vendor download returned HTTP ${response.status}.`);
    break;
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error("The vendor installer exceeds the 250 MiB package limit.");
  const chunks = [];
  let totalBytes = 0;
  if (!response.body) throw new Error("The vendor download did not return a readable package body.");
  for await (const chunk of response.body) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) throw new Error("The vendor installer exceeds the 250 MiB package limit.");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  if (!bytes.length || bytes.length > maxBytes) throw new Error("The vendor installer is empty or exceeds the 250 MiB package limit.");
  const expectedMagic = application.packageType === "msi" ? [0xd0, 0xcf, 0x11, 0xe0] : [0x4d, 0x5a];
  if (!expectedMagic.every((value, index) => bytes[index] === value)) throw new Error("The vendor download does not match its declared installer format.");
  const actualSha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== application.expectedSha256) throw new Error("The vendor installer SHA-256 does not match its package manifest.");
  return { bytes, sha256: actualSha256, fileName: `${application.id}-${application.version}.${application.packageType}` };
}

let catalogCache = { expiresAt: 0, value: null, pending: null };
export async function getApplicationCatalog(fetcher = fetch) {
  if (catalogCache.value && catalogCache.expiresAt > Date.now()) return catalogCache.value;
  if (catalogCache.pending) return catalogCache.pending;
  catalogCache.pending = Promise.all(APPLICATION_CATALOG.map(async (app) => {
    try {
      const resolved = await resolveCatalogApplication(app.id, fetcher);
      return { ...resolved, available: true };
    } catch (error) {
      return { id: app.id, name: app.name, publisher: app.publisher, version: null, description: `Current vendor package is temporarily unavailable. ${String(error.message || "").slice(0, 180)}`, available: false };
    }
  })).then((value) => {
    catalogCache = { value, expiresAt: Date.now() + (value.some((item) => !item.available) ? 60_000 : 30 * 60_000), pending: null };
    return value;
  }).catch((error) => { catalogCache.pending = null; throw error; });
  return catalogCache.pending;
}

export function clearApplicationCatalogCache() { catalogCache = { expiresAt: 0, value: null, pending: null }; }
