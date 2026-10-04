import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@shared": path.resolve(here, "../shared"), "@": path.resolve(here, "src") } },
  server: {
    port: 5177,
    proxy: { "/api": { target: "http://127.0.0.1:5178", changeOrigin: true } },
  },
  build: { outDir: path.resolve(here, "dist"), emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
