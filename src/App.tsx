import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import DeploymentsPage from "./DeploymentsPage";
import {
  Activity, AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, BadgePlus, ChevronDown,
  ChevronLeft, ChevronRight, CircleHelp, Clock3, Command, Computer,
  Download, LayoutDashboard, LoaderCircle, LogOut, MonitorCheck, RefreshCw,
  Search, Server, Share2, ShieldCheck, ShieldEllipsis, SlidersHorizontal, ScrollText, Wifi,
  Package,
  X,
} from "lucide-react";

type AuthInfo = { setupRequired: boolean; authenticated: boolean; purchaseContact: string; administrator: { id: string; email: string; role: string; organizationId: string; workspaceName: string; deviceLimit: number | null; sessionLimit: number | null; licenseStatus: string } | null; csrfToken: string | null };
type Device = { id: string; name: string; operatingSystem: string | null; osVersion: string | null; architecture: string | null; manufacturer: string | null; model: string | null; cpu: string | null; cpuCores: number | null; totalMemoryMB: number | null; ipAddresses: string[]; agentVersion: string | null; lastSeen: string | null; softwareInventoryAt?: string | null; enrolledAt: string; status: string; cpuUsagePercent?: number | null; memoryUsagePercent?: number | null };
type Overview = { totalDevices: number; onlineDevices: number; offlineDevices: number; revokedDevices: number; lastCheckIn: string | null; performance: { hour: string; cpu: number | null; memory: number | null }[] };
type Page = "overview" | "devices" | "deployments" | "enrollment" | "downloads" | "audit" | "licenses" | "screenconnect";
type Health = { status: "ok" | "degraded"; database: "connected" | "unavailable"; checkedAt: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { ...(init?.headers || {}) } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value as T;
}
const timeAgo = (value: string | null) => {
  if (!value) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};
const shortDate = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "No check-in yet";
const deviceLabel = (device: Device) => [device.manufacturer, device.model].filter(Boolean).join(" ") || device.operatingSystem || "Computer";

export default function App() {
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [authError, setAuthError] = useState("");
  const [health, setHealth] = useState<"checking" | "ok" | "error">("checking");
  const [healthInfo, setHealthInfo] = useState<Health | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [toast, setToast] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);

  const refreshAuth = useCallback(async () => {
    try { setAuth(await request<AuthInfo>("/api/auth/status")); setAuthError(""); }
    catch { setAuthError("The application server is unavailable. Start it again and refresh this page."); }
  }, []);
  const refreshHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/health", { credentials: "same-origin" });
      const value = await response.json() as Health;
      setHealthInfo(value);
      setHealth(response.ok && value.status === "ok" ? "ok" : "error");
    } catch { setHealth("error"); setHealthInfo(null); }
  }, []);
  useEffect(() => { void refreshAuth(); void refreshHealth(); const id = window.setInterval(refreshHealth, 30000); return () => clearInterval(id); }, [refreshAuth, refreshHealth]);

  const showToast = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(""), 3500); }, []);
  const onLogout = async () => {
    try { await request("/api/auth/logout", { method: "POST", headers: { "x-csrf-token": auth?.csrfToken || "" } }); await refreshAuth(); }
    catch (error) { showToast(error instanceof Error ? error.message : "Sign out failed."); }
  };

  if (!auth) return <div className="startup"><div className="startup-mark"><Activity size={20} /></div><span>{authError || "Starting operations console"}</span><LoaderCircle className="spin" size={17} /></div>;
  if (!auth.authenticated) return <AuthScreen setupRequired={auth.setupRequired} purchaseContact={auth.purchaseContact} onSuccess={refreshAuth} />;
  const isPlatformOwner = auth.administrator?.role === "platform_owner";
  const canDeploy = ["platform_owner", "owner", "administrator"].includes(auth.administrator?.role || "");

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Activity size={19} strokeWidth={2.5} /></div><div><div className="brand-name">family<span>rmm</span></div><div className="brand-caption">OPERATIONS CONSOLE</div></div></div>
      <div className="workspace-label">WORKSPACE</div>
      <div className="workspace-select"><div className="workspace-avatar">{auth.administrator?.workspaceName.slice(0, 1).toUpperCase()}</div><span><strong>{auth.administrator?.workspaceName}</strong><small>Unlimited devices</small></span></div>
      <div className="nav-label">MONITORING</div>
      <nav className="main-nav" aria-label="Main navigation">
        <button aria-label="Overview" className={`nav-item ${page === "overview" ? "selected" : ""}`} onClick={() => setPage("overview")}><LayoutDashboard size={17} /><span>Overview</span></button>
        <button aria-label="Devices" className={`nav-item ${page === "devices" ? "selected" : ""}`} onClick={() => setPage("devices")}><Computer size={17} /><span>Devices</span></button>
        {canDeploy && <button aria-label="Deployments" className={`nav-item ${page === "deployments" ? "selected" : ""}`} onClick={() => setPage("deployments")}><Package size={17} /><span>Software &amp; deployments</span></button>}
        <button aria-label="Enrollment" className={`nav-item ${page === "enrollment" ? "selected" : ""}`} onClick={() => setPage("enrollment")}><BadgePlus size={17} /><span>Enrollment</span></button>
        <button aria-label="Downloads" className={`nav-item ${page === "downloads" ? "selected" : ""}`} onClick={() => setPage("downloads")}><Download size={17} /><span>Downloads</span></button>
        <button aria-label="Audit log" className={`nav-item ${page === "audit" ? "selected" : ""}`} onClick={() => setPage("audit")}><ScrollText size={17} /><span>Audit log</span></button>
        {isPlatformOwner && <button aria-label="Customer licenses" className={`nav-item ${page === "licenses" ? "selected" : ""}`} onClick={() => setPage("licenses")}><ShieldCheck size={17} /><span>Customer licenses</span></button>}
        <button aria-label="ScreenConnect instances" className={`nav-item ${page === "screenconnect" ? "selected" : ""}`} onClick={() => setPage("screenconnect")}><Server size={17} /><span>ScreenConnect</span></button>
      </nav>
      <div className="sidebar-bottom">
        <div className="connection-card"><div className={`connection-dot ${health}`} /><span><strong>{health === "ok" ? "Server connected" : health === "error" ? "Connection issue" : "Connecting"}</strong><small>{health === "ok" ? "Family RMM service" : "Checking service"}</small></span><Wifi size={15} /></div>
        <button className="profile" onClick={onLogout} title="Sign out"><div className="profile-avatar">{auth.administrator?.email.slice(0, 1).toUpperCase()}</div><span><strong>{auth.administrator?.email}</strong><small>{isPlatformOwner ? "Platform owner" : "Workspace owner"}</small></span><LogOut size={16} /></button>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <div className="breadcrumbs"><span>{auth.administrator?.workspaceName}</span><span className="crumb-sep">/</span><strong>{page === "overview" ? "Overview" : page === "devices" ? "Devices" : page === "deployments" ? "Software & deployments" : page === "enrollment" ? "Enrollment" : page === "downloads" ? "Windows downloads" : page === "licenses" ? "Customer licenses" : page === "screenconnect" ? "ScreenConnect" : "Audit log"}</strong></div>
        <div className="topbar-actions"><span className="environment-tag"><span />{health === "ok" ? "SERVICE ONLINE" : health === "error" ? "SERVICE ISSUE" : "CONNECTING"}</span><button className="icon-button" title="Help" onClick={() => setHelpOpen(true)}><CircleHelp size={17} /></button><span className="top-avatar" aria-label="Current administrator">{auth.administrator?.email.slice(0, 1).toUpperCase()}</span></div>
      </header>
      <div className="page-content">
        {page === "overview" ? <OverviewPage onOpenDevices={() => setPage("devices")} onOpenEnrollment={() => setPage("enrollment")} showOwnerInstallers={isPlatformOwner} csrfToken={auth.csrfToken || ""} health={healthInfo} /> : page === "devices" ? <DevicesPage onNotice={showToast} /> : page === "deployments" && canDeploy ? <DeploymentsPage csrfToken={auth.csrfToken || ""} onNotice={showToast} /> : page === "enrollment" ? <EnrollmentPage csrfToken={auth.csrfToken || ""} onNotice={showToast} /> : page === "downloads" ? <WindowsDownloadsPage csrfToken={auth.csrfToken || ""} onNotice={showToast} /> : page === "licenses" && isPlatformOwner ? <LicenseManagement csrfToken={auth.csrfToken || ""} onNotice={showToast} /> : page === "screenconnect" ? <ScreenConnectPage csrfToken={auth.csrfToken || ""} onNotice={showToast} /> : <AuditPage />}
      </div>
    </main>
    {toast && <div className="toast" role="status"><ShieldCheck size={16} />{toast}</div>}
    {helpOpen && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setHelpOpen(false)}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><button className="icon-button modal-close" onClick={() => setHelpOpen(false)} aria-label="Close help"><X size={18} /></button><div className="empty-icon"><CircleHelp size={19} /></div><h2 id="help-title">Operations console</h2><p>This first release includes the live Overview and Devices inventory, backed by the local RMM API and database.</p><div className="help-note"><ShieldCheck size={16} /><span>Only real agent check-ins appear here. No sample devices are inserted.</span></div><button className="primary-button" onClick={() => setHelpOpen(false)}>Close</button></section></div>}
  </div>;
}

