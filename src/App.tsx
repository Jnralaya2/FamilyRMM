import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Activity, AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, BadgePlus, ChevronDown,
  ChevronLeft, ChevronRight, CircleHelp, Clock3, Command, Computer,
  Download, LayoutDashboard, LoaderCircle, LogOut, MonitorCheck, RefreshCw,
  Search, Server, ShieldCheck, ShieldEllipsis, SlidersHorizontal, Wifi,
  X,
} from "lucide-react";

type AuthInfo = { setupRequired: boolean; authenticated: boolean; administrator: { id: string; email: string; role: string } | null; csrfToken: string | null };
type Device = { id: string; name: string; operatingSystem: string | null; osVersion: string | null; architecture: string | null; manufacturer: string | null; model: string | null; cpu: string | null; cpuCores: number | null; totalMemoryMB: number | null; ipAddresses: string[]; agentVersion: string | null; lastSeen: string | null; enrolledAt: string; status: string; cpuUsagePercent?: number | null; memoryUsagePercent?: number | null };
type Overview = { totalDevices: number; onlineDevices: number; offlineDevices: number; revokedDevices: number; lastCheckIn: string | null; performance: { hour: string; cpu: number | null; memory: number | null }[] };
type Page = "overview" | "devices" | "enrollment";
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
  if (!auth.authenticated) return <AuthScreen setupRequired={auth.setupRequired} onSuccess={refreshAuth} />;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Activity size={19} strokeWidth={2.5} /></div><div><div className="brand-name">family<span>rmm</span></div><div className="brand-caption">OPERATIONS CONSOLE</div></div></div>
      <div className="workspace-label">WORKSPACE</div>
      <div className="workspace-select"><div className="workspace-avatar">F</div><span><strong>Family Systems</strong><small>Single workspace</small></span></div>
      <div className="nav-label">MONITORING</div>
      <nav className="main-nav" aria-label="Main navigation">
        <button aria-label="Overview" className={`nav-item ${page === "overview" ? "selected" : ""}`} onClick={() => setPage("overview")}><LayoutDashboard size={17} /><span>Overview</span></button>
        <button aria-label="Devices" className={`nav-item ${page === "devices" ? "selected" : ""}`} onClick={() => setPage("devices")}><Computer size={17} /><span>Devices</span></button>
        <button aria-label="Enrollment" className={`nav-item ${page === "enrollment" ? "selected" : ""}`} onClick={() => setPage("enrollment")}><BadgePlus size={17} /><span>Enrollment</span></button>
      </nav>
      <div className="sidebar-bottom">
        <div className="connection-card"><div className={`connection-dot ${health}`} /><span><strong>{health === "ok" ? "Server connected" : health === "error" ? "Connection issue" : "Connecting"}</strong><small>{health === "ok" ? "Local environment" : "Checking service"}</small></span><Wifi size={15} /></div>
        <button className="profile" onClick={onLogout} title="Sign out"><div className="profile-avatar">{auth.administrator?.email.slice(0, 1).toUpperCase()}</div><span><strong>{auth.administrator?.email}</strong><small>Owner account</small></span><LogOut size={16} /></button>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <div className="breadcrumbs"><span>Family Systems</span><span className="crumb-sep">/</span><strong>{page === "overview" ? "Overview" : page === "devices" ? "Devices" : "Enrollment"}</strong></div>
        <div className="topbar-actions"><span className="environment-tag"><span />LOCAL ENVIRONMENT</span><button className="icon-button" title="Help" onClick={() => setHelpOpen(true)}><CircleHelp size={17} /></button><span className="top-avatar" aria-label="Current administrator">{auth.administrator?.email.slice(0, 1).toUpperCase()}</span></div>
      </header>
      <div className="page-content">
        {page === "overview" ? <OverviewPage onOpenDevices={() => setPage("devices")} health={healthInfo} /> : page === "devices" ? <DevicesPage onNotice={showToast} /> : <EnrollmentPage csrfToken={auth.csrfToken || ""} onNotice={showToast} />}
      </div>
    </main>
    {toast && <div className="toast" role="status"><ShieldCheck size={16} />{toast}</div>}
    {helpOpen && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setHelpOpen(false)}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><button className="icon-button modal-close" onClick={() => setHelpOpen(false)} aria-label="Close help"><X size={18} /></button><div className="empty-icon"><CircleHelp size={19} /></div><h2 id="help-title">Operations console</h2><p>This first release includes the live Overview and Devices inventory, backed by the local RMM API and database.</p><div className="help-note"><ShieldCheck size={16} /><span>Only real agent check-ins appear here. No sample devices are inserted.</span></div><button className="primary-button" onClick={() => setHelpOpen(false)}>Close</button></section></div>}
  </div>;
}

