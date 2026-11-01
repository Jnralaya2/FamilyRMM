import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiPort = process.env.RMM_PORT || "3001";
const dashboardPort = process.env.RMM_DASHBOARD_PORT || "5173";
const server = spawn(process.execPath, ["src/server/index.mjs"], {
  cwd: root,
  env: { ...process.env, RMM_DEV_API_ONLY: "1", RMM_HOST: "127.0.0.1", RMM_PORT: apiPort },
  stdio: "inherit",
});
const viteCli = path.join(root, "node_modules", "vite", "bin", "vite.js");
const vite = spawn(process.execPath, [viteCli, "--host", "127.0.0.1", "--port", dashboardPort, "--strictPort"], {
  cwd: root,
  env: { ...process.env, RMM_DEV_API_PORT: apiPort },
  stdio: "inherit",
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [server, vite]) if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
}

server.on("exit", (code) => { if (!stopping) stop(code || 0); });
vite.on("exit", (code) => { if (!stopping) stop(code || 0); });
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

console.log(`\nRMM dashboard: http://127.0.0.1:${dashboardPort}`);