function AuthScreen({ setupRequired, purchaseContact, onSuccess }: { setupRequired: boolean; purchaseContact: string; onSuccess: () => Promise<void> }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [setupToken, setSetupToken] = useState("");
  const [workspace, setWorkspace] = useState(""); const [licenseKey, setLicenseKey] = useState(""); const [registerMode, setRegisterMode] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (setupRequired) await request("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json", "x-setup-token": setupToken }, body: JSON.stringify({ email, password }) });
      else if (registerMode) await request("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, workspace, licenseKey }) });
      else await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      await onSuccess();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to continue."); }
    finally { setBusy(false); }
  };
  return <div className="auth-screen"><div className="auth-panel"><div className="brand auth-brand"><div className="brand-mark"><Activity size={19} strokeWidth={2.5} /></div><div><div className="brand-name">family<span>rmm</span></div><div className="brand-caption">OPERATIONS CONSOLE</div></div></div>
    <div className="auth-copy"><p className="eyebrow">SECURE DEVICE OPERATIONS</p><h1>{setupRequired ? "Set up your workspace" : registerMode ? "Activate your license" : "Welcome back"}</h1><p>{setupRequired ? "Create the owner account for this RMM instance." : registerMode ? "Create your private monitoring workspace with the one-time license you purchased." : "Sign in to continue to your device operations console."}</p></div>
    <form className="auth-form" onSubmit={submit}>
      {setupRequired && <label>One-time setup token<input value={setupToken} onChange={(e) => setSetupToken(e.target.value)} autoComplete="off" required placeholder="Copy from the local server terminal" /><small>The token is printed once when the server starts for first-time setup.</small></label>}
      {registerMode && <><label>Workspace name<input value={workspace} onChange={(e) => setWorkspace(e.target.value)} maxLength={100} required placeholder="My home computers" /></label><label>One-time license key<input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value.toUpperCase())} autoComplete="off" required placeholder="FRMM-…" /></label></>}
      <label>Email address<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required placeholder="you@company.com" /></label>
      <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setupRequired || registerMode ? "new-password" : "current-password"} required minLength={setupRequired || registerMode ? 12 : 1} placeholder={setupRequired || registerMode ? "At least 12 characters" : "Enter your password"} /></label>
      {error && <div className="form-error"><AlertCircle size={16} />{error}</div>}
      <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : null}{setupRequired ? "Create owner account" : registerMode ? "Activate license and create account" : "Sign in"}</button>
    </form>{!setupRequired && <><button className="text-button" onClick={() => { setRegisterMode((value) => !value); setError(""); }}>{registerMode ? "Already have an account? Sign in" : "Bought a license? Create your workspace"}</button>{!registerMode && <p className="purchase-contact">Need a license? {purchaseContact ? <a href={purchaseContact}>Contact us to buy one</a> : "Contact the Family RMM owner to purchase a license."}</p>}</>}<div className="auth-foot"><ShieldCheck size={15} />Protected administrator access</div>
  </div><div className="auth-side"><div className="auth-side-top">FAMILY SYSTEMS <span>RMM</span></div><div className="auth-art"><div className="art-ring ring-one" /><div className="art-ring ring-two" /><div className="art-core"><Server size={36} /></div><div className="art-node node-a"><MonitorCheck size={18} /></div><div className="art-node node-b"><ShieldCheck size={18} /></div><div className="art-node node-c"><Activity size={18} /></div></div><div className="auth-side-copy"><h2>Visibility across your<br />managed environment.</h2><p>A secure operations workspace for computers you are authorized to administer.</p></div><div className="auth-side-foot">SECURE BY DESIGN <span>•</span> SELF-HOSTED CONTROL</div></div></div>;
}

type LicenseItem = { id: string; label: string; deviceLimit: number; sessionLimit: number; status: string; createdAt: string; redeemedAt: string | null; workspaceName: string | null; activeDevices: number };
function LicenseManagement({ csrfToken, onNotice }: { csrfToken: string; onNotice: (message: string) => void }) {
  const [items, setItems] = useState<LicenseItem[]>([]); const [label, setLabel] = useState("");
  const [purchaseContact, setPurchaseContact] = useState("");
  const [newKey, setNewKey] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const load = useCallback(async () => { try { const [value, status] = await Promise.all([request<{ items: LicenseItem[] }>("/api/licenses"), request<AuthInfo>("/api/auth/status")]); setItems(value.items); setPurchaseContact(status.purchaseContact || ""); } catch (e) { setError(e instanceof Error ? e.message : "Could not load licenses."); } }, []);
  useEffect(() => { void load(); }, [load]);
  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setNewKey("");
    try { const value = await request<{ key: string }>("/api/licenses", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ label }) }); setNewKey(value.key); setLabel(""); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "License creation failed."); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    if (!window.confirm("Revoke this license? Its workspace and agents will lose access immediately.")) return;
    setBusy(true); setError("");
    try { await request(`/api/licenses/${id}/revoke`, { method: "POST", headers: { "x-csrf-token": csrfToken } }); await load(); onNotice("License revoked."); }
    catch (e) { setError(e instanceof Error ? e.message : "License revocation failed."); }
    finally { setBusy(false); }
  };
  const savePurchaseContact = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { const value = await request<{ purchaseContact: string }>("/api/platform-settings/purchase-contact", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ url: purchaseContact }) }); setPurchaseContact(value.purchaseContact); onNotice("Purchase contact link saved."); }
    catch (e) { setError(e instanceof Error ? e.message : "Purchase contact could not be saved."); }
    finally { setBusy(false); }
  };
  return <>
    <div className="page-heading"><div><div className="eyebrow">CUSTOMER ACCESS</div><h1>Customer licenses</h1><p>Create one-time license keys after payment. A key is shown only once and can be redeemed for one workspace.</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => void load()} disabled={busy}><RefreshCw size={15} />Refresh</button></div></div>
    <section className="panel enrollment-create"><div className="panel-heading"><div><h2>Public purchase contact</h2><p>Visitors without a key will see this link on the sign-in screen.</p></div><ShieldCheck size={17} /></div>
      <form className="enrollment-form" onSubmit={(event) => void savePurchaseContact(event)}><label>Purchase link<input type="text" value={purchaseContact} onChange={(event) => setPurchaseContact(event.target.value)} maxLength={500} placeholder="https://wa.me/233… or mailto:sales@example.com" /><small>Use an HTTPS link, email link (mailto:), or phone link (tel:). Leave blank to clear it.</small></label><div className="form-foot"><span>Share a public business contact address.</span><button className="secondary-button" disabled={busy}>Save purchase contact</button></div></form>
      {error && <div className="form-error"><AlertCircle size={16} />{error}</div>}
    </section>
    <section className="panel enrollment-create"><div className="panel-heading"><div><h2>Issue a license</h2><p>Set this customer’s permanent device and concurrent sign-in limits.</p></div><ShieldCheck size={17} /></div>
      <form className="enrollment-form" onSubmit={(event) => void create(event)}><div className="form-row"><label>License label<input value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={100} placeholder="Workspace access" /></label></div><div className="form-foot"><span>All workspaces have unlimited device enrollment and administrator sessions.</span><button className="primary-button" disabled={busy}><BadgePlus size={15} />Generate key</button></div></form>
      {newKey && <div className="license-key-panel"><strong>Copy this key and send it to the customer now</strong><code>{newKey}</code><small>It cannot be displayed again. Keep a secure record of which order it was issued for.</small></div>}
      {error && <div className="form-error"><AlertCircle size={16} />{error}</div>}
    </section>
    <section className="panel enrollment-policy-list"><div className="panel-heading"><div><h2>Issued licenses</h2><p>Available keys and activated customer workspaces.</p></div><span className="pending-count">{items.length}</span></div>
      {items.length ? <div className="table-scroll"><table className="device-table"><thead><tr><th>ACCESS KEY</th><th>WORKSPACE</th><th>DEVICES</th><th>STATUS</th><th>CREATED</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.label}</strong></td><td>{item.workspaceName || "Not redeemed"}</td><td>{item.activeDevices} · Unlimited</td><td><StatusPill status={item.status === "active" ? "Active" : item.status === "revoked" ? "Revoked" : "Available"} /></td><td>{shortDate(item.redeemedAt || item.createdAt)}</td><td>{item.status !== "revoked" && <button className="secondary-button" disabled={busy} onClick={() => void revoke(item.id)}>Revoke</button>}</td></tr>)}</tbody></table></div> : <div className="compact-empty"><strong>No access keys issued</strong><small>Generate a workspace access key.</small></div>}
    </section>
  </>;
}

