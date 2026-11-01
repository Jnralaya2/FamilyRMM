import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, Ban, ChevronDown, Computer, Package, Play, RefreshCw, ShieldCheck, Terminal, Upload, RotateCw } from "lucide-react";

type Device = { id: string; name: string; operatingSystem: string | null; agentVersion: string | null; status: string };
type SoftwarePackage = { id: string; name: string; version: string; publisher: string | null; packageType: "msi" | "exe" | "powershell"; fileSize: number; sha256: string; createdAt: string; revokedAt: string | null; deploymentCount: number };
type Target = { deviceId: string; deviceName: string; state: string; startedAt: string | null; completedAt: string | null; exitCode: number | null; output: string | null; error: string | null; inventoryState: string; inventoryError: string | null; verificationState: string; installedVersion: string | null; rebootRequired: number };
type Job = { id: string; retryOfJobId: string | null; packageName: string; packageVersion: string; action: string; createdAt: string; scheduledFor: string; cancelledAt: string | null; targetCount: number; succeededCount: number; failedCount: number; pendingCount: number; targets: Target[] };
type CatalogApplication = { id: string; name: string; publisher: string; version: string | null; description: string; packageType: "msi" | "exe" | null; available: boolean; deliveryNote: string | null; installerMode: "direct" | "bootstrapper" };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { ...(init?.headers || {}) } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value as T;
}
const shortDate = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
const Status = ({ value }: { value: string }) => <span className={`status-pill ${value.toLowerCase()}`}><i />{value}</span>;
function ApplicationIcon({ id }: { id: string }) {
  if (id === "chrome") return <span className="catalog-app-icon chrome-icon" aria-label="Google Chrome icon"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="#fbbc04"/><path d="M24 24 13 43A22 22 0 0 1 5 13h22l-5 9z" fill="#34a853"/><path d="M5 13A22 22 0 0 1 43 12H21l-5 9z" fill="#ea4335"/><circle cx="24" cy="24" r="10" fill="#4285f4" stroke="#fff" strokeWidth="2"/></svg></span>;
  if (id === "firefox") return <span className="catalog-app-icon firefox-icon" aria-label="Mozilla Firefox icon"><svg viewBox="0 0 48 48"><path d="M39 14c-2-4-6-7-12-8 2 2 3 4 3 6-4-4-9-5-15-3l4 3c-7 1-12 6-13 13-2 12 8 20 19 18 10-2 15-10 13-19-.5-4-2-7-5-10l1 7c-2-3-4-5-8-6 3 3 4 7 3 10-2-2-5-3-8-3 4 2 6 5 5 9-2 5-9 7-14 3-5-4-4-12 2-15l-1-4c6-3 12 0 14 4 1-3 1-6 0-9 4 1 7 4 9 8z" fill="currentColor"/></svg></span>;
  if (id === "7zip") return <span className="catalog-app-icon sevenzip-icon" aria-label="7-Zip icon">7<span>z</span></span>;
  if (id === "vlc") return <span className="catalog-app-icon vlc-icon" aria-label="VLC icon"><svg viewBox="0 0 48 48"><path d="m23 5-4 4 2 5-8 24h22l-8-24 2-5-4-4z" fill="#ef6a32"/><path d="m18 20 12-1 2 6-16 1zM13 33h22l2 6H11z" fill="#fff"/></svg></span>;
  if (id === "acrobat-reader") return <span className="catalog-app-icon adobe-icon" aria-label="Adobe Acrobat Reader icon"><svg viewBox="0 0 48 48"><path d="M25 7 8 39h7l4-8h12l4 8h7L25 7zm0 13 3 6h-6z" fill="currentColor"/></svg></span>;
  if (id === "zoom") return <span className="catalog-app-icon zoom-icon" aria-label="Zoom Workplace icon"><svg viewBox="0 0 48 48"><rect x="6" y="12" width="27" height="24" rx="7" fill="currentColor"/><path d="m34 20 9-6v20l-9-6z" fill="currentColor"/></svg></span>;
  if (id === "teams") return <span className="catalog-app-icon teams-icon" aria-label="Microsoft Teams icon"><svg viewBox="0 0 48 48"><circle cx="35" cy="15" r="6" fill="currentColor" opacity=".65"/><rect x="7" y="14" width="27" height="26" rx="5" fill="currentColor"/><path d="M13 20h15v4h-5v11h-5V24h-5z" fill="#fff"/><path d="M33 23h9v14a3 3 0 0 1-3 3h-6z" fill="currentColor" opacity=".75"/></svg></span>;
  return <span className="catalog-app-icon notepad-icon" aria-label="Notepad++ icon"><svg viewBox="0 0 48 48"><rect x="9" y="5" width="28" height="38" rx="4" fill="currentColor"/><path d="M15 14h16M15 21h16M15 28h9" stroke="#fff" strokeWidth="3" strokeLinecap="round"/><path d="m31 33 8-8 4 4-8 8-5 1z" fill="#f2c94c"/></svg></span>;
}
const supportsDeployments = (version: string | null) => {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/); if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number); return major > 0 || (major === 0 && (minor > 2 || (minor === 2 && patch >= 4)));
};

