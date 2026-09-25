import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: `npm run dev` proxies /api to a server started with
//   node ../server/main.ts --port 4391 --no-open --api-only --sim
// Shipped: the build is static and server/main.ts hands it out.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { proxy: { "/api": { target: "http://127.0.0.1:4391", changeOrigin: false } } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1400, target: "es2022" },
});