type ScreenConnectInstance = { id: string; name: string; baseUrl: string; deploymentType: "cloud" | "self_hosted"; version: string | null; enabled: boolean; credentialConfigured: boolean; integrationStatus: string; capabilities: string[]; createdAt?: string };
function ScreenConnectPage({ csrfToken, onNotice }: { csrfToken: string; onNotice: (message: string) => void }) {
  const [items, setItems] = useState<ScreenConnectInstance[]>([]); const [name, setName] = useState(""); const [baseUrl, setBaseUrl] = useState(""); const [deploymentType, setDeploymentType] = useState<"cloud" | "self_hosted">("cloud"); const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const load = useCallback(async () => { try { const result = await request<{ items: ScreenConnectInstance[] }>("/api/screenconnect/instances"); setItems(result.items); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Could not load instances."); } }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await request("/api/screenconnect/instances", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ name, baseUrl, deploymentType, version }) }); setName(""); setBaseUrl(""); setVersion(""); await load(); onNotice("ScreenConnect instance saved to your workspace."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save the instance."); }
    finally { setBusy(false); }
  };
  const remove = async (item: ScreenConnectInstance) => {
    if (!window.confirm(`Remove ScreenConnect instance “${item.name}”?`)) return;
    setBusy(true); setError("");
    try { await request(`/api/screenconnect/instances/${item.id}`, { method: "DELETE", headers: { "x-csrf-token": csrfToken } }); await load(); onNotice("ScreenConnect instance removed."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not remove the instance."); }
    finally { setBusy(false); }
  };
  return <>
    <div className="page-heading"><div><div className="eyebrow">REMOTE ACCESS CONNECTOR</div><h1>ScreenConnect instances</h1><p>Add the instances your workspace is authorized to use.</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => void load()} disabled={busy}><RefreshCw size={15} />Refresh</button></div></div>
    <div className="inline-error"><AlertCircle size={17} /><span>Instances are saved to your workspace. Live authentication, session sync, device linking, deployment, and host-session launch require a compatible ScreenConnect adapter and are not active yet.</span></div>
    <section className="panel enrollment-create"><div className="panel-heading"><div><h2>Add an instance</h2><p>Enter the canonical HTTPS URL. You can add more than one instance.</p></div><Server size={17} /></div>
      <form className="enrollment-form" onSubmit={(event) => void save(event)}><div className="form-row"><label>Display name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="My ScreenConnect" /></label><label>Instance URL<input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required placeholder="https://support.example.com" /></label><label>Hosting type<select value={deploymentType} onChange={(e) => setDeploymentType(e.target.value as "cloud" | "self_hosted")}><option value="cloud">Hosted cloud</option><option value="self_hosted">Self-hosted</option></select></label><label>Exact version/build (if known)<input value={version} onChange={(e) => setVersion(e.target.value)} maxLength={80} placeholder="Enter if known" /></label></div><div className="form-foot"><span>Saved instances are visible only in this workspace.</span><button className="primary-button" disabled={busy}><BadgePlus size={15} />Save instance</button></div></form>
      {error && <div className="form-error"><AlertCircle size={16} />{error}</div>}
    </section>
    <section className="panel enrollment-policy-list"><div className="panel-heading"><div><h2>Configured instances</h2><p>Each row is a separate endpoint and credential reference.</p></div><span className="pending-count">{items.length}</span></div>
      {items.length ? <div className="table-scroll"><table className="device-table"><thead><tr><th>INSTANCE</th><th>TYPE / VERSION</th><th>CONNECTOR</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small className="table-subline">{item.baseUrl}</small></td><td>{item.deploymentType === "cloud" ? "Hosted cloud" : "Self-hosted"}<small className="table-subline">{item.version || "Version not recorded"}</small></td><td><StatusPill status="Awaiting adapter" /></td><td><button className="secondary-button" disabled={busy} onClick={() => void remove(item)}>Remove</button></td></tr>)}</tbody></table></div> : <div className="compact-empty"><strong>No ScreenConnect instances configured</strong><small>Add each authorized instance separately.</small></div>}
    </section>
  </>;
}