function AuthScreen({ setupRequired, onSuccess }: { setupRequired: boolean; onSuccess: () => Promise<void> }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (setupRequired) await request("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json", "x-setup-token": setupToken }, body: JSON.stringify({ email, password }) });
      else await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      await onSuccess();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to continue."); }
    finally { setBusy(false); }
  };
  return <div className="auth-screen"><div className="auth-panel"><div className="brand auth-brand"><div className="brand-mark"><Activity size={19} strokeWidth={2.5} /></div><div><div className="brand-name">family<span>rmm</span></div><div className="brand-caption">OPERATIONS CONSOLE</div></div></div>
    <div className="auth-copy"><p className="eyebrow">SECURE DEVICE OPERATIONS</p><h1>{setupRequired ? "Set up your workspace" : "Welcome back"}</h1><p>{setupRequired ? "Create the owner account for this RMM instance." : "Sign in to continue to your device operations console."}</p></div>
    <form className="auth-form" onSubmit={submit}>
      {setupRequired && <label>One-time setup token<input value={setupToken} onChange={(e) => setSetupToken(e.target.value)} autoComplete="off" required placeholder="Copy from the local server terminal" /><small>The token is printed once when the server starts for first-time setup.</small></label>}
      <label>Email address<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required placeholder="you@company.com" /></label>
      <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setupRequired ? "new-password" : "current-password"} required minLength={setupRequired ? 12 : 1} placeholder={setupRequired ? "At least 12 characters" : "Enter your password"} /></label>
      {error && <div className="form-error"><AlertCircle size={16} />{error}</div>}
      <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : null}{setupRequired ? "Create owner account" : "Sign in"}</button>
    </form><div className="auth-foot"><ShieldCheck size={15} />Protected administrator access</div>
  </div><div className="auth-side"><div className="auth-side-top">FAMILY SYSTEMS <span>RMM</span></div><div className="auth-art"><div className="art-ring ring-one" /><div className="art-ring ring-two" /><div className="art-core"><Server size={36} /></div><div className="art-node node-a"><MonitorCheck size={18} /></div><div className="art-node node-b"><ShieldCheck size={18} /></div><div className="art-node node-c"><Activity size={18} /></div></div><div className="auth-side-copy"><h2>Visibility across your<br />managed environment.</h2><p>A secure operations workspace for computers you are authorized to administer.</p></div><div className="auth-side-foot">SECURE BY DESIGN <span>•</span> SELF-HOSTED CONTROL</div></div></div>;
}

