import { defineConfig } from "vite";

const apiPort = process.env.RMM_DEV_API_PORT || process.env.RMM_PORT || "3001";
const dashboardPort = Number(process.env.RMM_DASHBOARD_PORT || "5173");

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: dashboardPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