function OverviewPage({ onOpenDevices, onOpenEnrollment, showOwnerInstallers, csrfToken, health }: { onOpenDevices: () => void; onOpenEnrollment: () => void; showOwnerInstallers: boolean; csrfToken: string; health: Health | null }) {
  const [overview, setOverview] = useState<Overview | null>(null); const [devices, setDevices] = useState<Device[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const refresh = useCallback(async () => {
    try { setError(""); const [summary, list] = await Promise.all([request<Overview>("/api/overview"), request<{ items: Device[] }>("/api/devices?page=1&pageSize=6&sort=lastSeen&direction=desc")]); setOverview(summary); setDevices(list.items); setUpdatedAt(new Date()); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load monitoring data."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); const id = window.setInterval(refresh, 20000); return () => clearInterval(id); }, [refresh]);
  return <>
    <div className="page-heading"><div><div className="eyebrow">MONITORING</div><h1>Overview</h1><p>Operational status across your managed computers.</p></div><div className="heading-actions"><span className="updated-note">{updatedAt ? `Updated ${timeAgo(updatedAt.toISOString()).toLowerCase()}` : "Live data"}</span><button className="secondary-button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} />Refresh data</button></div></div>
    {error && <div className="inline-error"><AlertCircle size={17} /><span>{error}</span><button onClick={() => void refresh()}>Retry</button></div>}
    <section className="metric-grid" aria-label="Device status summary">
      <MetricCard label="Managed devices" value={overview?.totalDevices} icon={<Computer size={18} />} detail="Currently enrolled" loading={loading} />
      <MetricCard label="Online" value={overview?.onlineDevices} icon={<Wifi size={18} />} detail="Checked in within 2 min" tone="good" loading={loading} />
      <MetricCard label="Offline" value={overview?.offlineDevices} icon={<Clock3 size={18} />} detail="No recent check-in" tone="muted" loading={loading} />
      <MetricCard label="Revoked" value={overview?.revokedDevices} icon={<ShieldEllipsis size={18} />} detail="Access disabled" tone="warning" loading={loading} />
    </section>
    {showOwnerInstallers && <OwnerInstallerPanel csrfToken={csrfToken} onOpenEnrollment={onOpenEnrollment} />}
    <section className="overview-grid">
      <div className="panel performance-panel"><div className="panel-heading"><div><h2>Performance</h2><p>Average CPU and memory · last 24 hours</p></div><span className="range-label">LAST 24 HOURS</span></div>
        {loading ? <div className="chart-loading"><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /></div> : overview?.performance.length ? <PerformanceChart rows={overview.performance} /> : <div className="chart-empty"><div className="empty-icon"><Activity size={19} /></div><strong>No performance history yet</strong><span>Metrics will appear after an agent checks in and reports samples.</span></div>}
      </div>
      <div className="panel system-panel"><div className="panel-heading"><div><h2>System status</h2><p>Core service availability</p></div><span className={`system-live ${health?.status === "ok" ? "" : "unavailable"}`}><i />{health?.status === "ok" ? "Operational" : health ? "Degraded" : "Checking"}</span></div>
        <div className="system-row"><span className="system-icon"><Server size={16} /></span><span><strong>Management API</strong><small>Application service</small></span><span className={`service-status ${health?.status === "ok" ? "" : "unavailable"}`}><i />{health?.status === "ok" ? "Online" : "Unavailable"}</span></div>
        <div className="system-row"><span className="system-icon database-icon"><Command size={16} /></span><span><strong>Device database</strong><small>SQLite database</small></span><span className={`service-status ${health?.database === "connected" ? "" : "unavailable"}`}><i />{health?.database === "connected" ? "Connected" : "Unavailable"}</span></div>
        <div className="system-foot"><span>Last device check-in</span><strong>{overview?.lastCheckIn ? timeAgo(overview.lastCheckIn) : "No check-ins"}</strong></div>
      </div>
    </section>
    <section className="panel recent-panel"><div className="panel-heading recent-heading"><div><h2>Recently active devices</h2><p>Latest agent check-ins from your environment</p></div><button className="text-button" onClick={onOpenDevices}>View all devices <ChevronRight size={15} /></button></div>
      {loading ? <TableSkeleton /> : devices.length ? <DeviceTable devices={devices} onSelect={() => onOpenDevices()} compact /> : <EmptyDevices onOpenDevices={onOpenDevices} />}
    </section>
  </>;
}

function MetricCard({ label, value, icon, detail, tone = "", loading }: { label: string; value?: number; icon: ReactNode; detail: string; tone?: string; loading: boolean }) {
  return <div className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-icon ${tone}`}>{icon}</span></div><div className="metric-value">{loading ? <span className="value-skeleton" /> : (value ?? 0).toLocaleString()}</div><div className="metric-detail">{detail}</div></div>;
}

function PerformanceChart({ rows }: { rows: Overview["performance"] }) {
  const points = rows.slice(-24); const width = 640; const height = 180; const pad = 22;
  const make = (key: "cpu" | "memory") => points.map((r, i) => `${pad + i * (width - pad * 2) / Math.max(points.length - 1, 1)},${height - pad - (Math.max(0, Math.min(100, r[key] || 0)) * (height - pad * 2) / 100)}`).join(" ");
  const cpuAvg = Math.round(points.reduce((n, r) => n + (r.cpu || 0), 0) / points.length);
  const memAvg = Math.round(points.reduce((n, r) => n + (r.memory || 0), 0) / points.length);
  return <div className="chart-wrap"><div className="chart-legend"><span><i className="legend-cpu" />CPU <b>{cpuAvg}%</b></span><span><i className="legend-memory" />Memory <b>{memAvg}%</b></span></div><svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="CPU and memory average for actual agent samples">
    {[0, 25, 50, 75, 100].map((n) => { const y = height - pad - n * (height - pad * 2) / 100; return <g key={n}><line x1={pad} x2={width - pad} y1={y} y2={y} className="chart-gridline" /><text x="0" y={y + 3} className="chart-label">{n}%</text></g>; })}
    {points.length > 1 && <><polyline points={make("memory")} className="series-memory" /><polyline points={make("cpu")} className="series-cpu" /></>}
    {points.length === 1 && <circle cx={pad} cy={height - pad - (points[0].cpu || 0) * (height - pad * 2) / 100} r="4" className="chart-dot" />}
  </svg><div className="chart-axis"><span>{new Date(points[0].hour).toLocaleTimeString([], { hour: "numeric" })}</span><span>{new Date(points.at(-1)!.hour).toLocaleTimeString([], { hour: "numeric" })}</span></div></div>;
}

function TableSkeleton() { return <div className="table-skeleton" aria-label="Loading devices">{[0, 1, 2].map((n) => <div key={n}><i /><i /><i /><i /></div>)}</div>; }
function EmptyDevices({ onOpenDevices }: { onOpenDevices: () => void }) {
  return <div className="empty-devices"><div className="empty-device-mark"><Computer size={24} /></div><div><strong>No devices are reporting yet</strong><p>Devices appear here after an authorized RMM agent has enrolled and checked in.</p><button className="text-button" onClick={onOpenDevices}>Open device inventory <ChevronRight size={15} /></button></div></div>;
}

function DeviceTable({ devices, onSelect, compact = false }: { devices: Device[]; onSelect: (d: Device) => void; compact?: boolean }) {
  return <div className="table-scroll"><table className={`device-table ${compact ? "compact" : ""}`}><thead><tr><th>DEVICE</th><th>STATUS</th><th>OPERATING SYSTEM</th>{!compact && <th>IP ADDRESS</th>}<th>LAST CHECK-IN</th></tr></thead><tbody>{devices.map((d) => <tr key={d.id} onClick={() => onSelect(d)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(d)}>
    <td><div className="device-cell"><span className="device-glyph"><Computer size={16} /></span><span><strong>{d.name}</strong><small>{deviceLabel(d)}</small></span></div></td><td><StatusPill status={d.status} /></td><td><span className="os-cell">{d.operatingSystem || "Unknown OS"}{d.osVersion ? <small>{d.osVersion}</small> : null}</span></td>{!compact && <td className="ip-cell">{d.ipAddresses[0] || "—"}</td>}<td><span className="checkin-cell">{timeAgo(d.lastSeen)}<small>{shortDate(d.lastSeen)}</small></span></td>
  </tr>)}</tbody></table></div>;
}
function StatusPill({ status }: { status: string }) { const type = status.toLowerCase(); return <span className={`status-pill ${type}`}><i />{status}</span>; }

type EnrollmentPolicy = { id: string; name: string; maxDevices: number; expiresInHours: number; approvalMode: "automatic" | "approval"; allowedOperatingSystems: string[]; createdAt: string; revokedAt: string | null; activeGrants: number };
type EnrollmentGrant = { id: string; policyId: string; policyName: string; maxUses: number; usedCount: number; expiresAt: string; createdAt: string; revokedAt: string | null };
type InstallerPackage = { id: string; grantId: string; policyName: string; agentVersion: string; buildStatus: string; status: string; signingStatus: string | null; msiSha256: string | null; setupSha256: string | null; createdAt: string; expiresAt: string; maxUses: number; usedCount: number; revokedAt: string | null; buildError: string | null; generic?: number; msiSizeBytes?: number | null; exeSizeBytes?: number | null; downloads?: { page: string; msi: string; exe: string } };
function EnrollmentPage({ csrfToken, onNotice }: { csrfToken: string; onNotice: (message: string) => void }) {
  const [policies, setPolicies] = useState<EnrollmentPolicy[]>([]); const [grants, setGrants] = useState<EnrollmentGrant[]>([]); const [pending, setPending] = useState<{ id: string; name: string; operatingSystem: string; policyName: string; requestedAt: string }[]>([]);
  const [packages, setPackages] = useState<InstallerPackage[]>([]);
  const [name, setName] = useState("Windows fleet"); const [expiry, setExpiry] = useState("72"); const [approvalMode, setApprovalMode] = useState<"automatic" | "approval">("approval"); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const headers = { "Content-Type": "application/json", "x-csrf-token": csrfToken };
  const load = useCallback(async () => {
    try { const [p, g, r, i] = await Promise.all([request<{ items: EnrollmentPolicy[] }>("/api/enrollment/policies"), request<{ items: EnrollmentGrant[] }>("/api/enrollment/grants"), request<{ items: typeof pending }>("/api/enrollment/pending"), request<{ items: InstallerPackage[] }>("/api/installer-packages")]); setPolicies(p.items); setGrants(g.items); setPending(r.items); setPackages(i.items); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load enrollment settings."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => void load(), 8_000); return () => clearInterval(timer); }, [load]);
  const createPolicy = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await request("/api/enrollment/policies", { method: "POST", headers, body: JSON.stringify({ name, expiresInHours: Number(expiry), approvalMode, allowedOperatingSystems: ["Windows"] }) }); await load(); onNotice("Enrollment policy created."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not create enrollment policy."); }
    finally { setBusy(false); }
  };
  const issueAuthorization = async (policy: EnrollmentPolicy) => {
    setBusy(true); setError("");
    try {
      await request(`/api/enrollment/policies/${policy.id}/grants`, { method: "POST", headers, body: "{}" });
      await load(); onNotice("Enrollment authorization issued. Build its MSI and EXE installers from the dashboard.");
    }
    catch (e) { setError(e instanceof Error ? e.message : "Could not issue enrollment authorization."); await load(); }
    finally { setBusy(false); }
  };
  const downloadBuildConfig = async (grant: EnrollmentGrant) => {
    setBusy(true); setError("");
    try {
      const config = await request<Record<string, unknown>>(`/api/enrollment/grants/${grant.id}/installer-config`);
      const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = blobUrl; link.download = `family-rmm-${grant.id}-installer-config.json`;
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      onNotice("Build config downloaded. It contains a limited enrollment authorization; share it only with the package builder.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not download the installer build config."); }
    finally { setBusy(false); }
  };
  const retryInstaller = async (grantId: string) => {
    setBusy(true); setError("");
    try { const installer = await request<{ signingStatus: string; status?: string }>("/api/installer-packages", { method: "POST", headers, body: JSON.stringify({ grantId }) }); await load(); onNotice(installer.status === "building" ? "Build queued. MSI and EXE downloads will appear here when ready." : `MSI and EXE installers built (${installer.signingStatus}).`); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not start the installer build."); }
    finally { setBusy(false); }
  };
  const revoke = async (kind: "grants" | "policies", id: string) => {
    setBusy(true); setError("");
    try { await request(`/api/enrollment/${kind}/${id}/revoke`, { method: "POST", headers, body: "{}" }); await load(); onNotice(`${kind === "grants" ? "Enrollment authorization" : "Policy"} revoked.`); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not revoke enrollment access."); }
    finally { setBusy(false); }
  };
  const review = async (id: string, action: "approve" | "reject") => {
    setBusy(true); setError("");
    try { await request(`/api/enrollment/pending/${encodeURIComponent(id)}/${action}`, { method: "POST", headers, body: "{}" }); await load(); onNotice(`Enrollment request ${action === "approve" ? "approved" : "rejected"}.`); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not review enrollment request."); }
    finally { setBusy(false); }
  };
  return <>
    <div className="page-heading"><div><div className="eyebrow">ACCESS CONTROL</div><h1>Enrollment</h1><p>Set the rules for devices that may register with this RMM.</p></div></div>
    <div className="enrollment-callout"><span className="enrollment-callout-icon"><ShieldCheck size={18} /></span><div><strong>Website-built Windows installers</strong><p>Issue an authorization and start the build from Family RMM. The server builds the MSI and EXE from the Family RMM agent source; no separate worker command is required. Windows may show an unknown-publisher warning. Keep SmartScreen enabled and install only with the device owner’s authorization.</p></div><span className="integration-badge">WINDOWS · X64</span></div>
    {error && <div className="table-error"><AlertCircle size={16} /><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}
    <div className="enrollment-grid">
      <section className="panel enrollment-create"><div className="panel-heading"><div><h2>Enrollment policies</h2><p>Control authorization lifetime and review requirements.</p></div></div>
        <form className="enrollment-form" onSubmit={createPolicy}><label>Policy name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required /></label><label>Authorization expiry (hours)<input type="number" min="1" max="8760" value={expiry} onChange={(e) => setExpiry(e.target.value)} required /></label><label>New device approval<select value={approvalMode} onChange={(e) => setApprovalMode(e.target.value as "automatic" | "approval")}><option value="approval">Require administrator review</option><option value="automatic">Approve automatically</option></select></label><div className="form-foot"><span><ShieldCheck size={14} />Every device still needs administrator authorization.</span><button className="primary-button" disabled={busy}><BadgePlus size={15} />Create policy</button></div></form>
      </section>
      <section className="panel enrollment-pending"><div className="panel-heading"><div><h2>Pending approval</h2><p>New computers awaiting an administrator decision.</p></div><span className="pending-count">{pending.length}</span></div>{pending.length ? <div className="pending-list">{pending.map((item) => <div className="pending-item" key={item.id}><div><strong>{item.name}</strong><small>{item.operatingSystem} · {item.policyName}</small></div><span className="pending-actions"><button className="secondary-button" disabled={busy} onClick={() => void review(item.id, "reject")}>Reject</button><button className="primary-button" disabled={busy} onClick={() => void review(item.id, "approve")}>Approve</button></span></div>)}</div> : <div className="compact-empty"><span><ShieldCheck size={17} /></span><strong>No requests to review</strong><small>New installs appear here when policy review is required.</small></div>}</section>
    </div>
    <section className="panel enrollment-policy-list"><div className="panel-heading"><div><h2>Active policies</h2><p>Enrollment is unlimited. Policy expiry and approval decide who can join.</p></div></div>{policies.length ? <div className="table-scroll"><table className="device-table enrollment-table"><thead><tr><th>POLICY</th><th>DEVICE SLOTS</th><th>APPROVAL</th><th>ACTIVE GRANTS</th><th>CREATED</th><th /></tr></thead><tbody>{policies.map((policy) => <tr key={policy.id}><td><strong>{policy.name}</strong><small className="table-subline">Windows · expires in {policy.expiresInHours}h</small></td><td>Unlimited</td><td>{policy.approvalMode === "approval" ? "Administrator review" : "Automatic"}</td><td>{policy.activeGrants}</td><td>{shortDate(policy.createdAt)}</td><td>{policy.revokedAt ? <StatusPill status="Revoked" /> : <button className="secondary-button" disabled={busy} onClick={() => void issueAuthorization(policy)}><BadgePlus size={14} />Issue authorization</button>}</td></tr>)}</tbody></table></div> : <div className="compact-empty"><strong>No policies yet</strong><small>Create a policy to define enrollment rules.</small></div>}</section>
    <section className="panel enrollment-policy-list"><div className="panel-heading"><div><h2>Enrollment authorizations</h2><p>Revoking an authorization is separate from revoking a permanent installer package.</p></div></div>{grants.length ? <div className="table-scroll"><table className="device-table enrollment-table"><thead><tr><th>POLICY</th><th>DEVICES ENROLLED</th><th>EXPIRES</th><th>STATUS</th><th>AGENT DOWNLOADS</th><th /></tr></thead><tbody>{grants.map((grant) => { const grantPackage = packages.find((item) => item.grantId === grant.id); const grantActive = !grant.revokedAt && Date.parse(grant.expiresAt) > Date.now() && (grant.maxUses < 0 || grant.usedCount < grant.maxUses); return <tr key={grant.id}><td><strong>{grant.policyName}</strong><small className="table-subline">{grant.id.slice(0, 12)}…</small></td><td>{grant.usedCount} / {grant.maxUses < 0 ? "Unlimited" : grant.maxUses}</td><td>{shortDate(grant.expiresAt)}</td><td><StatusPill status={grant.revokedAt ? "Revoked" : Date.parse(grant.expiresAt) <= Date.now() ? "Expired" : "Active"} /></td><td className="package-downloads">{grantPackage?.status === "ready" && !grantPackage.revokedAt ? <><a className="secondary-button" href={`/api/installer-packages/${grantPackage.id}/msi`} download><Download size={14} />MSI</a><a className="secondary-button" href={`/api/installer-packages/${grantPackage.id}/exe`} download><Download size={14} />EXE</a></> : grantActive ? <button className="primary-button" disabled={busy || grantPackage?.status === "building"} onClick={() => void retryInstaller(grant.id)}><Download size={14} />{grantPackage?.status === "building" ? "Building installers…" : grantPackage?.status === "failed" ? "Retry installer build" : grantPackage?.revokedAt ? "Package revoked" : "Build MSI + EXE"}</button> : <span>Unavailable</span>}</td><td>{grantActive && <span className="package-actions"><button className="secondary-button" disabled={busy} onClick={() => void downloadBuildConfig(grant)}>Build config</button><button className="secondary-button" disabled={busy} onClick={() => void revoke("grants", grant.id)}>Revoke</button></span>}</td></tr>; })}</tbody></table></div> : <div className="compact-empty"><strong>No authorizations issued</strong><small>Create an enrollment authorization before building a customer installer.</small></div>}</section>
    <section className="panel enrollment-policy-list"><div className="panel-heading"><div><h2>Windows installer packages</h2><p>Generated MSI and EXE agent installers.</p></div></div>{packages.length ? <div className="table-scroll"><table className="device-table enrollment-table package-table"><thead><tr><th>VERSION / POLICY</th><th>CREATED</th><th>DEVICES</th><th>PACKAGE STATUS</th><th>SIGNING</th><th /></tr></thead><tbody>{packages.map((item) => <tr key={item.id}><td><strong>v{item.agentVersion}</strong><small className="table-subline">{item.generic ? "Reusable, approval-based installer" : item.policyName}</small></td><td>{shortDate(item.createdAt)}</td><td>{item.usedCount} / {item.maxUses < 0 ? "Unlimited" : item.maxUses}</td><td><StatusPill status={item.revokedAt ? "Revoked" : item.status === "ready" ? "Ready" : item.status === "failed" ? "Build failed" : item.status === "limit reached" ? "Limit reached" : item.status[0].toUpperCase() + item.status.slice(1)} />{item.buildError && <small className="package-build-error">{item.buildError}</small>}</td><td><span className={`signature-label ${item.signingStatus === "signed" ? "signed" : "unsigned"}`}>{item.signingStatus === "signed" ? "Signed" : item.signingStatus === "unsigned" ? "Unsigned · pilot" : "—"}</span></td><td>{item.status === "failed" && <button className="secondary-button" disabled={busy} onClick={() => void retryInstaller(item.grantId)}>Retry build</button>}</td></tr>)}</tbody></table></div> : <div className="compact-empty"><strong>No installers built yet</strong><small>Build the reusable Windows installer from Downloads.</small></div>}</section>
    <InstallerShareLinks packages={packages} csrfToken={csrfToken} onRefresh={load} onNotice={onNotice} />
  </>;
}

function InstallerShareLinks({ packages, csrfToken, onRefresh, onNotice }: { packages: InstallerPackage[]; csrfToken: string; onRefresh: () => Promise<void>; onNotice: (message: string) => void }) {
  const [links, setLinks] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const ready = packages.filter((item) => item.status === "ready");
  const create = async (installerId: string) => {
    setBusyId(installerId); setError("");
    try {
      const result = await request<{ url: string }>("/api/installer-packages/" + installerId + "/share", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: "{}",
      });
      setLinks((previous) => ({ ...previous, [installerId]: result.url }));
      try { await navigator.clipboard.writeText(result.url); } catch { /* The link remains available to copy manually. */ }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create the customer download link."); }
    finally { setBusyId(""); }
  };
  const revoke = async (installerId: string) => {
    setBusyId(installerId); setError("");
    try {
      await request(`/api/installer-packages/${installerId}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: "{}",
      });
      setLinks((previous) => { const next = { ...previous }; delete next[installerId]; return next; });
      await onRefresh();
      onNotice("Installer downloads and its enrollment authorization were revoked.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not revoke this installer package."); }
    finally { setBusyId(""); }
  };
  if (!ready.length) return null;
  return <section className="panel enrollment-policy-list"><div className="panel-heading"><div><h2>Permanent package links</h2><p>Enrollment authorization revocation alone does not remove a permanent link. Revoke the installer package here to block its downloads and revoke its associated authorization.</p></div><Share2 size={17} /></div>{error && <div className="form-error">{error}</div>}<div className="pending-list">{ready.map((item) => <div className="pending-item" key={item.id}><div><strong>{item.policyName} · v{item.agentVersion}</strong><small>Download permission does not approve enrollment; device approval remains required.</small>{links[item.id] && <input className="installer-share-url" aria-label="Customer installation link" readOnly value={links[item.id]} onFocus={(event) => event.currentTarget.select()} />}</div>{item.revokedAt ? <StatusPill status="Revoked" /> : <span className="package-actions"><button className="primary-button" disabled={Boolean(busyId)} onClick={() => void create(item.id)}>{busyId === item.id ? "Preparing…" : links[item.id] ? "Copy link again" : "Copy permanent link"}</button><button className="secondary-button" disabled={Boolean(busyId)} title="Blocks future downloads and revokes this package's enrollment authorization" onClick={() => void revoke(item.id)}>Revoke installer</button></span>}</div>)}</div></section>;
}