function OverviewPage({ onOpenDevices, health }: { onOpenDevices: () => void; health: Health | null }) {
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
    <section className="overview-grid">
      <div className="panel performance-panel"><div className="panel-heading"><div><h2>Performance</h2><p>Average CPU and memory · last 24 hours</p></div><span className="range-label">LAST 24 HOURS</span></div>
        {loading ? <div className="chart-loading"><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /></div> : overview?.performance.length ? <PerformanceChart rows={overview.performance} /> : <div className="chart-empty"><div className="empty-icon"><Activity size={19} /></div><strong>No performance history yet</strong><span>Metrics will appear after an agent checks in and reports samples.</span></div>}
      </div>
      <div className="panel system-panel"><div className="panel-heading"><div><h2>System status</h2><p>Core service availability</p></div><span className={`system-live ${health?.status === "ok" ? "" : "unavailable"}`}><i />{health?.status === "ok" ? "Operational" : health ? "Degraded" : "Checking"}</span></div>
        <div className="system-row"><span className="system-icon"><Server size={16} /></span><span><strong>Management API</strong><small>Local application service</small></span><span className={`service-status ${health?.status === "ok" ? "" : "unavailable"}`}><i />{health?.status === "ok" ? "Online" : "Unavailable"}</span></div>
        <div className="system-row"><span className="system-icon database-icon"><Command size={16} /></span><span><strong>Device database</strong><small>SQLite · development</small></span><span className={`service-status ${health?.database === "connected" ? "" : "unavailable"}`}><i />{health?.database === "connected" ? "Connected" : "Unavailable"}</span></div>
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
function EnrollmentPage({ csrfToken, onNotice }: { csrfToken: string; onNotice: (message: string) => void }) {
  const [policies, setPolicies] = useState<EnrollmentPolicy[]>([]); const [grants, setGrants] = useState<EnrollmentGrant[]>([]); const [pending, setPending] = useState<{ id: string; name: string; operatingSystem: string; policyName: string; requestedAt: string }[]>([]);
  const [name, setName] = useState("Windows fleet"); const [limit, setLimit] = useState("25"); const [expiry, setExpiry] = useState("72"); const [approvalMode, setApprovalMode] = useState<"automatic" | "approval">("approval"); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const headers = { "Content-Type": "application/json", "x-csrf-token": csrfToken };
  const load = useCallback(async () => {
    try { const [p, g, r] = await Promise.all([request<{ items: EnrollmentPolicy[] }>("/api/enrollment/policies"), request<{ items: EnrollmentGrant[] }>("/api/enrollment/grants"), request<{ items: typeof pending }>("/api/enrollment/pending")]); setPolicies(p.items); setGrants(g.items); setPending(r.items); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load enrollment settings."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const createPolicy = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await request("/api/enrollment/policies", { method: "POST", headers, body: JSON.stringify({ name, maxDevices: Number(limit), expiresInHours: Number(expiry), approvalMode, allowedOperatingSystems: ["Windows"] }) }); await load(); onNotice("Enrollment policy created."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not create enrollment policy."); }
    finally { setBusy(false); }
  };
  const issueGrant = async (policy: EnrollmentPolicy) => {
    setBusy(true); setError("");
    try { await request(`/api/enrollment/policies/${policy.id}/grants`, { method: "POST", headers, body: "{}" }); await load(); onNotice(`Enrollment authorization issued for ${policy.name}.`); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not issue enrollment authorization."); }
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
    <div className="enrollment-callout"><span className="enrollment-callout-icon"><ShieldCheck size={18} /></span><div><strong>Windows MSI distribution is not ready yet</strong><p>Policy authorization is active. Downloadable installers will appear after the agent and signed MSI pipeline are built and verified.</p></div><span className="integration-badge">PACKAGING IN PROGRESS</span></div>
    {error && <div className="table-error"><AlertCircle size={16} /><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}
    <div className="enrollment-grid">
      <section className="panel enrollment-create"><div className="panel-heading"><div><h2>Enrollment policies</h2><p>Control authorization lifetime and review requirements.</p></div></div>
        <form className="enrollment-form" onSubmit={createPolicy}><label>Policy name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required /></label><div className="form-row"><label>Device limit<input type="number" min="1" max="10000" value={limit} onChange={(e) => setLimit(e.target.value)} required /></label><label>Authorization expiry (hours)<input type="number" min="1" max="8760" value={expiry} onChange={(e) => setExpiry(e.target.value)} required /></label></div><label>New device approval<select value={approvalMode} onChange={(e) => setApprovalMode(e.target.value as "automatic" | "approval")}><option value="approval">Require administrator review</option><option value="automatic">Approve automatically</option></select></label><div className="form-foot"><span><ShieldCheck size={14} />Signed authorizations are limited and revocable.</span><button className="primary-button" disabled={busy}><BadgePlus size={15} />Create policy</button></div></form>
      </section>
      <section className="panel enrollment-pending"><div className="panel-heading"><div><h2>Pending approval</h2><p>New computers awaiting an administrator decision.</p></div><span className="pending-count">{pending.length}</span></div>{pending.length ? <div className="pending-list">{pending.map((item) => <div className="pending-item" key={item.id}><div><strong>{item.name}</strong><small>{item.operatingSystem} · {item.policyName}</small></div><span className="pending-actions"><button className="secondary-button" disabled={busy} onClick={() => void review(item.id, "reject")}>Reject</button><button className="primary-button" disabled={busy} onClick={() => void review(item.id, "approve")}>Approve</button></span></div>)}</div> : <div className="compact-empty"><span><ShieldCheck size={17} /></span><strong>No requests to review</strong><small>New installs appear here when policy review is required.</small></div>}</section>
    </div>
    <section className="panel enrollment-policy-list"><div className="panel-heading"><div><h2>Active policies</h2><p>Each issued authorization is signed by this server and limited by device count and expiry.</p></div></div>{policies.length ? <div className="table-scroll"><table className="device-table enrollment-table"><thead><tr><th>POLICY</th><th>DEVICE LIMIT</th><th>APPROVAL</th><th>ACTIVE GRANTS</th><th>CREATED</th><th /></tr></thead><tbody>{policies.map((policy) => <tr key={policy.id}><td><strong>{policy.name}</strong><small className="table-subline">Windows · expires in {policy.expiresInHours}h</small></td><td>{policy.maxDevices.toLocaleString()}</td><td>{policy.approvalMode === "approval" ? "Administrator review" : "Automatic"}</td><td>{policy.activeGrants}</td><td>{shortDate(policy.createdAt)}</td><td>{policy.revokedAt ? <StatusPill status="Revoked" /> : <button className="secondary-button" disabled={busy} onClick={() => void issueGrant(policy)}>Issue authorization</button>}</td></tr>)}</tbody></table></div> : <div className="compact-empty"><strong>No policies yet</strong><small>Create a policy to define enrollment rules.</small></div>}</section>
    <section className="panel enrollment-policy-list"><div className="panel-heading"><div><h2>Enrollment authorizations</h2><p>Track per-policy package grants and revoke compromised authorizations.</p></div></div>{grants.length ? <div className="table-scroll"><table className="device-table enrollment-table"><thead><tr><th>POLICY</th><th>DEVICES USED</th><th>EXPIRES</th><th>CREATED</th><th>STATUS</th><th /></tr></thead><tbody>{grants.map((grant) => <tr key={grant.id}><td><strong>{grant.policyName}</strong><small className="table-subline">{grant.id.slice(0, 12)}…</small></td><td>{grant.usedCount} / {grant.maxUses}</td><td>{shortDate(grant.expiresAt)}</td><td>{shortDate(grant.createdAt)}</td><td><StatusPill status={grant.revokedAt ? "Revoked" : Date.parse(grant.expiresAt) <= Date.now() ? "Expired" : "Active"} /></td><td>{!grant.revokedAt && Date.parse(grant.expiresAt) > Date.now() && <button className="secondary-button" disabled={busy} onClick={() => void revoke("grants", grant.id)}>Revoke</button>}</td></tr>)}</tbody></table></div> : <div className="compact-empty"><strong>No authorizations issued</strong><small>Issue one from an active policy.</small></div>}</section>
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
    <div className="drawer-section"><h3>Connection</h3><DetailRow label="Last check-in" value={shortDate(d.lastSeen)} /><DetailRow label="Enrolled" value={shortDate(d.enrolledAt)} /></div>
    <div className="drawer-section"><div className="drawer-section-heading"><h3>Installed software</h3><span>{software.length}</span></div>{software.length ? <div className="software-list">{software.map((s) => <div key={`${s.name}-${s.version}`}><strong>{s.name}</strong><small>{s.version || "Version not reported"}{s.publisher ? ` · ${s.publisher}` : ""}</small></div>)}</div> : <p className="drawer-muted">{error ? "Software inventory unavailable." : "No software inventory has been reported."}</p>}</div>
    <div className="drawer-foot"><span><ShieldCheck size={14} />Information reported by the agent</span></div>
  </aside></div>;
}
function DetailRow({ label, value }: { label: string; value: string }) { return <div className="detail-row"><span>{label}</span><strong>{value}</strong></div>; }
