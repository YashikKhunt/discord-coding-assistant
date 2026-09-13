import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4000";

// Dev: the UI runs on :3000 and proxies /api and /auth to the API, so cookies and the OAuth
// redirect stay on one origin. Production: the API serves the built files itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": { target: api },
      "/auth": { target: api },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