function WindowsDownloadsPage({ csrfToken, onNotice }: { csrfToken: string; onNotice: (message: string) => void }) {
  const [packages, setPackages] = useState<InstallerPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const autoBuildRequested = useRef(false);
  const load = useCallback(async () => {
    try {
      const result = await request<{ items: InstallerPackage[] }>("/api/installer-packages");
      setPackages(result.items.filter((item) => item.generic === 1)); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load Windows installers."); }
    finally { setLoading(false); }
  }, []);
  const build = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const result = await request<{ status: string }>("/api/installer-packages", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ generic: true }) });
      await load(); onNotice(result.status === "building" ? "Windows installer build queued." : "Windows MSI and EXE installers are ready.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not build the Windows installers."); }
    finally { setBusy(false); }
  }, [csrfToken, load, onNotice]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 8_000); return () => clearInterval(timer); }, [load]);
  useEffect(() => {
    if (loading || error || packages.some((item) => item.generic === 1) || autoBuildRequested.current) return;
    autoBuildRequested.current = true;
    void build();
  }, [loading, error, packages, build]);
  const latest = packages[0];
  const copy = async () => {
    if (!latest?.downloads) return;
    const link = window.location.origin + latest.downloads.page;
    try { await navigator.clipboard.writeText(link); onNotice("Permanent Windows installer link copied."); }
    catch { setError(`Copy this permanent link: ${link}`); }
  };
  const size = (bytes?: number | null) => bytes == null ? "Preparing file…" : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return <>
    <div className="page-heading"><div><div className="eyebrow">WINDOWS AGENT</div><h1>Downloads</h1><p>Download the Windows installer directly from Family RMM. Each new computer waits for your approval before it becomes manageable.</p></div></div>
    {error && <div className="table-error"><AlertCircle size={16} /><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}
    {latest?.status === "ready" ? <>
      <section className="panel enrollment-policy-list"><div className="panel-heading"><div><h2>Windows installers</h2><p>Agent v{latest.agentVersion} · generated {shortDate(latest.createdAt)}</p></div><StatusPill status={latest.signingStatus === "signed" ? "Signed" : "Unsigned pilot"} /></div>
        <div className="package-downloads"><a className="primary-button" href={latest.downloads?.msi}><Download size={15} />Download Windows MSI <span>{size(latest.msiSizeBytes)}</span></a><a className="secondary-button" href={latest.downloads?.exe}><Download size={15} />Download Windows EXE <span>{size(latest.exeSizeBytes)}</span></a><button className="secondary-button" onClick={() => void copy()}><Share2 size={15} />Copy permanent installer link</button><button className="secondary-button" disabled={busy} onClick={() => void build()}><Package size={15} />{busy ? "Building updated installers…" : "Build updated installers"}</button></div>
        <div className="enrollment-callout"><span className="enrollment-callout-icon"><ShieldCheck size={18} /></span><div><strong>Downloads do not authorize a computer</strong><p>The installer includes a signed, workspace-specific authorization so the device requests enrollment in the right workspace. It contains no administrator credentials or private signing key. The authorization only creates a pending request; approve the computer in Enrollment before it can report inventory or receive management jobs.</p></div></div>
      </section>
      <section className="panel enrollment-policy-list"><div className="panel-heading"><div><h2>Installation instructions</h2><p>No Python, command prompt, or manual server configuration is required.</p></div></div><ol className="download-instructions"><li>Open the permanent link and download the MSI or EXE.</li><li>Run the installer and approve the standard Windows administrator prompt.</li><li>The Family RMM Agent service starts automatically and submits a pending request.</li><li>In Family RMM, open <strong>Enrollment</strong> and approve the computer. Inventory and management begin after approval.</li></ol><p className="signature-label unsigned">Unsigned pilot package: Windows may show an unknown publisher warning. Keep SmartScreen enabled.</p></section>
    </> : <section className="panel owner-installer-panel"><div className="panel-heading"><div><h2>{loading ? "Loading Windows installers" : latest?.status === "building" || busy ? "Preparing your Windows installer" : "Preparing your Windows installer"}</h2><p>Family RMM builds the MSI and EXE from the Windows agent source. Download buttons appear here when the build finishes.</p></div><Download size={17} /></div>{latest?.buildError && <div className="form-error">{latest.buildError}</div>}<div className="package-actions"><button className="primary-button" disabled={busy || loading || latest?.status === "building"} onClick={() => void build()}><Package size={15} />{latest?.status === "failed" ? "Retry build" : "Build MSI + EXE"}</button></div><small>Installers are configured for this Family RMM HTTPS server and contain no enrollment secrets.</small></section>}
  </>;
}