export default function DeploymentsPage({ csrfToken, onNotice }: { csrfToken: string; onNotice: (message: string) => void }) {
  const [packages, setPackages] = useState<SoftwarePackage[]>([]); const [jobs, setJobs] = useState<Job[]>([]); const [devices, setDevices] = useState<Device[]>([]); const [catalog, setCatalog] = useState<CatalogApplication[]>([]);
  const [selectedPackage, setSelectedPackage] = useState(""); const [selectedCatalogApp, setSelectedCatalogApp] = useState(""); const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [deploymentAction, setDeploymentAction] = useState<"install" | "update">("install");
  const [scheduledFor, setScheduledFor] = useState("");
  const [script, setScript] = useState("# Runs as LocalSystem on each selected computer.\n");
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const headers = { "Content-Type": "application/json", "x-csrf-token": csrfToken };
  const load = useCallback(async () => {
    try {
      const [p, j, firstPage, appCatalog] = await Promise.all([
        request<{ items: SoftwarePackage[] }>("/api/deployment/packages"),
        request<{ items: Job[] }>("/api/deployments"),
        request<{ items: Device[]; total: number }>("/api/devices?page=1&pageSize=100&sort=name&direction=asc"),
        request<{ items: CatalogApplication[] }>("/api/deployment/catalog"),
      ]);
      const pageCount = Math.min(5, Math.ceil(firstPage.total / 100));
      const remaining = pageCount > 1 ? await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => request<{ items: Device[] }>(`/api/devices?page=${index + 2}&pageSize=100&sort=name&direction=asc`))) : [];
      const allDevices = [...firstPage.items, ...remaining.flatMap((page) => page.items)].slice(0, 500);
      setPackages(p.items); setJobs(j.items); setDevices(allDevices); setCatalog(appCatalog.items); setError("");
      if (!selectedCatalogApp && (!selectedPackage || !p.items.some((item) => item.id === selectedPackage && !item.revokedAt))) setSelectedPackage(p.items.find((item) => !item.revokedAt)?.id || "");
      setSelectedDevices((current) => current.filter((id) => allDevices.some((device) => device.id === id && device.status !== "Revoked" && supportsDeployments(device.agentVersion))));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load deployment data."); }
    finally { setLoading(false); }
  }, [selectedPackage, selectedCatalogApp]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 10000); return () => clearInterval(timer); }, [load]);

  const uploadPackage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const file = data.get("installer");
    if (!(file instanceof File) || !file.size) { setError("Choose an MSI or EXE installer first."); return; }
    if (file.size > 250 * 1024 * 1024) { setError("Software installers are limited to 250 MiB."); return; }
    const packageType = String(data.get("packageType"));
    const argumentText = String(data.get("installArguments") || "").trim();
    const installArguments = argumentText ? (argumentText.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((part) => part.replace(/^("|')|("|')$/g, "")) : [];
    setBusy(true); setError("");
    try {
      const metadata = { name: String(data.get("name") || ""), version: String(data.get("version") || ""), publisher: String(data.get("publisher") || ""), packageType, installArguments };
      await request("/api/deployment/packages", { method: "POST", headers: { "x-csrf-token": csrfToken, "Content-Type": "application/octet-stream", "x-package-metadata": JSON.stringify(metadata) }, body: file });
      form.reset(); await load(); onNotice(`${metadata.name} ${metadata.version} added to the software catalog.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not upload software package."); }
    finally { setBusy(false); }
  };
  const createScript = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); setBusy(true); setError("");
    try {
      await request("/api/deployment/scripts", { method: "POST", headers, body: JSON.stringify({ name: data.get("name"), version: data.get("version"), script }) });
      form.reset(); setScript("# Runs as LocalSystem on each selected computer.\n"); await load(); onNotice("PowerShell script added to the deployment catalog.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save script."); }
    finally { setBusy(false); }
  };
  const queueDeployment = async () => {
    if ((!selectedPackage && !selectedCatalogApp) || !selectedDevices.length) return;
    const item = packages.find((pkg) => pkg.id === selectedPackage);
    const app = catalog.find((entry) => entry.id === selectedCatalogApp);
    if (!item && !app) return;
    const action = item?.packageType === "powershell" ? "script" : deploymentAction;
    setBusy(true); setError("");
    try {
      const result = selectedCatalogApp
        ? await request<{ targetCount: number; scheduledFor: string }>(`/api/deployment/catalog/${selectedCatalogApp}/deploy`, { method: "POST", headers, body: JSON.stringify({ deviceIds: selectedDevices, scheduledFor: scheduledFor || undefined }) })
        : await request<{ targetCount: number; scheduledFor: string }>("/api/deployments", { method: "POST", headers, body: JSON.stringify({ packageId: selectedPackage, deviceIds: selectedDevices, action, timeoutSeconds: 1800, scheduledFor: scheduledFor || undefined }) });
      setSelectedDevices([]); setScheduledFor(""); await load(); onNotice(`${new Date(result.scheduledFor).getTime() > Date.now() + 60_000 ? "Deployment scheduled" : "Deployment queued"} for ${result.targetCount} computer${result.targetCount === 1 ? "" : "s"}.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not queue deployment."); }
    finally { setBusy(false); }
  };
  const retryFailed = async (id: string, targetDeviceIds?: string[]) => {
    setBusy(true); setError("");
    try {
      const result = await request<{ targetCount: number }>(`/api/deployments/${id}/retry`, { method: "POST", headers, body: JSON.stringify(targetDeviceIds ? { targetDeviceIds } : {}) });
      await load(); onNotice(`Retry queued for ${result.targetCount} computer${result.targetCount === 1 ? "" : "s"}. Original deployment history was retained.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not retry failed deployment."); }
    finally { setBusy(false); }
  };
  const cancelQueued = async (id: string) => {
    setBusy(true); setError("");
    try { const result = await request<{ cancelledTargets: number; activeTargets: number }>(`/api/deployments/${id}/cancel`, { method: "POST", headers, body: "{}" }); await load(); onNotice(`Cancelled ${result.cancelledTargets} queued target${result.cancelledTargets === 1 ? "" : "s"}.${result.activeTargets ? " Started work was left running safely." : ""}`); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not cancel queued deployments."); }
    finally { setBusy(false); }
  };
  const revokePackage = async (id: string) => {
    setBusy(true); setError("");
    try { await request(`/api/deployment/packages/${id}/revoke`, { method: "POST", headers, body: "{}" }); await load(); onNotice("Package revoked; queued deployments were cancelled."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not revoke software package."); }
    finally { setBusy(false); }
  };
  const toggleDevice = (id: string) => setSelectedDevices((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const selected = packages.find((item) => item.id === selectedPackage);
  const validDevices = devices.filter((device) => !["Revoked", "Pending approval", "Rejected"].includes(device.status));
  const eligibleDevices = validDevices.filter((device) => supportsDeployments(device.agentVersion));
  const selectedApp = catalog.find((application) => application.id === selectedCatalogApp);

  return <>
    <div className="page-heading"><div><div className="eyebrow">SOFTWARE OPERATIONS</div><h1>Software &amp; deployments</h1><p>Upload approved installers or scripts, then queue jobs to enrolled computers.</p></div><div className="heading-actions"><span className="updated-note">Agent polls about every minute</span><button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} />Refresh</button></div></div>
    <div className="enrollment-callout deployment-callout"><span className="enrollment-callout-icon"><ShieldCheck size={18} /></span><div><strong>Administrator-authorized deployment</strong><p>Installers and PowerShell scripts run as the Windows agent service (LocalSystem). Choose only software and computers you are authorized to manage. Jobs are signed, device-authenticated, and recorded in the audit log.</p></div><span className="integration-badge">SIGNED · AUDITED</span></div>
    {error && <div className="table-error"><AlertCircle size={16} /><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}
    <section className="panel application-catalog-panel"><div className="panel-heading"><div><h2>Application catalog</h2><p>Select a verified vendor release, then choose one or more computers.</p></div><span className="catalog-trust-note"><ShieldCheck size={14} />Vendor hash + Authenticode verification</span></div>
      <div className="application-catalog-grid">{catalog.map((app) => <article className={`application-catalog-card ${selectedCatalogApp === app.id ? "selected" : ""}`} key={app.id}>
        <div className="application-catalog-card-top"><ApplicationIcon id={app.id} /><span className={`catalog-availability ${app.available ? "available" : "unavailable"}`}>{app.available ? "Ready" : "Unavailable"}</span></div>
        <h3>{app.name}</h3><p className="catalog-publisher">{app.publisher}</p><p className="catalog-description">{app.description}</p>{app.deliveryNote && <p className="deployment-update-note">{app.deliveryNote}</p>}
        <div className="catalog-version-row"><span>Version</span><strong>{app.version || "Not available"}</strong></div>
        <button className={selectedCatalogApp === app.id ? "primary-button" : "secondary-button"} disabled={busy || !app.available} onClick={() => { setSelectedCatalogApp(app.id); setSelectedPackage(""); setDeploymentAction("install"); document.getElementById("deployment-targets")?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>{selectedCatalogApp === app.id ? "Selected" : app.available ? "Select application" : "Temporarily unavailable"}</button>
      </article>)}</div>
    </section>
    <div className="deployment-builder-grid">
      <section className="panel enrollment-create"><div className="panel-heading"><div><h2>Upload application installer</h2><p>Add a Windows MSI or EXE to the approved catalog.</p></div><Package size={17} /></div>
        <form className="enrollment-form" onSubmit={(event) => void uploadPackage(event)}><div className="form-row"><label>Application name<input name="name" required maxLength={200} placeholder="Example App" /></label><label>Version<input name="version" required maxLength={100} placeholder="2.4.1" /></label></div><div className="form-row"><label>Package type<select name="packageType"><option value="msi">Windows Installer (.msi)</option><option value="exe">Executable installer (.exe)</option></select></label><label>Publisher<input name="publisher" required maxLength={200} placeholder="Signer name shown by Windows" /></label></div><label>Silent install arguments<input name="installArguments" placeholder="For EXE installers, enter vendor-supported quiet flags" /><small>Publisher must match the Windows-trusted Authenticode signer. MSI runs quietly with restart suppressed.</small></label><label>Installer file<input name="installer" type="file" accept=".msi,.exe" required /><small>Maximum 250 MiB. SHA-256 and Authenticode are checked before execution.</small></label><div className="form-foot"><span><ShieldCheck size={14} />Unsigned or wrong-publisher files are rejected by the agent.</span><button className="primary-button" disabled={busy}><Upload size={15} />Add to catalog</button></div></form>
      </section>
      <section className="panel enrollment-create"><div className="panel-heading"><div><h2>Create PowerShell script</h2><p>Save an administrator-authored install or maintenance script.</p></div><Terminal size={17} /></div>
        <form className="enrollment-form" onSubmit={(event) => void createScript(event)}><div className="form-row"><label>Script name<input name="name" required maxLength={200} placeholder="Install prerequisite" /></label><label>Version<input name="version" defaultValue="1" required maxLength={100} /></label></div><label>PowerShell source<textarea className="deployment-script-editor" value={script} onChange={(event) => setScript(event.target.value)} maxLength={32 * 1024} required spellCheck={false} /></label><div className="form-foot"><span>Runs as LocalSystem · up to 30 minutes</span><button className="primary-button" disabled={busy}><Terminal size={15} />Save script</button></div></form>
      </section>
    </div>
    <section className="panel enrollment-policy-list"><div className="panel-heading"><div><h2>Software catalog</h2><p>Choose a package version to deploy to a computer or selected group.</p></div><span className="pending-count">{packages.length}</span></div>
      {loading ? <div className="table-skeleton" /> : packages.length ? <div className="table-scroll"><table className="device-table deployment-table"><thead><tr><th>APPLICATION</th><th>TYPE</th><th>SIZE</th><th>SHA-256</th><th>DEPLOYMENTS</th><th>CREATED</th><th /></tr></thead><tbody>{packages.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small className="table-subline">v{item.version}{item.publisher ? ` · ${item.publisher}` : ""}</small></td><td>{item.packageType.toUpperCase()}</td><td>{formatBytes(item.fileSize)}</td><td><code title={item.sha256}>{item.sha256.slice(0, 12)}…</code></td><td>{item.deploymentCount}</td><td>{shortDate(item.createdAt)}</td><td className="deployment-actions">{item.revokedAt ? <Status value="Revoked" /> : <><button className={selectedPackage === item.id ? "primary-button" : "secondary-button"} disabled={busy} onClick={() => { setSelectedCatalogApp(""); setSelectedPackage(item.id); document.getElementById("deployment-targets")?.scrollIntoView({ behavior: "smooth", block: "center" }); }}><Play size={14} />Deploy</button><button className="secondary-button" disabled={busy} title="Revoke future downloads and cancel queued jobs; deployment history is retained" onClick={() => void revokePackage(item.id)}>Revoke</button></>}</td></tr>)}</tbody></table></div> : <div className="compact-empty"><Package size={19} /><strong>No software packages yet</strong><small>Curated applications are available above; add a custom MSI or EXE if required.</small></div>}
    </section>
    <section className="panel deployment-target-panel" id="deployment-targets"><div className="panel-heading"><div><h2>Target computers</h2><p>{selectedApp ? `Application: ${selectedApp.name} v${selectedApp.version}` : selected ? `Package: ${selected.name} v${selected.version} · ${selected.packageType.toUpperCase()}` : "Choose an application or package above, then select computers."}</p></div><span className="pending-count">{selectedDevices.length}</span></div>
      {validDevices.length ? <><div className="deployment-target-toolbar"><button className="text-button" onClick={() => setSelectedDevices(selectedDevices.length === eligibleDevices.length ? [] : eligibleDevices.map((d) => d.id))}>{selectedDevices.length === eligibleDevices.length ? "Clear selection" : "Select all"}</button>{selected && selected.packageType !== "powershell" && !selectedApp && <label className="deployment-mode">Action<select aria-label="Deployment action" value={deploymentAction} onChange={(event) => setDeploymentAction(event.target.value as "install" | "update")}><option value="install">Install</option><option value="update">Update installed application</option></select></label>}<span>{eligibleDevices.filter((d) => d.status === "Online").length} eligible online · {eligibleDevices.length} eligible</span></div>{validDevices.length > eligibleDevices.length && <p className="deployment-update-note">{validDevices.length - eligibleDevices.length} computer(s) need Family RMM Agent 0.2.4 or newer before deployment.</p>}{deploymentAction === "update" && selected && !selectedApp && selected.packageType !== "powershell" && <p className="deployment-update-note">Update checks that the selected application appears in each target’s latest software inventory before queuing.</p>}<div className="deployment-device-list">{validDevices.map((device) => { const supported = supportsDeployments(device.agentVersion); return <label key={device.id} className="deployment-device-option"><input type="checkbox" disabled={!supported || busy} checked={selectedDevices.includes(device.id)} onChange={() => toggleDevice(device.id)} /><span className="device-cell"><span className="device-glyph"><Computer size={15} /></span><span><strong>{device.name}</strong><small>{device.operatingSystem || "Windows"} · {device.status} · agent {device.agentVersion || "unknown"}{!supported ? " · update required" : ""}</small></span></span><Status value={device.status} /></label>; })}</div><div className="deployment-submit-row"><label className="deployment-mode">Schedule (optional)<input aria-label="Schedule deployment" type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} min={new Date().toISOString().slice(0, 16)} disabled={busy} /></label><span>{scheduledFor ? `Agents can claim this job after ${new Date(scheduledFor).toLocaleString()}.` : selectedDevices.some((id) => validDevices.find((d) => d.id === id)?.status !== "Online") ? "Offline devices stay queued until they check in." : "Online devices receive jobs at their next agent poll."}</span><button className="primary-button" disabled={busy || (!selected && !selectedApp) || !selectedDevices.length || Boolean(selected?.revokedAt) || Boolean(selectedApp && !selectedApp.available)} onClick={() => void queueDeployment()}><Play size={15} />{scheduledFor ? "Schedule" : "Deploy to"} {selectedDevices.length} computer{selectedDevices.length === 1 ? "" : "s"}</button></div></> : <div className="compact-empty"><Computer size={19} /><strong>No enrolled computers</strong><small>Computers must enroll before deployment tasks can be assigned.</small></div>}
    </section>
    <section className="panel enrollment-policy-list"><div className="panel-heading"><div><h2>Deployment activity</h2><p>Live device-reported progress, results, and retry history. Status refreshes every 10 seconds.</p></div><span className="pending-count">{jobs.length}</span></div>
      {jobs.length ? <div className="deployment-job-list">{jobs.map((job) => <details className="deployment-job" key={job.id}><summary><span className="deployment-job-name"><strong>{job.packageName} v{job.packageVersion}</strong><small>{job.action.toUpperCase()} · {new Date(job.scheduledFor).getTime() > Date.now() + 60_000 ? `scheduled ${shortDate(job.scheduledFor)}` : shortDate(job.createdAt)}{job.retryOfJobId ? ` · retry of ${job.retryOfJobId.slice(0, 8)}` : ""}</small></span><span className="deployment-job-counts">{job.pendingCount} pending · {job.succeededCount} succeeded · {job.failedCount} failed</span><ChevronDown size={15} /></summary><div className="table-scroll"><table className="device-table"><thead><tr><th>COMPUTER</th><th>STATUS</th><th>STARTED</th><th>COMPLETED</th><th>RESULT</th><th /></tr></thead><tbody>{job.targets.map((target) => <tr key={`${job.id}-${target.deviceId}`}><td>{target.deviceName}</td><td><Status value={target.state} /></td><td>{shortDate(target.startedAt)}</td><td>{shortDate(target.completedAt)}</td><td>{target.error || (target.exitCode !== null ? `Exit code ${target.exitCode}${target.rebootRequired ? " · reboot required" : ""}` : target.output || "Waiting for agent")}{target.state === "succeeded" && <small className="table-subline">Inventory: {target.inventoryState}{target.installedVersion ? ` · installed ${target.installedVersion}` : ""}{target.verificationState === "not_found" ? " · app not detected" : ""}{target.inventoryError ? ` · ${target.inventoryError}` : ""}</small>}</td><td>{target.state === "failed" && <button className="secondary-button retry-target-button" disabled={busy} onClick={() => void retryFailed(job.id, [target.deviceId])}><RotateCw size={13} />Retry</button>}</td></tr>)}</tbody></table></div>{job.failedCount > 0 && <div className="deployment-submit-row"><span>Retry creates a new attempt; this result remains in history.</span><button className="secondary-button" disabled={busy} onClick={() => void retryFailed(job.id)}><RotateCw size={14} />Retry all failed ({job.failedCount})</button></div>}{job.targets.some((target) => target.state === "queued") && <div className="deployment-submit-row"><span>Only queued tasks can be cancelled. Delivered or running installers continue safely.</span><button className="secondary-button" disabled={busy} onClick={() => void cancelQueued(job.id)}><Ban size={14} />Cancel queued targets</button></div>}</details>)}</div> : <div className="compact-empty"><Play size={18} /><strong>No deployments queued</strong><small>Each target result appears here as agents check in.</small></div>}
    </section>
  </>;
}