function OwnerInstallerPanel({ csrfToken, onOpenEnrollment }: { csrfToken: string; onOpenEnrollment: () => void }) {
  const [grants, setGrants] = useState<EnrollmentGrant[]>([]); const [packages, setPackages] = useState<InstallerPackage[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { const [grantResult, packageResult] = await Promise.all([request<{ items: EnrollmentGrant[] }>("/api/enrollment/grants"), request<{ items: InstallerPackage[] }>("/api/installer-packages")]); setGrants(grantResult.items); setPackages(packageResult.items); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load your agent installers."); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 8_000); return () => clearInterval(timer); }, [load]);
  const grant = grants.find((item) => !item.revokedAt && Date.parse(item.expiresAt) > Date.now() && (item.maxUses < 0 || item.usedCount < item.maxUses));
  const installer = grant ? packages.find((item) => item.grantId === grant.id) : null;
  const build = async () => {
    if (!grant) return;
    setBusy(true); setError("");
    try { await request("/api/installer-packages", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ grantId: grant.id }) }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not queue your installer build."); }
    finally { setBusy(false); }
  };
  return <section className="panel owner-installer-panel"><div className="panel-heading"><div><h2>Your Family RMM agent</h2><p>Install the agent on computers in your own workspace.</p></div><Download size={17} /></div>
    {error && <div className="form-error"><AlertCircle size={16} />{error}</div>}
    {installer?.status === "ready" ? <div className="owner-installer-ready"><span><StatusPill status="Unsigned pilot" /><small>Install only on devices you own or are authorized to manage.</small></span><div className="package-downloads"><a className="secondary-button" href={`/api/installer-packages/${installer.id}/msi`} download><Download size={14} />Download MSI</a><a className="secondary-button" href={`/api/installer-packages/${installer.id}/exe`} download><Download size={14} />Download EXE</a></div></div>
      : installer?.status === "building" ? <div className="empty-devices"><div><strong>Your installer is being prepared</strong><p>The Family RMM server is building the MSI and EXE. Download buttons appear here when they’re ready.</p><button className="text-button" onClick={onOpenEnrollment}>Open installer status <ChevronRight size={15} /></button></div></div>
      : grant ? <div className="owner-installer-ready"><span><strong>{installer?.status === "failed" ? "The last build failed" : "No installer built for your workspace yet"}</strong><small>Build an MSI and EXE from the Family RMM agent source on the server.</small></span><div className="package-actions"><button className="primary-button" disabled={busy} onClick={() => void build()}><Download size={14} />{busy ? "Starting build…" : installer?.status === "failed" ? "Retry build" : "Build MSI + EXE"}</button><button className="secondary-button" onClick={onOpenEnrollment}>Enrollment settings</button></div></div>
      : <div className="empty-devices"><div><strong>Set up your first owner device</strong><p>Create an enrollment policy and authorization, then build an installer for your workspace.</p><button className="text-button" onClick={onOpenEnrollment}>Set up my installer <ChevronRight size={15} /></button></div></div>}
  </section>;
}

type AuditEvent = { id: number; action: string; targetId: string | null; detail: string | null; createdAt: string; actor: string | null };
function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]); const [query, setQuery] = useState(""); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const load = useCallback(async () => { setLoading(true); try { const response = await request<{ items: AuditEvent[] }>("/api/audit"); setEvents(response.items); setUpdatedAt(new Date()); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Could not load audit events."); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const filtered = events.filter((event) => [event.action, event.actor, event.targetId, event.detail].some((value) => String(value || "").toLowerCase().includes(query.trim().toLowerCase())));
  const label = (action: string) => action.split(".").map((word) => word.replaceAll("_", " ")).join(" · ");
  return <>
    <div className="page-heading"><div><div className="eyebrow">GOVERNANCE</div><h1>Audit log</h1><p>Recent administrator and device enrollment activity.</p></div><div className="heading-actions"><span className="updated-note">{updatedAt ? `Updated ${timeAgo(updatedAt.toISOString()).toLowerCase()}` : ""}</span><button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} />Refresh</button></div></div>
    <div className="inventory-summary"><div><span className="summary-icon"><ScrollText size={17} /></span><span><strong>{events.length.toLocaleString()}</strong><small>Recent events retained in this view</small></span></div><span className="inventory-summary-note">Newest activity first · up to 50 events</span></div>
    <section className="panel inventory-panel"><div className="inventory-toolbar"><div className="filter-search"><Search size={16} /><input aria-label="Search audit events" placeholder="Search action, administrator or target" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button className="clear-search" onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button>}</div></div>
      {error && <div className="table-error"><AlertCircle size={16} /><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}
      {loading ? <TableSkeleton /> : filtered.length ? <div className="table-scroll"><table className="device-table audit-table"><thead><tr><th>EVENT</th><th>ADMINISTRATOR</th><th>TARGET</th><th>TIME</th><th>DETAIL</th></tr></thead><tbody>{filtered.map((event) => <tr key={event.id}><td><span className="audit-action"><i />{label(event.action)}</span></td><td>{event.actor || "System"}</td><td className="audit-target">{event.targetId || "—"}</td><td><span className="checkin-cell">{timeAgo(event.createdAt)}<small>{shortDate(event.createdAt)}</small></span></td><td>{event.detail ? <details className="audit-detail"><summary>View</summary><pre>{(() => { try { return JSON.stringify(JSON.parse(event.detail!), null, 2); } catch { return event.detail; } })()}</pre></details> : "—"}</td></tr>)}</tbody></table></div> : <div className="inventory-empty"><div className="empty-device-mark"><ScrollText size={21} /></div><strong>{query ? "No matching events" : "No audit activity yet"}</strong><p>{query ? "Try a different search term." : "Administrator changes and enrollment events will be recorded here."}</p>{query && <button className="secondary-button" onClick={() => setQuery("")}>Clear search</button>}</div>}
      {!loading && filtered.length > 0 && <div className="table-footer"><span>Showing {filtered.length} of {events.length.toLocaleString()} recent events</span></div>}
    </section>
  </>;
}

function DevicesPage({ onNotice }: { onNotice: (s: string) => void }) {
  const [items, setItems] = useState<Device[]>([]); const [q, setQ] = useState(""); const [status, setStatus] = useState("all"); const [sort, setSort] = useState("name"); const [direction, setDirection] = useState("asc");
  const [total, setTotal] = useState(0); const [page, setPage] = useState(1); const [pageSize] = useState(25); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [selected, setSelected] = useState<Device | null>(null); const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const load = useCallback(async (showLoad = true) => {
    if (showLoad) setLoading(true);
    try { setError(""); const params = new URLSearchParams({ q, status, sort, direction, page: String(page), pageSize: String(pageSize) }); const value = await request<{ items: Device[]; total: number }>(`/api/devices?${params}`); setItems(value.items); setTotal(value.total); setUpdatedAt(new Date()); if (selected) setSelected(value.items.find((d) => d.id === selected.id) || null); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load devices."); }
    finally { setLoading(false); }
  }, [q, status, sort, direction, page, pageSize]);
  useEffect(() => { const t = window.setTimeout(() => void load(), q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  const exportCsv = async () => {
    try {
      const all: Device[] = [];
      let pageNum = 1;
      let totalRows = 0;
      do {
        const params = new URLSearchParams({ q, status, sort, direction, page: String(pageNum), pageSize: "100" });
        const result = await request<{ items: Device[]; total: number }>(`/api/devices?${params}`);
        all.push(...result.items);
        totalRows = result.total;
        pageNum++;
      } while (all.length < totalRows && all.length < 10000);
      const fields: (keyof Device)[] = ["name", "status", "operatingSystem", "osVersion", "architecture", "manufacturer", "model", "agentVersion", "lastSeen", "id"];
      const csv = [fields.join(","), ...all.map((d) => fields.map((f) => `"${String(d[f] ?? "").replaceAll('"', '""')}"`).join(","))].join("\r\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); a.download = "family-rmm-devices.csv"; a.click(); window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      onNotice(`Exported ${all.length.toLocaleString()} device${all.length === 1 ? "" : "s"}${all.length < totalRows ? ` (first ${all.length.toLocaleString()} of ${totalRows.toLocaleString()})` : ""}.`);
    } catch (e) { onNotice(e instanceof Error ? e.message : "Export failed."); }
  };
  const changeSort = (key: string) => { if (sort === key) setDirection(direction === "asc" ? "desc" : "asc"); else { setSort(key); setDirection("asc"); } setPage(1); };
  const sortIcon = (key: string) => sort !== key ? <ArrowUpDown size={13} /> : direction === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return <>
    <div className="page-heading"><div><div className="eyebrow">FLEET MANAGEMENT</div><h1>Devices</h1><p>Search and inspect enrolled computers reporting to this server.</p></div><div className="heading-actions"><span className="updated-note">{updatedAt ? `Updated ${timeAgo(updatedAt.toISOString()).toLowerCase()}` : ""}</span><button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} />Refresh</button></div></div>
    <div className="inventory-summary"><div><span className="summary-icon"><Computer size={17} /></span><span><strong>{total.toLocaleString()}</strong><small>{status === "all" ? "Total managed devices" : `${status[0].toUpperCase()}${status.slice(1)} devices`}</small></span></div><span className="inventory-summary-note"><span className="live-dot" />Inventory updates as agents check in</span></div>
    <section className="panel inventory-panel"><div className="inventory-toolbar"><div className="filter-search"><Search size={16} /><input aria-label="Search devices" placeholder="Search name, OS, model or IP" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />{q && <button className="clear-search" onClick={() => setQ("")} title="Clear search"><X size={14} /></button>}</div><div className="toolbar-actions"><label className="filter-select"><SlidersHorizontal size={15} /><select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="all">All statuses</option><option value="online">Online</option><option value="offline">Offline</option><option value="revoked">Revoked</option></select><ChevronDown size={13} /></label><button className="secondary-button export-button" onClick={() => void exportCsv()} disabled={!total}><Download size={15} />Export CSV</button></div></div>
      {error && <div className="table-error"><AlertCircle size={16} /><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}
      {loading ? <TableSkeleton /> : items.length ? <>
        <div className="table-scroll"><table className="device-table inventory-table"><thead><tr><th><button onClick={() => changeSort("name")}>DEVICE {sortIcon("name")}</button></th><th>STATUS</th><th><button onClick={() => changeSort("os")}>OPERATING SYSTEM {sortIcon("os")}</button></th><th>IP ADDRESS</th><th>AGENT</th><th><button onClick={() => changeSort("lastSeen")}>LAST CHECK-IN {sortIcon("lastSeen")}</button></th><th aria-label="Details" /></tr></thead><tbody>{items.map((d) => <tr key={d.id} onClick={() => setSelected(d)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setSelected(d)}>
          <td><div className="device-cell"><span className="device-glyph"><Computer size={16} /></span><span><strong>{d.name}</strong><small>{deviceLabel(d)}</small></span></div></td><td><StatusPill status={d.status} /></td><td><span className="os-cell">{d.operatingSystem || "Unknown OS"}<small>{d.osVersion || d.architecture || "Version not reported"}</small></span></td><td className="ip-cell">{d.ipAddresses[0] || "—"}</td><td className="agent-version">{d.agentVersion || "—"}</td><td><span className="checkin-cell">{timeAgo(d.lastSeen)}<small>{shortDate(d.lastSeen)}</small></span></td><td><ChevronRight size={16} className="row-chevron" /></td>
        </tr>)}</tbody></table></div>
        <div className="table-footer"><span>Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total.toLocaleString()} devices</span><div className="pager"><button className="icon-button" onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} aria-label="Previous page"><ChevronLeft size={16} /></button><span>Page {page} of {pageCount}</span><button className="icon-button" onClick={() => setPage(Math.min(pageCount, page + 1))} disabled={page >= pageCount} aria-label="Next page"><ChevronRight size={16} /></button></div></div>
      </> : <div className="inventory-empty"><div className="empty-device-mark"><Search size={21} /></div><strong>{q || status !== "all" ? "No matching devices" : "No devices enrolled"}</strong><p>{q || status !== "all" ? "Try adjusting the search or status filter." : "When an authorized agent enrolls and checks in, its real device data will appear here."}</p>{(q || status !== "all") && <button className="secondary-button" onClick={() => { setQ(""); setStatus("all"); }}>Clear filters</button>}</div>}
    </section>
    {selected && <DeviceDrawer device={selected} onClose={() => setSelected(null)} />}
  </>;
}

function DeviceDrawer({ device, onClose }: { device: Device; onClose: () => void }) {
  const [details, setDetails] = useState<Device | null>(null); const [software, setSoftware] = useState<{ name: string; version: string | null; publisher: string | null; installedAt: string | null }[]>([]); const [error, setError] = useState("");
  useEffect(() => { let live = true; request<{ device: Device; software: typeof software }>(`/api/devices/${encodeURIComponent(device.id)}`).then((r) => { if (live) { setDetails(r.device); setSoftware(r.software); } }).catch((e) => { if (live) setError(e.message); }); return () => { live = false; }; }, [device.id]);
  useEffect(() => { const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);
  const d = details || device;
  return <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><aside className="device-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><div className="drawer-top"><div><span className="eyebrow">DEVICE DETAILS</span><button className="drawer-close icon-button" onClick={onClose} aria-label="Close device details"><X size={18} /></button></div><div className="drawer-device-title"><span className="drawer-device-icon"><Computer size={21} /></span><div><h2 id="drawer-title">{d.name}</h2><p>{deviceLabel(d)}</p></div></div><StatusPill status={d.status} /></div>
    {error && <div className="table-error"><AlertCircle size={15} />{error}</div>}
    <div className="drawer-section"><h3>System</h3><DetailRow label="Operating system" value={[d.operatingSystem, d.osVersion].filter(Boolean).join(" ") || "Not reported"} /><DetailRow label="Architecture" value={d.architecture || "Not reported"} /><DetailRow label="Processor" value={d.cpu || "Not reported"} /><DetailRow label="Memory" value={d.totalMemoryMB ? `${(d.totalMemoryMB / 1024).toFixed(1)} GB` : "Not reported"} /><DetailRow label="IP addresses" value={d.ipAddresses.join(", ") || "Not reported"} /><DetailRow label="Agent version" value={d.agentVersion || "Not reported"} /></div>
    <div className="drawer-section"><h3>Connection</h3><DetailRow label="Last check-in" value={shortDate(d.lastSeen)} /><DetailRow label="Software inventory" value={shortDate(d.softwareInventoryAt || null)} /><DetailRow label="Enrolled" value={shortDate(d.enrolledAt)} /></div>
    <div className="drawer-section"><div className="drawer-section-heading"><h3>Installed software</h3><span>{software.length}</span></div>{software.length ? <div className="software-list">{software.map((s) => <div key={`${s.name}-${s.version}`}><strong>{s.name}</strong><small>{s.version || "Version not reported"}{s.publisher ? ` · ${s.publisher}` : ""}</small></div>)}</div> : <p className="drawer-muted">{error ? "Software inventory unavailable." : "No software inventory has been reported."}</p>}</div>
    <div className="drawer-foot"><span><ShieldCheck size={14} />Information reported by the agent</span></div>
  </aside></div>;
}
function DetailRow({ label, value }: { label: string; value: string }) { return <div className="detail-row"><span>{label}</span><strong>{value}</strong></div>; }
